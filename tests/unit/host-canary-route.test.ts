/**
 * P1-AUDIT-2 Phase D (audit item 6) — the host plane's canary route.
 *
 * The prior middleware routed EVERY GET to signup injection: a probe of the
 * decoy route minted a FRESH session and never verified anything, so
 * Class-A route evidence (CANARY_ROUTE_MATCH → QUARANTINE) could not exist
 * on the host plane. These tests pin the route-aware branch:
 *   - GET <prefix><token> with the CORRECT session token → canary-verified,
 *     persisted idempotently in the HostCanaryStore.
 *   - wrong / missing token → deny (INVALID_TOKEN / MISSING_TOKEN).
 *   - no decoyRoute on the session → deny NO_ROUTE (404-equivalent,
 *     FR-R6-028: no fall-back to aggregate state).
 *   - tampered session → deny NO_SESSION.
 *   - store failure → deny CANARY_PERSIST_FAILED (FAIL-CLOSED — a verified
 *     hit lost while returning success would corrupt the causal signal).
 *   - WITHOUT a store, a /c/ GET is NOT a canary probe (prior behavior
 *     preserved for hosts that opt out).
 *   - POST reads verified hits back: Class-A CANARY_ROUTE_MATCH evidence →
 *     QUARANTINE — the exact causal chain the Worker's
 *     /c/:token → canary_hits → submit.ts path produces.
 */
import { describe, it, expect } from "vitest";
import {
  admit,
  makeCsrf,
  ReferenceSessionAdapter,
  ReferenceCanaryStore,
  type MiddlewareDeps,
} from "../../src/host-adapter/index.js";
import { ABLATION_RECIPES } from "../../src/core/profile.js";
import { deriveProfilePure } from "../../src/core/profile.js";

const SECRET = "host-canary-test-secret".padEnd(32, "x");

const HTML = '<html><body><form id="signup-form"></form></body></html>';

function deps(over: Partial<MiddlewareDeps> = {}): MiddlewareDeps {
  return {
    secret: SECRET,
    version: 1,
    upstreamRegisterUrl: "http://upstream.invalid/api/register",
    session: new ReferenceSessionAdapter(SECRET),
    render: { inject: (h) => h },
    verification: { verify: async () => true },
    telemetry: { accept: () => [] },
    enforcement: { allow: async () => true, deny: () => {} },
    canaryStore: new ReferenceCanaryStore(),
    labMode: false,
    recipe: ABLATION_RECIPES.FULL,
    ...over,
  };
}

async function issueSessionCookie(d: MiddlewareDeps): Promise<string> {
  const sid = await d.session.createSession();
  return d.session.sessionCookie(sid);
}

describe("host canary route (audit item 6)", () => {
  it("correct token → canary-verified, recorded in the store", async () => {
    const d = deps();
    const cookie = await issueSessionCookie(d);
    const sid = decodeSessionId(cookie);
    const profile = await deriveProfilePure(
      { secret: SECRET, version: 1, sessionId: sid, mode: "production" },
      ABLATION_RECIPES.FULL
    );
    const token = profile.decoyRoute!.endpointToken;

    const res = await admit(
      new Request(`http://mw/c/${token}`, { headers: { cookie } }),
      d,
      async () => HTML
    );
    expect(res.kind).toBe("canary-verified");
    expect(await d.canaryStore!.readVerified(sid)).toBe(true);

    // Idempotent replay: still verified, no error.
    const replay = await admit(
      new Request(`http://mw/c/${token}`, { headers: { cookie } }),
      d,
      async () => HTML
    );
    expect(replay.kind).toBe("canary-verified");
  });

  it("wrong token → deny INVALID_TOKEN; no hit recorded", async () => {
    const d = deps();
    const cookie = await issueSessionCookie(d);
    const sid = decodeSessionId(cookie);

    const res = await admit(
      new Request("http://mw/c/000000000000", { headers: { cookie } }),
      d,
      async () => HTML
    );
    expect(res.kind).toBe("deny");
    expect(res.disposition).toBe("INVALID_TOKEN");
    expect(await d.canaryStore!.readVerified(sid)).toBe(false);
  });

  it("no decoyRoute on the session → deny NO_ROUTE (never fall back)", async () => {
    const d = deps({ recipe: ABLATION_RECIPES.DECOY_FIELD_ONLY });
    const cookie = await issueSessionCookie(d);

    const res = await admit(
      new Request("http://mw/c/anything", { headers: { cookie } }),
      d,
      async () => HTML
    );
    expect(res.kind).toBe("deny");
    expect(res.disposition).toBe("NO_ROUTE");
  });

  it("tampered session cookie → deny NO_SESSION", async () => {
    const d = deps();
    // A structurally valid envelope with a forged body + forged signature:
    // verification must reject it (BAD_SIGNATURE → null → NO_SESSION).
    const res = await admit(
      new Request("http://mw/c/sometoken", {
        headers: { cookie: "__Host-fr_sid=fr1.Zm9yZ2Vk.Zm9yZ2Vk" },
      }),
      d,
      async () => HTML
    );
    expect(res.kind).toBe("deny");
    expect(res.disposition).toBe("NO_SESSION");
  });

  it("store failure on a VERIFIED token → deny CANARY_PERSIST_FAILED (fail-closed)", async () => {
    const d = deps();
    const store = d.canaryStore as ReferenceCanaryStore;
    const cookie = await issueSessionCookie(d);
    const sid = decodeSessionId(cookie);
    const profile = await deriveProfilePure(
      { secret: SECRET, version: 1, sessionId: sid, mode: "production" },
      ABLATION_RECIPES.FULL
    );
    const token = profile.decoyRoute!.endpointToken;
    store.failStore = true;

    const res = await admit(
      new Request(`http://mw/c/${token}`, { headers: { cookie } }),
      d,
      async () => HTML
    );
    expect(res.kind).toBe("deny");
    expect(res.disposition).toBe("CANARY_PERSIST_FAILED");
  });

  it("without a canaryStore, a /c/ GET is NOT a canary probe (prior behavior)", async () => {
    const d = deps({ canaryStore: undefined });
    const res = await admit(new Request("http://mw/c/whatever"), d, async () => HTML);
    expect(res.kind).toBe("get"); // signup injection, as before
  });

  it("POST after a verified probe → Class-A route evidence → QUARANTINE", async () => {
    const d = deps();
    const cookie = await issueSessionCookie(d);
    const sid = decodeSessionId(cookie);
    const profile = await deriveProfilePure(
      { secret: SECRET, version: 1, sessionId: sid, mode: "production" },
      ABLATION_RECIPES.FULL
    );
    const token = profile.decoyRoute!.endpointToken;

    // Probe first (the attacker behavior the route detects)...
    const probe = await admit(
      new Request(`http://mw/c/${token}`, { headers: { cookie } }),
      d,
      async () => HTML
    );
    expect(probe.kind).toBe("canary-verified");

    // ...then submit through the same session. Full-decoy-field fill, no
    // telemetry — the route hit ALONE must drive QUARANTINE (weight 100).
    const csrf = await makeCsrf(SECRET, sid);
    const res = await admit(
      new Request("http://mw/signup", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          csrf,
          form: {
            name: "Q",
            email: "probe-then-submit@ledger-probe.invalid",
            [profile.decoyField!.fieldName]: "",
          },
        }),
      }),
      d,
      async () => HTML
    );
    expect(res.kind).toBe("deny");
    expect(res.disposition).toBe("QUARANTINE");
  });
});

/** Extract the bare sid from the reference adapter's ENVELOPE cookie value. */
function decodeSessionId(setCookie: string): string {
  const v = setCookie.split(";")[0].split("=")[1] ?? "";
  // fr1.<base64url(payload JSON)>.<sig> — decode the body, read sid.
  const body = v.split(".")[1] ?? "";
  const b64 = body.replace(/-/g, "+").replace(/_/g, "/");
  const json = JSON.parse(atob(b64)) as { sid: string };
  return json.sid;
}
