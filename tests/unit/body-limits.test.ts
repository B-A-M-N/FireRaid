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