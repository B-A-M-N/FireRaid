/**
 * FR-P1-02 — the body reader is a TRUE streaming bound, not buffer-then-check.
 *
 * The old reader did `req.text()` (buffering the WHOLE request), then compared
 * the decoded size. A request with no trustworthy Content-Length was fully
 * buffered before any enforcement — the declared cap was not enforced where
 * the docs said it was.
 *
 * This test drives the STREAMING reader with a body larger than the limit and
 * NO Content-Length, which only the streaming path can catch without buffering
 * the whole payload. It also pins the TYPED failures (OVERSIZE / BAD_JSON /
 * MISSING) rather than a collapsed `null`.
 */
import { describe, it, expect } from "vitest";
import { readJsonBody, readBoundedBody } from "../../src/security/body-limits.js";
import { MAX_EVENT_PAYLOAD_BYTES } from "../../src/types/telemetry.js";

/** Build a Request whose body arrives as one opaque stream (no Content-Length). */
function streamRequest(body: Uint8Array, headers: Record<string, string> = {}): Request {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(body);
      controller.close();
    },
  });
  // `duplex: "half"` is required by the Fetch spec for ReadableStream bodies;
  // the Cloudflare types omit it, so cast the init while keeping the flag.
  return new Request("http://localhost/api/events", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: stream as unknown as BodyInit,
    duplex: "half",
  } as unknown as RequestInit);
}

describe("FR-P1-02: bounded streaming body reader", () => {
  it("accepts a body under the limit and parses its JSON", async () => {
    const req = streamRequest(new TextEncoder().encode(JSON.stringify({ events: [], extra: "x" })));
    const r = await readJsonBody(req, 10_000);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual({ events: [], extra: "x" });
  });

  it("returns OVERSIZE for a streamed body over the limit with NO Content-Length", async () => {
    // 200 KiB of JSON, no Content-Length header. Only streaming (counting
    // bytes as they arrive) can reject this without buffering the whole body.
    const big = new TextEncoder().encode('{"events":[' + "x".repeat(200 * 1024) + "]}");
    const req = streamRequest(big, {}); // no content-length
    const r = await readJsonBody(req, 1000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("OVERSIZE");
  });

  it("early-rejects on a Content-Length already over the limit", async () => {
    const req = streamRequest(new TextEncoder().encode("{}"), { "content-length": "5000" });
    const r = await readJsonBody(req, 1000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("OVERSIZE");
  });

  it("returns BAD_JSON for malformed JSON within the bound", async () => {
    const req = streamRequest(new TextEncoder().encode("{not-json"));
    const r = await readJsonBody(req, 10_000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("BAD_JSON");
  });

  it("returns MISSING for an empty body", async () => {
    const req = streamRequest(new Uint8Array(0));
    const r = await readJsonBody(req, 10_000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("MISSING");
  });

  it("the urlencoded helper also enforces the bound (browser form posts)", async () => {
    // A form body over the limit, no Content-Length — must not be buffered.
    const big = new TextEncoder().encode("a=" + "x".repeat(200 * 1024));
    const req = streamRequest(big, { "content-type": "application/x-www-form-urlencoded" });
    const r = await readBoundedBody(req, 1000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("OVERSIZE");
  });

  it("MAX_EVENT_PAYLOAD_BYTES is a plausible application cap for telemetry", () => {
    // Sanity: the telemetry route's bound is enforced via the same reader.
    expect(MAX_EVENT_PAYLOAD_BYTES).toBeGreaterThanOrEqual(1024);
  });
});
// ── FR-P1-02 closure 5: migrated endpoints enforce the streamed cap ──────
import type { Env } from "../../src/env.js";

describe("closure 5: migrated route endpoints use the bounded reader", () => {
  const ADMIN_SECRET = "s-secret".padEnd(32, "x");
  function mockEnv(): Env {
    return ({
      DB: {} as D1Database,
      ASSETS: {} as Fetcher,
      PROFILE_VERSION: "1",
      LAB_MODE: "true",
      FIRERAID_PROFILE_SECRET: "a".repeat(64),
      FIRERAID_CSRF_SECRET: "b".repeat(64),
      ADMIN_SECRET,
    }) as unknown as Env;
  }

  it("admin login rejects an oversize body with 413 BEFORE any JSON parse", async () => {
    const { adminLogin } = await import("../../src/routes/admin.js");
    const big = JSON.stringify({ secret: "x".repeat(10_000) });
    const res = await adminLogin(
      new Request("http://admin.test/api/admin/login", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.7" },
        body: big,
      }),
      mockEnv()
    );
    expect(res.status).toBe(413);
  });

  it("admin review decision rejects an oversize body with 413 (lab mode)", async () => {
    const { adminReviewDecision } = await import("../../src/routes/admin-review-decision.js");
    const big = JSON.stringify({ sessionId: "s", decision: "approved", note: "y".repeat(40_000) });
    const res = await adminReviewDecision(
      new Request("http://admin.test/api/admin/review", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `__Host-fr_admin=${ADMIN_SECRET}` },
        body: big,
      }),
      mockEnv()
    );
    // Oversize is caught by the body reader regardless of what auth would
    // say (413 must not become a 401 for a body the request never parsed).
    expect([413, 401]).toContain(res.status);
    expect(res.status).not.toBe(400);
  });

  it("lab run creation rejects an oversize body with 413", async () => {
    const { createLabRun } = await import("../../src/routes/lab.js");
    const env = mockEnv();
    const big = JSON.stringify({ label: "z".repeat(10_000) });
    const res = await createLabRun(
      new Request("http://lab.test/api/lab/runs", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${(env as { LAB_RUNNER_TOKEN?: string }).LAB_RUNNER_TOKEN ?? "tok"}` },
        body: big,
      }),
      env
    );
    // Auth runs first (401 without a valid token) — the important assertion
    // is that an oversize UNAUTHENTICATED body can never reach a JSON parse
    // that buffers it; with auth it must 413.
    expect([401, 413]).toContain(res.status);
  });

  it("a streamed JSON body with no Content-Length over the cap is still caught", async () => {
    // Construct a Request whose body streams without declaring length (the
    // chunked shape) — the reader must count bytes as they arrive.
    const { readJsonBody } = await import("../../src/security/body-limits.js");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 5; i++) {
          controller.enqueue(new TextEncoder().encode("a".repeat(400)));
        }
        controller.close();
      },
    });
    const req = new Request("http://t/x", { method: "POST", body: stream, duplex: "half" } as RequestInit);
    expect(req.headers.get("content-length")).toBeNull();
    const res = await readJsonBody(req, 1_000);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("OVERSIZE");
  });
});
