/**
 * Middleware productization tests — the production factory contract.
 *
 * Covers (audit Batch 1 + Batch 2):
 *   (14) Route table dispatch with explicit routes config
 *   (17) createFireRaidMiddleware factory validation — capability contract
 *   (15) ReferenceRenderError on formless pages
 *   (18) Profile key ring — previous/current key resolution, unknown kid FAILS CLOSED
 *   (19) CSRF secret separation — GET-issued token POSTs back successfully
 *   (P0) custom canaryPrefix — the FULL causal chain (emit → probe → submit)
 *   (P0) production factory REFUSES labMode/recipe/disabled-test verification
 *   Evaluation plane: admitEvaluation + createEvaluationMiddleware keep the
 *   recipe/lab surface working.
 */
import { describe, it, expect } from "vitest";
import {
  resolveRoutes,
  admit,
  makeCsrf,
  createFireRaidMiddleware,
  MiddlewareConfigError,
  ReferenceRenderError,
  ReferenceSessionAdapter,
  ReferenceCanaryStore,
  referenceInject,
  type MiddlewareDeps,
  type MiddlewareRouteConfig,
} from "../../src/host-adapter/index.js";
import {
  admitEvaluation,
  createEvaluationMiddleware,
  type EvaluationMiddlewareDeps,
} from "../../src/eval/evaluation-middleware.js";
import { deriveProfilePure } from "../../src/core/profile.js";
import type { ProfileKeyRing } from "../../src/core/session.js";

const SECRET = "s".repeat(64);
const VERSION = 1;

const SIGNUP_HTML = '<form id="signup-form"></form><body></body>';
const FORMLESS_HTML = '<html><body><p>No form here</p></body></html>';

function baseDeps(over: Partial<MiddlewareDeps> = {}): MiddlewareDeps {
  return {
    // Production-contract fixture (item 18): profileKeys is authoritative;
    // `secret` stays only to exercise the factory's rejection of it.
    profileKeys: { current: { id: "default", secret: SECRET } },
    secret: SECRET,
    version: VERSION,
    upstreamRegisterUrl: "http://upstream/api/register",
    session: new ReferenceSessionAdapter(SECRET),
    render: { inject: (h, p, c, l, o) => referenceInject(h, p, c, l, o) },
    verification: { verificationMode: "host-owned" as const, verify: async () => true },
    telemetry: {
      accept: async () => ({ kind: "accepted" as const, received: 0, acceptedThrough: -1, duplicate: true }),
      collect: async () => [],
    },
    enforcement: { allow: async () => true, deny: () => {} },
    canaryStore: new ReferenceCanaryStore(),
    enforcementMode: "enforcement",
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// (14) Route table dispatch
// ─────────────────────────────────────────────────────────────────────────────

const ROUTES: MiddlewareRouteConfig = {
  applicationPage: "/signup",
  applicationSubmit: "/api/submit",
  telemetry: "/api/events",
  canaryPrefix: "/c/",
};

describe("route table dispatch (audit item 14)", () => {
  it("GET /other → not-handled", async () => {
    const d = createFireRaidMiddleware(baseDeps({ routes: ROUTES }));
    const res = await admit(new Request("http://mw/other"), d, async () => SIGNUP_HTML);
    expect(res.kind).toBe("not-handled");
  });

  it("POST /other → not-handled", async () => {
    const d = createFireRaidMiddleware(baseDeps({ routes: ROUTES }));
    const res = await admit(
      new Request("http://mw/other", { method: "POST", body: "{}" }),
      d,
      async () => SIGNUP_HTML
    );
    expect(res.kind).toBe("not-handled");
  });

  it("GET /signup (applicationPage) → kind get", async () => {
    const d = createFireRaidMiddleware(baseDeps({ routes: ROUTES }));
    const res = await admit(new Request("http://mw/signup"), d, async () => SIGNUP_HTML);
    expect(res.kind).toBe("get");
    expect(res.html).toContain("csrf");
  });

  it("POST /api/submit (applicationSubmit) evaluates", async () => {
    const enforcement: { allowed: number; denied: number } = { allowed: 0, denied: 0 };
    const d = createFireRaidMiddleware(baseDeps({
      routes: ROUTES,
      enforcement: {
        allow: async () => { enforcement.allowed++; return true; },
        deny: () => { enforcement.denied++; },
      },
    }));
    const adapter = new ReferenceSessionAdapter(SECRET);
    const sid = await adapter.createSession();
    const cookie = await adapter.sessionCookie(sid);
    const csrf = await makeCsrf(SECRET, sid);
    const res = await admit(
      new Request("http://mw/api/submit", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ csrf, form: { name: "A", email: "a@b.c" } }),
      }),
      d,
      async () => SIGNUP_HTML
    );
    expect(res.kind).toBe("admit");
    expect(enforcement.allowed).toBe(1);
  });

  it("GET /c/<token> with the session's canary token → canary-verified", async () => {
    const store = new ReferenceCanaryStore();
    const d = createFireRaidMiddleware(baseDeps({
      routes: ROUTES,
      canaryStore: store,
    }));
    const adapter = new ReferenceSessionAdapter(SECRET);
    const sid = await adapter.createSession();
    const cookie = await adapter.sessionCookie(sid);
    const profile = await deriveProfilePure(
      { secret: SECRET, version: 1, sessionId: sid, mode: "production" }
    );
    // Production composition always carries decoy-route (P02/P04) or can be
    // probed only when the session's profile has one; skip otherwise.
    if (!profile.decoyRoute) return;
    const token = profile.decoyRoute.endpointToken;
    const res = await admit(
      new Request(`http://mw/c/${token}`, { headers: { cookie } }),
      d,
      async () => SIGNUP_HTML
    );
    expect(res.kind).toBe("canary-verified");
    expect(await store.readVerified(sid)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (P0) Custom canaryPrefix — the FULL causal chain
// ─────────────────────────────────────────────────────────────────────────────

describe("custom canaryPrefix full causal chain (audit P0)", () => {
  const CUSTOM: MiddlewareRouteConfig = {
    applicationPage: "/application",
    applicationSubmit: "/application",
    telemetry: "/application/events",
    canaryPrefix: "/machine-check/",
  };

  it("GET → emitted route uses the resolved prefix; GET that URL verifies; POST sees CANARY_ROUTE_MATCH", async () => {
    const store = new ReferenceCanaryStore();
    const enforcement = { denied: 0, allowed: 0 };
    const evalDeps: EvaluationMiddlewareDeps = {
      ...createFireRaidMiddleware(baseDeps({
        routes: CUSTOM,
        canaryStore: store,
        enforcement: {
          allow: async () => { enforcement.allowed++; return true; },
          deny: () => { enforcement.denied++; },
        },
      })),
      recipe: { families: ["semantic", "decoy-route"], semanticTemplate: "P02" },
    };

    // 1. GET the application page: force P02 (route strategy) so the emitted
    //    route material is exercised. The carrier channel is randomized per
    //    session — marker-only channels (meta/comment) deliberately carry
    //    nonce-only material with NO route URL — so draw until a full-action
    //    carrier (the bare template) issues the route material.
    let html = "";
    let cookie1 = "";
    let routeMatch: RegExpMatchArray | null = null;
    for (let draw = 0; draw < 40 && !routeMatch; draw++) {
      const get = await admitEvaluation(
        new Request("http://mw/application"),
        evalDeps,
        async () => SIGNUP_HTML
      );
      expect(get.kind).toBe("get");
      html = get.html ?? "";
      cookie1 = get.setCookie ?? "";
      routeMatch = html.match(/\/machine-check\/([0-9a-f]{12})/);
    }
    expect(routeMatch, "a full-action P02 carrier within 40 draws").not.toBeNull();
    // The emitted instruction material names /machine-check/<token>, never
    // the /c/ default.
    expect(html).not.toMatch(/\/c\/[0-9a-f]{12}/);
    const token = routeMatch![1];

    // 2. GET the EXACT emitted URL → verified (the route the middleware
    //    dispatches on and the route the page names agree).
    const probe = await admitEvaluation(
      new Request(`http://mw/machine-check/${token}`, { headers: { cookie: cookie1 } }),
      evalDeps,
      async () => SIGNUP_HTML
    );
    expect(probe.kind).toBe("canary-verified");

    // 3. POST the application → the verified hit becomes Class-A evidence.
    const csrf = (html.match(/name="csrf" value="([^"]+)"/) ?? [])[1] ?? "";
    const post = await admitEvaluation(
      new Request("http://mw/application", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: cookie1 },
        body: JSON.stringify({ csrf, form: { name: "A", email: "a@b.c" } }),
      }),
      evalDeps,
      async () => SIGNUP_HTML
    );
    expect(post.kind).toBe("deny");
    expect(post.disposition).toBe("QUARANTINE");
    expect(post.risk?.tier).toBe("CAUSAL");
    expect(post.risk?.evidence.some((e) => e.source === "CANARY_ROUTE_MATCH")).toBe(true);
    expect(enforcement.allowed).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Legacy behavior (routes OMITTED) — admit() with the raw deps shape
// ─────────────────────────────────────────────────────────────────────────────

describe("legacy behavior when routes is OMITTED", () => {
  it("any GET path injects (back-compat)", async () => {
    const d = baseDeps();
    const res = await admitEvaluation(new Request("http://mw/anything"), d, async () => SIGNUP_HTML);
    expect(res.kind).toBe("get");
    expect(res.html).toContain("csrf");
  });

  it("any POST with valid session evaluates", async () => {
    const enforcement: { allowed: number } = { allowed: 0 };
    const d = baseDeps({
      enforcement: {
        allow: async () => { enforcement.allowed++; return true; },
        deny: () => {},
      },
    });
    const adapter = new ReferenceSessionAdapter(SECRET);
    const sid = await adapter.createSession();
    const cookie = await adapter.sessionCookie(sid);
    const csrf = await makeCsrf(SECRET, sid);
    const res = await admitEvaluation(
      new Request("http://mw/anything", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ csrf, form: { name: "A", email: "a@b.c" } }),
      }),
      d,
      async () => SIGNUP_HTML
    );
    expect(res.kind).toBe("admit");
    expect(enforcement.allowed).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (17) createFireRaidMiddleware factory validation
// ─────────────────────────────────────────────────────────────────────────────

describe("createFireRaidMiddleware factory (audit item 17 + Batch 1/2)", () => {
  it("missing routes throws (routes are the canonical table)", () => {
    expect(() => createFireRaidMiddleware(baseDeps())).toThrow(MiddlewareConfigError);
  });

  it("empty applicationPage throws", () => {
    expect(() =>
      createFireRaidMiddleware({
        ...baseDeps(),
        routes: { applicationPage: "", applicationSubmit: "/api/submit" },
      })
    ).toThrow(MiddlewareConfigError);
  });

  it("missing canaryStore throws (production route-evidence capability)", () => {
    const { canaryStore: _omitted, ...rest } = baseDeps({ routes: ROUTES });
    expect(() => createFireRaidMiddleware(rest as unknown as MiddlewareDeps)).toThrow(/canaryStore/);
  });

  // ── Rereview item 3: per-strategy capability enumeration ──────────────────
  describe("production capability graph (rereview item 3)", () => {
    it("names EVERY strategy whose capability is missing (and only those)", () => {
      // Kill render.inject → P03 and P04 lose their decoy-field channel.
      // P02 (canary store present) and interaction (telemetry present) are
      // still wired, so the error must NOT name them.
      const { render: _r, ...rest } = baseDeps({ routes: ROUTES });
      const crippled = {
        ...rest,
        render: {} as unknown as MiddlewareDeps["render"],
      } as unknown as MiddlewareDeps;
      try {
        createFireRaidMiddleware(crippled);
        expect.unreachable("factory must refuse an incomplete capability graph");
      } catch (e) {
        expect(e).toBeInstanceOf(MiddlewareConfigError);
        const msg = (e as Error).message;
        expect(msg).toContain("P03");
        expect(msg).toContain("P04");
        expect(msg).not.toContain("P02 ");
        expect(msg).not.toContain("interaction (needs");
        // The error must demand WIRING, not pool narrowing.
        expect(msg).toMatch(/Narrowing the strategy pool is NOT a valid response/);
      }
    });

    it("a missing canaryStore names P02 and P04 (route channel)", () => {
      const { canaryStore: _c, ...rest } = baseDeps({ routes: ROUTES });
      // The dedicated canaryStore check fires first with its own message.
      expect(() =>
        createFireRaidMiddleware(rest as unknown as MiddlewareDeps)
      ).toThrow(/P02\/P04/);
    });

    it("empty telemetryIngestPath throws (interaction channel cannot drain)", () => {
      expect(() =>
        createFireRaidMiddleware(baseDeps({ routes: ROUTES, telemetryIngestPath: "" }))
      ).toThrow(/client-instrumentation/);
    });

    it("a COMPLETE graph with every production capability constructs cleanly", () => {
      const d = createFireRaidMiddleware(baseDeps({ routes: ROUTES }));
      expect(d.profileKeys).toBeDefined();
    });
  });

  it("missing profileKeys throws (item 18: the ring IS the production contract)", () => {
    const { profileKeys: _ring, ...rest } = baseDeps({ routes: ROUTES });
    expect(() =>
      createFireRaidMiddleware(rest as unknown as MiddlewareDeps)
    ).toThrow(/profileKeys/);
  });

  it("short current key secret throws", () => {
    expect(() =>
      createFireRaidMiddleware(baseDeps({
        routes: ROUTES,
        profileKeys: { current: { id: "default", secret: "short" } },
      }))
    ).toThrow(/profileKeys\.current\.secret/);
  });

  it("short ring-less secret alone throws (evaluation shape, not production)", () => {
    const { profileKeys: _ring, ...secretOnly } = baseDeps({
      secret: "short",
      routes: ROUTES,
    });
    expect(() =>
      createFireRaidMiddleware(secretOnly as unknown as MiddlewareDeps)
    ).toThrow(/profileKeys/);
  });

  it("zero / negative version throws", () => {
    expect(() => createFireRaidMiddleware(baseDeps({ version: 0, routes: ROUTES }))).toThrow(MiddlewareConfigError);
    expect(() => createFireRaidMiddleware(baseDeps({ version: -1, routes: ROUTES }))).toThrow(MiddlewareConfigError);
  });

  it("malformed risk tiers throw at startup (never during a live submission)", () => {
    expect(() =>
      createFireRaidMiddleware(baseDeps({
        routes: ROUTES,
        riskTiers: [
          { minScore: 0, maxScore: 100, tier: "LOW", recommendedAction: "CONTINUE", autoSuppress: false },
          { minScore: 100, maxScore: null, tier: "HIGH", recommendedAction: "SUPPRESS_AUTO_APPROVAL", autoSuppress: true },
        ],
      }))
    ).toThrow(MiddlewareConfigError);
  });

  it("malformed profile key ring throws at startup", () => {
    const ring: ProfileKeyRing = {
      current: { id: "k2", secret: "x".repeat(64) },
      previous: { "k2": "y".repeat(64) }, // duplicate of current
    };
    expect(() =>
      createFireRaidMiddleware(baseDeps({ routes: ROUTES, profileKeys: ring }))
    ).toThrow(/previous/);
  });

  it("disabled-test verification throws in the PRODUCTION factory", () => {
    expect(() =>
      createFireRaidMiddleware(baseDeps({
        routes: ROUTES,
        verification: { verificationMode: "disabled-test" as const, verify: async () => true },
      }))
    ).toThrow(/disabled-test/);
  });

  it("valid config returns deps unchanged", () => {
    const d = baseDeps({ routes: ROUTES });
    const result = createFireRaidMiddleware(d);
    expect(result).toBe(d);
    expect(result.secret).toBe(SECRET);
    expect(result.version).toBe(VERSION);
  });

  // ── Batch 2: the production factory REFUSES evaluation overrides ────────
  it("labMode smuggled into the production factory throws", () => {
    const d = baseDeps({ routes: ROUTES });
    expect(() =>
      createFireRaidMiddleware({ ...d, labMode: true } as unknown as MiddlewareDeps)
    ).toThrow(/labMode|Evaluation/);
  });

  it("recipe smuggled into the production factory throws", () => {
    const d = baseDeps({ routes: ROUTES });
    expect(() =>
      createFireRaidMiddleware({ ...d, recipe: { families: ["interaction"] } } as unknown as MiddlewareDeps)
    ).toThrow(/recipe|Evaluation/);
  });

  it("deprecated canaryPathPrefix smuggled in throws", () => {
    const d = baseDeps({ routes: ROUTES });
    expect(() =>
      createFireRaidMiddleware({ ...d, canaryPathPrefix: "/c/" } as unknown as MiddlewareDeps)
    ).toThrow(MiddlewareConfigError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Evaluation plane: the recipe/lab surface LIVES here
// ─────────────────────────────────────────────────────────────────────────────

describe("createEvaluationMiddleware (evaluation surface)", () => {
  it("accepts labMode + recipe and derives the bound condition", async () => {
    const base = baseDeps({ routes: ROUTES });
    const d = createEvaluationMiddleware({
      ...base,
      labMode: true,
      recipe: { families: ["interaction"] },
    } as EvaluationMiddlewareDeps);
    const get = await admitEvaluation(new Request("http://mw/signup"), d, async () => SIGNUP_HTML);
    expect(get.kind).toBe("get");
    // Lab mode emits the greppable research banner + markers.
    expect(get.html).toContain("RESEARCH / TEST ENVIRONMENT");
  });

  it("still validates structure (missing canaryStore throws)", () => {
    const { canaryStore: _omitted, ...rest } = baseDeps({ routes: ROUTES });
    expect(() => createEvaluationMiddleware(rest as unknown as EvaluationMiddlewareDeps)).toThrow(/canaryStore/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (15) ReferenceRenderError on formless pages
// ─────────────────────────────────────────────────────────────────────────────

describe("ReferenceRenderError on formless pages (audit item 15)", () => {
  it("injecting into a formless page throws ReferenceRenderError", async () => {
    const d = baseDeps();
    const sessionId = await d.session.createSession();
    const profile = await deriveProfilePure(
      { secret: SECRET, version: VERSION, sessionId, mode: "production" },
      { families: ["decoy-field"] }
    );
    const csrf = await makeCsrf(SECRET, sessionId);
    expect(() => d.render.inject(FORMLESS_HTML, profile, csrf, false)).toThrow(ReferenceRenderError);
  });

  it("a page WITH <form> renders fine", async () => {
    const d = baseDeps();
    const sessionId = await d.session.createSession();
    const profile = await deriveProfilePure(
      { secret: SECRET, version: VERSION, sessionId, mode: "production" },
      { families: ["decoy-field"] }
    );
    const csrf = await makeCsrf(SECRET, sessionId);
    const result = d.render.inject(SIGNUP_HTML, profile, csrf, false);
    expect(result).toContain("csrf");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (18) Profile key ring — exact lookup, unknown kid FAILS CLOSED
// ─────────────────────────────────────────────────────────────────────────────

describe("profile key ring (audit item 18 + P1 fail-closed)", () => {
  const KEY_1 = "key-old-secret-00000000000000000000".padEnd(32, "x");
  const KEY_2 = "key-new-secret-00000000000000000000".padEnd(32, "y");
  const RING: ProfileKeyRing = {
    current: { id: "k2", secret: KEY_2 },
    previous: { "k1": KEY_1 },
  };

  it("session under previous key reconstructs and admits", async () => {
    // Issue session with the OLD key (secret = KEY_1, kid = "k1")
    const oldAdapter = new ReferenceSessionAdapter(KEY_1, { version: 1, keyId: "k1" });
    const sid = await oldAdapter.createSession();
    const cookie = await oldAdapter.sessionCookie(sid);

    const sessionAdapter = new ReferenceSessionAdapter(RING);
    const ctx = await sessionAdapter.resolveSession(
      new Request("http://mw/", { headers: { cookie } })
    );
    expect(ctx).not.toBeNull();
    expect(ctx!.keyId).toBe("k1");

    const enforcement: { allowed: number; denied: number } = { allowed: 0, denied: 0 };
    const d = createFireRaidMiddleware(baseDeps({
      routes: ROUTES,
      profileKeys: RING,
      session: sessionAdapter,
      enforcement: {
        allow: async () => { enforcement.allowed++; return true; },
        deny: () => { enforcement.denied++; },
      },
    }));

    // CSRF uses the ISSUING key secret (the resolver's no-explicit-secret
    // branch) — old-key sessions keep working across rotation.
    const csrf = await makeCsrf(KEY_1, sid);
    const res = await admit(
      new Request("http://mw/api/submit", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ csrf, form: { name: "A", email: "a@b.c" } }),
      }),
      d,
      async () => SIGNUP_HTML
    );
    expect(res.kind).toBe("admit");
    expect(enforcement.allowed).toBe(1);
  });

  it("envelope with unknown kid is denied", async () => {
    const rogueAdapter = new ReferenceSessionAdapter(SECRET, { keyId: "unknown" });
    const sid = await rogueAdapter.createSession();
    const cookie = await rogueAdapter.sessionCookie(sid);

    const d = createFireRaidMiddleware(baseDeps({
      routes: ROUTES,
      profileKeys: RING,
      enforcement: { allow: async () => true, deny: () => {} },
    }));

    const res = await admit(
      new Request("http://mw/api/submit", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ form: { name: "A" } }),
      }),
      d,
      async () => SIGNUP_HTML
    );
    expect(res.kind).toBe("deny");
    expect(res.disposition).toBe("NO_SESSION");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (19) CSRF secret separation — the middleware CONSUMES ITS OWN TOKEN
// ─────────────────────────────────────────────────────────────────────────────

describe("CSRF secret separation (audit item 19 + P0 roundtrip)", () => {
  const CSRF_SECRET = "csrf-special-secret-00000000000000000000".padEnd(32, "z");

  it("ROUNDTRIP: GET-minted CSRF (dedicated csrfSecret) POSTs back successfully", async () => {
    const enforcement: { allowed: number } = { allowed: 0 };
    const d = createFireRaidMiddleware(baseDeps({
      routes: ROUTES,
      csrfSecret: CSRF_SECRET,
      enforcement: { allow: async () => { enforcement.allowed++; return true; }, deny: () => {} },
    }));
    // 1. GET the application page — the middleware MINTS the token.
    const get = await admit(new Request("http://mw/signup"), d, async () => SIGNUP_HTML);
    expect(get.kind).toBe("get");
    const csrf = (get.html ?? "").match(/name="csrf" value="([^"]+)"/)?.[1] ?? "";
    expect(csrf).not.toBe("");
    const cookie = get.setCookie ?? "";
    // 2. POST the token back UNCHANGED — the middleware must VERIFY it.
    const res = await admit(
      new Request("http://mw/api/submit", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ csrf, form: { name: "A", email: "a@b.c" } }),
      }),
      d,
      async () => SIGNUP_HTML
    );
    expect(res.kind).toBe("admit");
    expect(enforcement.allowed).toBe(1);
  });

  it("ROUNDTRIP without csrfSecret: GET-minted token (profile-key derivation) verifies", async () => {
    const enforcement: { allowed: number } = { allowed: 0 };
    const d = createFireRaidMiddleware(baseDeps({
      routes: ROUTES,
      enforcement: { allow: async () => { enforcement.allowed++; return true; }, deny: () => {} },
    }));
    const get = await admit(new Request("http://mw/signup"), d, async () => SIGNUP_HTML);
    const csrf = (get.html ?? "").match(/name="csrf" value="([^"]+)"/)?.[1] ?? "";
    const cookie = get.setCookie ?? "";
    const res = await admit(
      new Request("http://mw/api/submit", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ csrf, form: { name: "A", email: "a@b.c" } }),
      }),
      d,
      async () => SIGNUP_HTML
    );
    expect(res.kind).toBe("admit");
    expect(enforcement.allowed).toBe(1);
  });

  it("csrfSecret set: token minted with the PROFILE secret fails", async () => {
    const d = createFireRaidMiddleware(baseDeps({ routes: ROUTES, csrfSecret: CSRF_SECRET }));
    const adapter = new ReferenceSessionAdapter(SECRET);
    const sid = await adapter.createSession();
    const cookie = await adapter.sessionCookie(sid);
    const csrf = await makeCsrf(SECRET, sid); // wrong secret on purpose

    const res = await admit(
      new Request("http://mw/api/submit", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ csrf, form: { name: "A", email: "a@b.c" } }),
      }),
      d,
      async () => SIGNUP_HTML
    );
    expect(res.kind).toBe("deny");
    expect(res.disposition).toBe("CSRF_FAILED");
  });

  it("roundtrip under an explicit csrfSecret with key ring ROTATION: old-key session still verifies", async () => {
    // CSRF must NOT change when profile keys rotate (the audit's rationale
    // for the dedicated secret). Old-key session + dedicated CSRF secret.
    const KEY_OLD = "old-rotation-secret-00000000000000000000".padEnd(32, "o");
    const ROT_RING: ProfileKeyRing = {
      current: { id: "new", secret: "x".repeat(64) },
      previous: { old: KEY_OLD },
    };
    const oldAdapter = new ReferenceSessionAdapter(KEY_OLD, { version: 1, keyId: "old" });
    const sid = await oldAdapter.createSession();
    const cookie = await oldAdapter.sessionCookie(sid);
    const d = createFireRaidMiddleware(baseDeps({
      routes: ROUTES,
      profileKeys: ROT_RING,
      session: new ReferenceSessionAdapter(ROT_RING),
      csrfSecret: CSRF_SECRET,
    }));
    // Mint with the CSRF secret (what GET would have issued pre-rotation).
    const csrf = await makeCsrf(CSRF_SECRET, sid);
    const res = await admit(
      new Request("http://mw/api/submit", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ csrf, form: { name: "A", email: "a@b.c" } }),
      }),
      d,
      async () => SIGNUP_HTML
    );
    expect(res.kind).toBe("admit");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rereview item 24: the Cloudflare trust boundary is CODE-ENFORCED.
// CF-Connecting-IP reaches verification ONLY when the deployment declares
// trustedIngress: "cloudflare". The default ("direct") NEVER reads it — a
// forged header must not inject an IP into any admission decision.
// ─────────────────────────────────────────────────────────────────────────────

describe("trustedIngress boundary (rereview item 24)", () => {
  it("resolved routes default to 'direct' (fail-closed)", () => {
    const d = createFireRaidMiddleware(baseDeps({ routes: ROUTES }));
    expect(resolveRoutes(d)?.trustedIngress).toBe("direct");
  });

  it("an explicit 'cloudflare' declaration resolves through", () => {
    const d = createFireRaidMiddleware(
      baseDeps({ routes: { ...ROUTES, trustedIngress: "cloudflare" } })
    );
    expect(resolveRoutes(d)?.trustedIngress).toBe("cloudflare");
  });

  it("the middleware passes the header to verification ONLY under a declared cloudflare ingress", async () => {
    const seen: string[] = [];
    const makeDeps = (trusted: boolean): MiddlewareDeps =>
      baseDeps({
        routes: { ...ROUTES, trustedIngress: trusted ? "cloudflare" : "direct" },
        verification: {
          verificationMode: "host-owned" as const,
          verify: async (_p, input) => {
            seen.push(input.remoteIp ?? "<unset>");
            return true;
          },
        },
      });

    const run = async (deps: MiddlewareDeps) => {
      seen.length = 0;
      const sid = await (deps.session as ReferenceSessionAdapter).createSession();
      const cookie = await (deps.session as ReferenceSessionAdapter).sessionCookie(sid);
      const csrf = await makeCsrf(SECRET, sid);
      const res = await admitEvaluation(
        new Request("http://mw/api/submit", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie,
            "cf-connecting-ip": "203.0.113.7",
          },
          body: JSON.stringify({ csrf, form: { name: "A", email: "a@b.c" } }),
        }),
        { ...deps, labMode: false } as never,
        async () => SIGNUP_HTML
      );
      return res;
    };

    // direct (default): the forged header is INVISIBLE to verification.
    await run(makeDeps(false));
    expect(seen).toEqual(["<unset>"]);

    // cloudflare-declared: the header flows (the edge is trusted to have
    // overwritten it).
    await run(makeDeps(true));
    expect(seen).toEqual(["203.0.113.7"]);
  });
});
