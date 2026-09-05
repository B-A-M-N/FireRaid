/**
 * P0-8 — the enforcement failure taxonomy drives the receipt policy.
 *
 * The reference adapter classifies real HTTP outcomes:
 *   2xx → created; 408/425/429/5xx → transport-failure; other 4xx →
 *   business-rejected; timeout/network error → transport-failure.
 *
 * And the middleware's receipt policy (FR-INV-008): a success receipt
 * leaves the building ONLY when the application is durably somewhere —
 * created upstream or queued-for-retry by the host. A bare transport
 * failure yields kind "forward-failed" (the Node runtime projects it as
 * a retryable 502, never the neutral 200 receipt).
 */
import { describe, it, expect } from "vitest";
import { ReferenceEnforcementAdapter } from "../../src/host-adapter/reference-adapters.js";
import { admit } from "../../src/host-adapter/middleware.js";
import { createFireRaidMiddleware } from "../../src/host-adapter/middleware.js";
import { ReferenceSessionAdapter, referenceInject } from "../../src/host-adapter/index.js";
import {
  DurableTelemetryAdapter,
  DurableCanaryStore,
  DurableSubmissionStore,
} from "./helpers/durable-stores.js";
import type { MiddlewareDeps } from "../../src/host-adapter/middleware.js";
import type { EnforcementResult } from "../../src/host-adapter/interface.js";
import type { Server } from "node:http";
import { createServer } from "node:http";

const SECRET = "s".repeat(64);
const VERSION = 1;
const SIGNUP_HTML = '<form id="signup-form"><input name="name"><input name="email"></form>';
const ROUTES = {
  applicationPage: "/signup",
  applicationSubmit: "/signup",
  telemetry: "/api/events",
  canaryPrefix: "/c/",
};

describe("P0-8: ReferenceEnforcementAdapter classification", () => {
  /** Local upstream returning a canned status. */
  function upstream(
    status: number,
    body = ""
  ): Promise<{ server: Server; url: string }> {
    const server = createServer((_req, res) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body);
    });
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as { port: number };
        resolve({ server, url: `http://127.0.0.1:${addr.port}/register` });
      });
    });
  }

  const adapter = () => {
    const a = new ReferenceEnforcementAdapter();
    a.forwardTimeoutMs = 2000;
    return a;
  };

  it("2xx → created", async () => {
    const { server, url } = await upstream(201);
    try {
      expect(await adapter().allow(url, { a: "b" }, "")).toEqual({ kind: "created" });
    } finally {
      server.close();
    }
  });

  it("409/422 → business-rejected with status", async () => {
    for (const status of [409, 422]) {
      const { server, url } = await upstream(status, "nope");
      try {
        expect(await adapter().allow(url, { a: "b" }, "")).toEqual({
          kind: "business-rejected",
          status,
          body: "nope",
        });
      } finally {
        server.close();
      }
    }
  });

  it("408/429/5xx → transport-failure with the upstream status as reason", async () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      const { server, url } = await upstream(status);
      try {
        const r = await adapter().allow(url, { a: "b" }, "");
        expect(r, `status ${status}`).toEqual({
          kind: "transport-failure",
          reason: `upstream_${status}`,
        });
      } finally {
        server.close();
      }
    }
  });

  it("connection refused → transport-failure network_error (never false)", async () => {
    // Port 1 on localhost is reserved/unassigned — connection refused.
    const r = await adapter().allow("http://127.0.0.1:1/register", { a: "b" }, "");
    expect(r).toEqual({ kind: "transport-failure", reason: "network_error" });
  });

  it("hung upstream → transport-failure timeout (AbortSignal enforced)", async () => {
    const server = createServer(() => {
      /* never responds */
    });
    const url: string = await new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as { port: number };
        resolve(`http://127.0.0.1:${addr.port}/register`);
      });
    });
    const a = new ReferenceEnforcementAdapter();
    a.forwardTimeoutMs = 200;
    try {
      const r = await a.allow(url, { a: "b" }, "");
      // FR-P0-02: a post-send timeout is UNCERTAIN — the upstream may have
      // committed, so the classification carries uncertain:true.
      expect(r).toEqual({ kind: "transport-failure", reason: "timeout", uncertain: true });
    } finally {
      server.close();
    }
  });

  it("redirecting upstream → transport-failure upstream_redirect (never a false-create)", async () => {
    // A 302 to a 200 HTML page (login/interstitial) is NOT an account
    // creation. fetch's default redirect:"follow" would land on the final
    // 200 and classify `created` — the redirect is refused instead.
    const server = createServer((_req, res) => {
      res.writeHead(302, { location: "/login" });
      res.end();
    });
    const url: string = await new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as { port: number };
        resolve(`http://127.0.0.1:${addr.port}/register`);
      });
    });
    try {
      const r = await adapter().allow(url, { a: "b" }, "");
      // FR-P0-02: the upstream RECEIVED and answered (a redirect) — the
      // outcome is known-received but unclassifiable as created, so it is
      // uncertain (held slot) rather than a definite release.
      expect(r).toEqual({ kind: "transport-failure", reason: "upstream_redirect", uncertain: true });
    } finally {
      server.close();
    }
  });
});

describe("P0-8: middleware receipt policy", () => {
  const baseDeps = (): MiddlewareDeps =>
    ({
      profileKeys: { current: { id: "default", secret: SECRET } },
      version: VERSION,
      upstreamRegisterUrl: "http://127.0.0.1:1/register",
      session: new ReferenceSessionAdapter(SECRET, { version: VERSION }),
      render: { inject: referenceInject },
      verification: { verificationMode: "host-owned" as const, verify: async () => true },
      telemetry: new DurableTelemetryAdapter(), // durability:"durable" — FR-P1-03
      enforcement: new ReferenceEnforcementAdapter(),
      canaryStore: new DurableCanaryStore(), // durability:"durable"
      submissionStore: new DurableSubmissionStore(), // durability:"durable"
      enforcementMode: "enforcement" as const,
      routes: ROUTES,
    }) as unknown as MiddlewareDeps;

  /** Full session via admit(): returns the submit result object. */
  async function submitResult(
    deps: MiddlewareDeps,
    // Deliberately widened: the malformed-shape tests drive the seam with
    // non-contract return values, exactly as a JS host could.
    enforcement: unknown
  ): Promise<{ kind: string; upstreamCreated?: boolean }> {
    const validated = createFireRaidMiddleware({ ...deps, enforcement } as MiddlewareDeps);
    const page = await admit(new Request("http://test/signup"), validated, async () => SIGNUP_HTML);
    expect(page.kind).toBe("get");
    const cookie = page.setCookie!.split(";")[0];
    const csrf = page.html!.match(/name="csrf" value="([^"]+)"/)?.[1] ?? "";
    const result = await admit(
      new Request("http://test/signup", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ csrf, form: { name: "T", email: "t@example.invalid" } }),
      }),
      validated,
      async () => SIGNUP_HTML
    );
    return { kind: result.kind, upstreamCreated: result.upstreamCreated };
  }

  it("transport-failure upstream → forward-failed (NOT admit)", async () => {
    const r = await submitResult(baseDeps(), new ReferenceEnforcementAdapter());
    expect(r.kind).toBe("forward-failed");
    expect(r.upstreamCreated).toBeUndefined();
  });

  it("created upstream → admit with upstreamCreated true", async () => {
    const enforcement = { allow: async () => ({ kind: "created" as const }), deny: () => {} };
    const r = await submitResult(baseDeps(), enforcement);
    expect(r.kind).toBe("admit");
    expect(r.upstreamCreated).toBe(true);
  });

  it("queued-for-retry → admit (durably captured somewhere)", async () => {
    const enforcement = {
      allow: async (): Promise<EnforcementResult> => ({ kind: "queued-for-retry", retryId: "r-1" }),
      deny: () => {},
    };
    const r = await submitResult(baseDeps(), enforcement);
    expect(r.kind).toBe("admit");
    expect(r.upstreamCreated).toBe(false);
  });

  it("legacy boolean true still maps to admit/created", async () => {
    const enforcement = { allow: async () => true, deny: () => {} };
    const r = await submitResult(baseDeps(), enforcement);
    expect(r.kind).toBe("admit");
    expect(r.upstreamCreated).toBe(true);
  });

  it("legacy boolean false maps to forward-failed (ambiguous false is never a success)", async () => {
    const enforcement = { allow: async () => false, deny: () => {} };
    const r = await submitResult(baseDeps(), enforcement);
    expect(r.kind).toBe("forward-failed");
  });

  it("MALFORMED adapter shapes fail CLOSED as forward-failed (never a success receipt)", async () => {
    // A JS host can hand back anything. A wrong-keyed object, a bare
    // string, or a kind-less blob must never produce kind "admit" — that
    // would ack an application that is nowhere durable (FR-INV-008).
    const malformed: unknown[] = [
      { status: "created" }, // wrong key
      { ok: true },
      "created", // bare string
      { kind: "created-upstream" }, // unknown kind
      { kind: "queued-for-retry" }, // missing retryId
      { kind: "transport-failure" }, // missing reason
      { kind: "business-rejected" }, // missing status
      null,
      undefined,
    ];
    for (const shape of malformed) {
      // Deliberately untyped `allow` — the whole point is that the seam is
      // a host callback that can return anything at runtime.
      const enforcement = { allow: async (): Promise<unknown> => shape, deny: () => {} };
      const r = await submitResult(baseDeps(), enforcement);
      // undefined/null/throw surface as the operational-error path
      // (FR-P0-03 — infrastructure, not the applicant's fault); every other
      // malformed shape becomes forward-failed. NEITHER is admit.
      expect(r.kind, JSON.stringify(shape)).not.toBe("admit");
    }
  });
});
