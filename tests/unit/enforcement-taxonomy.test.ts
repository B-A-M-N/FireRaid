/**
 * P0-8 — the enforcement failure taxonomy drives the receipt policy.
 *
 * The reference adapter classifies real HTTP outcomes (FR-RR-13: ambiguity
 * is CONSERVATIVE — only positive protocol evidence settles the outcome):
 *   documented CREATED status (default 201) → created;
 *   other 4xx → business-rejected;
 *   EVERYTHING else — timeout, network error, 408/425/429/5xx, an
 *   undocumented 2xx — → UNCERTAIN transport-failure (claim slot held).
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

  it("documented CREATED status (201) → created", async () => {
    const { server, url } = await upstream(201);
    try {
      expect(await adapter().allow(url, { a: "b" }, "")).toEqual({ kind: "created" });
    } finally {
      server.close();
    }
  });

  it("FR-RR-13: an undocumented 2xx (200/202/204) is NOT a create — uncertain transport failure", async () => {
    // Response.ok spans 200–299, but only a documented CREATED status
    // asserts a durable account. 202 Accepted may be a queued job; a
    // plain 200 may be anything. Blindly treating the whole class as
    // `created` was the FR-RR-13 false-create hole.
    for (const status of [200, 202, 204, 206]) {
      const { server, url } = await upstream(status);
      try {
        const r = await adapter().allow(url, { a: "b" }, "");
        expect(r, `status ${status}`).toEqual({
          kind: "transport-failure",
          reason: `undocumented_success_${status}`,
          uncertain: true,
        });
      } finally {
        server.close();
      }
    }
  });

  it("a host-declared createdStatuses entry is honored (e.g. an upstream documenting 200)", async () => {
    const { server, url } = await upstream(200);
    const a = adapter();
    a.createdStatuses = [200];
    try {
      expect(await a.allow(url, { a: "b" }, "")).toEqual({ kind: "created" });
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

  it("FR-RR-13: 408/429/5xx → UNCERTAIN transport-failure (the upstream may have committed)", async () => {
    // A received-and-answered 500 does not prove the upstream didn't
    // commit — INSERT+COMMIT can precede a handler throw, and a reverse
    // proxy can answer 502 after the origin did the work. The definite
    // classification previously released the one-forward claim for an
    // automatic retry that could create a duplicate.
    for (const status of [408, 429, 500, 502, 503, 504]) {
      const { server, url } = await upstream(status);
      try {
        const r = await adapter().allow(url, { a: "b" }, "");
        expect(r, `status ${status}`).toEqual({
          kind: "transport-failure",
          reason: `upstream_${status}`,
          uncertain: true,
        });
      } finally {
        server.close();
      }
    }
  });

  it("FR-RR-28: UNCLASSIFIED 5xx (501/505/507/511) are uncertain transport failures — never business-rejected", async () => {
    // The old classifier's final branch had no 4xx range check: every
    // status not otherwise handled fell through to business-rejected, so
    // a server-side 501 Not Implemented or 507 Insufficient Storage was
    // recorded as the upstream's TERMINAL refusal of the applicant. Those
    // are infrastructure conditions — conservative, uncertain, slot held.
    for (const status of [501, 505, 507, 511]) {
      const { server, url } = await upstream(status);
      try {
        const r = await adapter().allow(url, { a: "b" }, "");
        expect(r, `status ${status}`).toEqual({
          kind: "transport-failure",
          reason: `upstream_${status}`,
          uncertain: true,
        });
      } finally {
        server.close();
      }
    }
  });

  it("FR-RR-28: the exhaustive split — 4xx (non-retryable) IS the business answer", async () => {
    // Exhaustiveness must not over-swing: a genuine 4xx refusal stays a
    // terminal business rejection with its status and body.
    for (const status of [400, 403, 404, 409, 410, 422]) {
      const { server, url } = await upstream(status, "nope");
      try {
        expect(await adapter().allow(url, { a: "b" }, ""), `status ${status}`).toEqual({
          kind: "business-rejected",
          status,
          body: "nope",
        });
      } finally {
        server.close();
      }
    }
  });

  it("connection refused → UNCERTAIN transport-failure network_error (Fetch proves nothing about pre-send)", async () => {
    // Port 1 on localhost is reserved/unassigned — connection refused.
    // Even this is classified uncertain: the Fetch API offers no positive
    // protocol-level proof the request did not cross the irreversible
    // boundary, so the conservative default holds the slot.
    const r = await adapter().allow("http://127.0.0.1:1/register", { a: "b" }, "");
    expect(r).toEqual({ kind: "transport-failure", reason: "network_error", uncertain: true });
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

  it("FR-RR-13 REGRESSION: origin receives the POST, commits, destroys the socket before replying → uncertain, claim HELD, retry never re-forwards", async () => {
    // The exact post-send ambiguity the audit demanded a test for: the
    // upstream performs the irreversible act, then the connection dies
    // before the response. fetch() surfaces a bare TypeError — which the
    // old classifier called a DEFINITE pre-send failure and released the
    // claim on. The ledger proves the account WAS created.
    let upstreamCalls = 0;
    const created = new Set<string>();
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c));
      req.on("end", () => {
        upstreamCalls++;
        const form = (JSON.parse(body || "{}") as { form?: { email?: string } }).form ?? {};
        if (form.email) created.add(form.email);
        // The account is committed — then the socket is destroyed before
        // ANY response leaves.
        res.destroy();
      });
    });
    const url: string = await new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () =>
        resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}/register`)
      );
    });
    try {
      const a = adapter();
      const first = await a.allow(url, { email: "socket-death@example.invalid" }, "");
      expect(first).toEqual({
        kind: "transport-failure",
        reason: "network_error",
        uncertain: true,
      });
      // Ground truth: the upstream DID receive and commit.
      expect(created.size).toBe(1);
      expect(upstreamCalls).toBe(1);

      // Through the middleware: the uncertain outcome must HOLD the claim
      // so the client's retry cannot re-forward.
      const deps = {
        profileKeys: { current: { id: "default", secret: SECRET } },
        version: VERSION,
        upstreamRegisterUrl: url,
        session: new ReferenceSessionAdapter(SECRET, { version: VERSION }),
        render: { inject: referenceInject },
        verification: { verificationMode: "host-owned" as const, verify: async () => true },
        telemetry: new DurableTelemetryAdapter(),
        enforcement: a,
        canaryStore: new DurableCanaryStore(),
        submissionStore: new DurableSubmissionStore(),
        enforcementMode: "enforcement" as const,
        routes: ROUTES,
      } as unknown as MiddlewareDeps;
      const validated = createFireRaidMiddleware(deps);
      const page = await admit(new Request("http://test/signup"), validated, async () => SIGNUP_HTML);
      expect(page.kind).toBe("get");
      const cookie = page.setCookie!.split(";")[0];
      const csrf = page.html!.match(/name="csrf" value="([^"]+)"/)?.[1] ?? "";
      const post = (email: string) =>
        admit(
          new Request("http://test/signup", {
            method: "POST",
            headers: { "content-type": "application/json", cookie },
            body: JSON.stringify({ csrf, form: { name: "T", email } }),
          }),
          validated,
          async () => SIGNUP_HTML
        );

      const email = "retry-after-socket-death@example.invalid";
      const r1 = await post(email);
      expect(r1.kind).toBe("forward-failed");
      expect(upstreamCalls).toBe(2); // this session's one forward
      const callsAfterFirst = upstreamCalls;

      // The client retries — the claim must still be held (uncertain), so
      // the retry conflicts and the upstream is NEVER called again.
      const r2 = await post(email);
      expect(r2.kind).not.toBe("admit");
      expect(upstreamCalls).toBe(callsAfterFirst);
      // Exactly one account was ever created for that email.
      expect(created.has(email)).toBe(true);
    } finally {
      server.close();
      server.closeAllConnections?.();
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
  ): Promise<{ kind: string; upstreamCreated?: boolean; enforcementDetail?: { uncertain?: boolean }; forwardFailureReason?: string }> {
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
    return {
      kind: result.kind,
      upstreamCreated: result.upstreamCreated,
      enforcementDetail: (result as { enforcementDetail?: { uncertain?: boolean } }).enforcementDetail,
      forwardFailureReason: (result as { forwardFailureReason?: string }).forwardFailureReason,
    };
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

  it("FR-RR-24: a legacy boolean answer is MALFORMED — uncertain transport failure, slot held", async () => {
    // The boolean contract is removed from the production interface (its
    // `false` was indistinguishable from "the origin MAY have committed").
    // At runtime a JS host still returning a boolean now normalizes to an
    // UNCERTAIN transport failure — never a releasable definite failure.
    const ops: string[] = [];
    const deps = baseDeps();
    deps.onOperationalError = (op) => ops.push(op);
    const enforcement = { allow: async () => true as never, deny: () => {} };
    const r = await submitResult(deps, enforcement);
    expect(r.kind).toBe("forward-failed");
    expect((r as { enforcementDetail?: { uncertain?: boolean } }).enforcementDetail?.uncertain).toBe(true);

    const deps2 = baseDeps();
    deps2.onOperationalError = (op) => ops.push(op);
    const enforcement2 = { allow: async () => false as never, deny: () => {} };
    const r2 = await submitResult(deps2, enforcement2);
    expect(r2.kind).toBe("forward-failed");
    // false is NEVER a success receipt — and now never a definite
    // release-able failure either.
    expect((r2 as { enforcementDetail?: { uncertain?: boolean } }).enforcementDetail?.uncertain).toBe(true);
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
