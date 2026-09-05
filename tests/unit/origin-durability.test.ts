/**
 * P0-5 — onAssessment is a durability seam, not fire-and-forget.
 *
 * The runtime AWAITS the hook's Promise BEFORE writing the success receipt:
 *   1. a deferred (unresolved) Promise holds the HTTP response open — the
 *      receipt is never sent before the host's persistence completes;
 *   2. a REJECTED hook fails the request with a generic 500 — never a
 *      success receipt (the applicant/client treats it as retryable);
 *   3. a synchronous (void) hook changes nothing (the common host case).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { createOriginServer, closeServer } from "../../src/runtime/node.js";
import type { AddressInfo } from "node:net";
import {
  ReferenceSessionAdapter,
  referenceInject,
} from "../../src/host-adapter/index.js";
import {
  DurableTelemetryAdapter,
  DurableCanaryStore,
  DurableSubmissionStore,
} from "./helpers/durable-stores.js";
import type { OriginAssessment } from "../../src/runtime/node.js";

const SECRET = "s".repeat(64);
const VERSION = 1;

const SIGNUP_HTML =
  '<form id="signup-form"><input name="name"><input name="email"><input name="password"><button>Submit</button></form>';

const ROUTES = {
  applicationPage: "/signup",
  applicationSubmit: "/signup",
  telemetry: "/api/events",
  canaryPrefix: "/c/",
};

describe("P0-5: onAssessment durability", () => {
  let server: http.Server;
  let port: number;
  let deferred: {
    settle: () => void;
    fail: (e: Error) => void;
    promise: Promise<void>;
    calls: OriginAssessment[];
  } | null;

  beforeEach(async () => {
    deferred = null;
    const deps = {
      profileKeys: { current: { id: "default", secret: SECRET } },
      version: VERSION,
      upstreamRegisterUrl: "http://localhost:1/api/register",
      session: new ReferenceSessionAdapter(SECRET, { version: VERSION }),
      render: { inject: referenceInject },
      verification: { verificationMode: "host-owned" as const, verify: async () => true },
      telemetry: new DurableTelemetryAdapter(), // FR-P1-03: production path needs durable stores
      enforcement: { allow: async () => true, deny: () => {} },
      canaryStore: new DurableCanaryStore(),
    submissionStore: new DurableSubmissionStore(),
      enforcementMode: "enforcement" as const,
      routes: ROUTES,
    };
    server = createOriginServer({
      middlewareDeps: deps,
      htmlLoader: async () => SIGNUP_HTML,

      routes: ROUTES,
      onAssessment: (a) => {
        if (!deferred) return; // sync no-op by default
        deferred.calls.push(a);
        // Hold the FIRST call open until the test settles it.
        if (deferred.calls.length === 1) return deferred.promise;
        return undefined;
      },
    });
    port = await new Promise<number>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => {
        resolve((server.address() as AddressInfo).port);
      });
      server.on("error", reject);
    });
  });

  afterEach(async () => {
    if (server.listening) await closeServer(server);
  });

  function armDeferred(): {
    settle: () => void;
    fail: (e: Error) => void;
    calls: OriginAssessment[];
  } {
    let settle!: () => void;
    let fail!: (e: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      settle = res;
      fail = rej;
    });
    deferred = { settle, fail, promise, calls: [] };
    return { settle, fail, calls: deferred.calls };
  }

  /** Full session: GET page (cookie + csrf), then one valid POST. */
  async function submitOnce(): Promise<Response> {
    const base = `http://127.0.0.1:${port}`;
    const pageResp = await fetch(`${base}/signup`);
    const cookie = (pageResp.headers.get("set-cookie") ?? "").split(";")[0];
    const page = await pageResp.text();
    const csrf = page.match(/name="csrf" value="([^"]+)"/)?.[1] ?? "";
    return fetch(`${base}/signup`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        csrf,
        form: { name: "Durability", email: "d@example.invalid", password: "x-pass-123" },
      }),
    });
  }

  it("response does not complete before the hook's Promise resolves", async () => {
    const d = armDeferred();
    let settled = false;
    const pending = submitOnce().then((r) => {
      settled = true;
      return r;
    });

    // The hook is holding the response open: after a grace window the
    // fetch must STILL be pending (the receipt waits for durability).
    await new Promise((r) => setTimeout(r, 400));
    expect(settled, "receipt was written before onAssessment resolved").toBe(false);
    expect(d.calls.length, "hook fired exactly once before settling").toBe(1);

    // Settle → the response completes with the success receipt.
    d.settle();
    const resp = await pending;
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { status?: string };
    expect(body.status).toBe("received");
  });

  it("rejecting hook → generic 500, never a success receipt", async () => {
    const d = armDeferred();
    const pending = submitOnce();
    await new Promise((r) => setTimeout(r, 300));
    d.fail(new Error("host persistence down"));
    const resp = await pending;
    expect(resp.status).toBe(500);
    const body = (await resp.json()) as { status?: string; message?: string; error?: string };
    expect(body.status).toBeUndefined();
    expect(body.message).toBeUndefined();
    expect(body.error).toBe("Internal Server Error");
  });

  it("synchronous void hook does not block the receipt", async () => {
    // deferred === null → onAssessment returns undefined → fast path.
    const resp = await submitOnce();
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { status?: string };
    expect(body.status).toBe("received");
  });
});
