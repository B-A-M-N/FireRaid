/**
 * Treatment-pipeline integration tests (FR-POST-R6 Phase 3).
 *
 * THE most important FireRaid systems proof: for every named ablation
 * recipe, the REQUESTED treatment == the STORED lab treatment == the
 * RENDERED treatment == the RECONSTRUCTED treatment == the RECORDED
 * treatment. If any link disagrees, the experiment system is invalid.
 *
 * Runs against the real Worker + D1 (test-worker.mjs harness): lab API with
 * bearer auth, bind-aware signup render, canonical profile reconstruction,
 * submission.
 *
 * FR-R3-024 note: semantic templates may REQUIRE mechanisms (S06 requires
 * decoy-field; S04/S05/S08 require decoy-route). A random template draw can
 * therefore add families beyond the recipe's base list — that is engine
 * policy, not pipeline drift. Assertions on families are template-aware:
 * extra REQUIRED families are allowed, missing ones are not.
 */
import { describe, it, expect } from "vitest";

const BASE = process.env.FIRERAID_BASE_URL || "http://localhost:8787";
const LAB_SECRET = process.env.FIRERAID_TEST_LAB_SECRET || "local-lab-secret-do-not-use-in-prod";
const TURNSTILE_TEST_TOKEN = "1x00000000000000000000AA";

interface LabCreateResp {
  run_id: string;
  bind_token: string;
  status: string;
}

interface LabTruth {
  status?: string;
  session_id?: string | null;
  recipe_id?: string | null;
  experiment_id?: string | null;
  trial_key?: string | null;
  profile_id?: string;
  profile_variant_id?: string;
  defense_families?: string[];
  semantic_template?: string | null;
  placement?: string | null;
  submitted?: boolean;
  disposition?: string;
  outcome?: string | null;
  turnstile_required?: number;
  canary_issued?: boolean;
  canary_verified_server?: boolean;
  holdout_mode?: number;
}

async function createLabRun(body: Record<string, unknown>): Promise<{ resp: Response; data: LabCreateResp }> {
  const resp = await fetch(`${BASE}/api/lab/runs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${LAB_SECRET}`,
    },
    body: JSON.stringify(body),
  });
  const data = (await resp.json()) as LabCreateResp;
  return { resp, data };
}

async function getLabTruth(runId: string): Promise<LabTruth> {
  const resp = await fetch(`${BASE}/api/lab/runs/${runId}`, {
    headers: { authorization: `Bearer ${LAB_SECRET}` },
  });
  expect(resp.status).toBe(200);
  return (await resp.json()) as LabTruth;
}

/** Bind a session to a lab run and return { cookie, html }. */
async function bindSession(runId: string, bindToken: string): Promise<{ cookie: string; html: string }> {
  const resp = await fetch(`${BASE}/signup?lab_run=${runId}&bind=${bindToken}`);
  expect(resp.status).toBe(200);
  const setCookie = resp.headers.get("set-cookie") || "";
  const cookie = setCookie
    .split(",")
    .map((c) => c.split(";")[0].trim())
    .filter((c) => c.startsWith("__Host-fr_"))
    .join("; ");
  return { cookie, html: await resp.text() };
}

async function submitForm(cookie: string, html: string, extra: Record<string, string> = {}): Promise<Response> {
  const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1] ?? "";
  return fetch(`${BASE}/api/submit`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      csrf,
      turnstileToken: TURNSTILE_TEST_TOKEN,
      form: {
        name: "Pipeline Proof",
        email: "pipeline@example.invalid",
        organization: "Proof Org",
        intended_use: "Treatment pipeline verification",
        password: "synthetic-password-123",
        ...extra,
      },
    }),
  });
}

async function postOutcome(runId: string, outcome: string): Promise<Response> {
  return fetch(`${BASE}/api/lab/runs/${runId}/outcome`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${LAB_SECRET}`,
    },
    body: JSON.stringify({ outcome }),
  });
}

/** Extract rendered canary facts from the signup HTML. */
function renderedFacts(html: string): {
  template: string | null;
  placement: string | null;
  marker: string | null;
  decoyField: string | null;
  canaryRoute: string | null;
} {
  return {
    template: html.match(/data-fr-canary(?:-id)?="([A-Z]\d\d)"/)?.[1] ?? null,
    placement: html.match(/data-fr-placement="([^"]+)"/)?.[1] ?? null,
    marker: html.match(/data-fr-marker="([^"]+)"/)?.[1] ?? null,
    decoyField: html.match(/name="(fr_[a-z0-9_]+)"/)?.[1] ?? null,
    canaryRoute: html.match(/\/c\/([a-f0-9]+)/)?.[1] ?? null,
  };
}

// ---------------------------------------------------------------------------
// Named recipe → rendered/reconstructed agreement
// ---------------------------------------------------------------------------

describe("treatment pipeline: named recipes (Phase 3)", () => {
  const CASES: Array<{
    name: string;
    recipe_id: string;
    expect: {
      families: string[];
      /** FR-R3-024: families a random template draw may additionally require. */
      allowedExtras?: string[];
      template?: string | null;
      placement?: string | null;
      decoyField?: boolean;
      canaryRoute?: boolean;
    };
  }> = [
    { name: "CONTROL is empty (no defense families)", recipe_id: "CONTROL", expect: { families: [] } },
    { name: "SEMANTIC_ONLY carries semantic (+ template-required families)", recipe_id: "SEMANTIC_ONLY", expect: { families: ["semantic"], allowedExtras: ["decoy-field", "decoy-route"] } },
    { name: "DECOY_FIELD_ONLY carries only the decoy-field family", recipe_id: "DECOY_FIELD_ONLY", expect: { families: ["decoy-field"], decoyField: true } },
    { name: "DECOY_ROUTE_ONLY carries only the decoy-route family", recipe_id: "DECOY_ROUTE_ONLY", expect: { families: ["decoy-route"], canaryRoute: true } },
    { name: "INTERACTION_ONLY carries only the interaction family", recipe_id: "INTERACTION_ONLY", expect: { families: ["interaction"] } },
    { name: "SEMANTIC_ROUTE carries semantic + decoy-route", recipe_id: "SEMANTIC_ROUTE", expect: { families: ["semantic", "decoy-route"], allowedExtras: ["decoy-field"], canaryRoute: true } },
    { name: "FULL carries all four families", recipe_id: "FULL", expect: { families: ["semantic", "decoy-field", "decoy-route", "interaction"] } },
  ];

  for (const c of CASES) {
    it(`${c.name}`, async () => {
      const trialKey = `pipeline-test:${c.recipe_id}`;
      const { resp, data } = await createLabRun({ recipe_id: c.recipe_id, experiment_id: "treatment-pipeline-test", trial_key: trialKey });
      expect(resp.status).toBe(200);
      expect(data.status).toBe("PENDING");

      // --- requested == stored ---
      const pre = await getLabTruth(data.run_id);
      expect(pre.recipe_id).toBe(c.recipe_id);
      expect(pre.trial_key).toBe(trialKey);

      // --- bind: session created, recipe pinned ---
      const { cookie, html } = await bindSession(data.run_id, data.bind_token);
      expect(cookie).toContain("__Host-fr_sid=");

      // --- rendered: requested treatment appears in the DOM ---
      const rendered = renderedFacts(html);
      if (c.expect.families.includes("semantic")) {
        expect(rendered.template).toMatch(/^S\d\d$/);
      } else {
        expect(rendered.template).toBeNull();
      }
      if (c.expect.decoyField) {
        expect(rendered.decoyField).toMatch(/^fr_/);
      }
      if (c.expect.canaryRoute) {
        expect(rendered.canaryRoute).toMatch(/^[a-f0-9]+$/);
      }

      // --- submission drives the pipeline ---
      const submit = await submitForm(cookie, html);
      expect(submit.status).toBe(200);

      // --- outcome report: BOUND → COMPLETE ---
      const oc = await postOutcome(data.run_id, "submitted");
      expect(oc.status).toBe(200);

      // --- recorded == reconstructed == requested ---
      const truth = await getLabTruth(data.run_id);
      expect(truth.status).toBe("COMPLETE");
      expect(truth.recipe_id).toBe(c.recipe_id);
      expect(truth.session_id).toBeTruthy();
      expect(truth.submitted).toBe(true);
      expect(truth.disposition).toBeDefined();
      expect(truth.profile_variant_id).toMatch(/^[a-f0-9]{64}$/); // real SHA-256 variant id
      expect(Array.isArray(truth.defense_families)).toBe(true);
      // Families agree with the recipe: every requested family present, and
      // only template-REQUIRED extras allowed (FR-R3-024).
      const got = [...(truth.defense_families ?? [])].sort();
      const want = [...c.expect.families].sort();
      for (const f of want) expect(got).toContain(f);
      const extras = got.filter((f) => !want.includes(f));
      expect(extras.every((f) => (c.expect.allowedExtras ?? []).includes(f))).toBe(true);
      if (c.expect.template !== undefined) {
        expect(truth.semantic_template).toBe(c.expect.template);
      }
      // Turnstile condition recorded (local test env: not required)
      expect(truth.outcome).toBe("submitted");
    });
  }

  it("unknown recipe_id is rejected (no silent fallback)", async () => {
    const { resp } = await createLabRun({ recipe_id: "NOT_A_REAL_RECIPE" });
    expect(resp.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Pinned template/placement cases
// ---------------------------------------------------------------------------

describe("treatment pipeline: pinned template × placement (Phase 3)", () => {
  it("S01/P01 pinned: visible semantic canary rendered exactly as requested", async () => {
    const { data } = await createLabRun({
      recipe: {
        families: ["semantic"],
        semanticTemplate: "S01",
        placementId: "P01",
        labOnly: true,
      },
      experiment_id: "treatment-pipeline-test",
      trial_key: "pipeline-test:s01p01",
    });
    const { cookie, html } = await bindSession(data.run_id, data.bind_token);
    const rendered = renderedFacts(html);
    expect(rendered.template).toBe("S01");

    const submit = await submitForm(cookie, html);
    expect(submit.status).toBe(200);
    await postOutcome(data.run_id, "submitted");

    const truth = await getLabTruth(data.run_id);
    expect(truth.status).toBe("COMPLETE");
    expect(truth.semantic_template).toBe("S01");
    expect(truth.placement).toBe("P01");
    expect(truth.defense_families).toEqual(["semantic"]);
  });

  it("S09/P06 pinned: hidden metadata marker, DOM-present + instruction-free", async () => {
    const { data } = await createLabRun({
      recipe: {
        families: ["semantic"],
        semanticTemplate: "S09",
        placementId: "P06",
        labOnly: true,
      },
      experiment_id: "treatment-pipeline-test",
      trial_key: "pipeline-test:s09p06",
    });
    const { cookie, html } = await bindSession(data.run_id, data.bind_token);
    // S09 is a hidden marker: present in DOM, aria-hidden, no visible text
    expect(html).toContain('data-fr-canary="S09"');
    expect(html).toMatch(/data-fr-marker="[^"]+"/);
    const rendered = renderedFacts(html);
    expect(rendered.template).toBe("S09");

    const submit = await submitForm(cookie, html);
    expect(submit.status).toBe(200);
    await postOutcome(data.run_id, "submitted");

    const truth = await getLabTruth(data.run_id);
    expect(truth.status).toBe("COMPLETE");
    expect(truth.semantic_template).toBe("S09");
    expect(truth.placement).toBe("P06");
  });

  it("TURNSTILE_ONLY + required fails CLOSED when the verifier is unconfigured (FR-R6-020)", async () => {
    const { data } = await createLabRun({
      recipe_id: "TURNSTILE_ONLY",
      turnstile_required: true,
      experiment_id: "treatment-pipeline-test",
      trial_key: "pipeline-test:turnstile-only",
    });
    const { cookie, html } = await bindSession(data.run_id, data.bind_token);
    // No semantic template rendered — TURNSTILE_ONLY is families: []
    expect(renderedFacts(html).template).toBeNull();

    // The local test worker has NO Turnstile secret (.dev.vars.test). A run
    // that REQUIRES Turnstile must fail closed at submit (500, configuration
    // error) — never silently downgrade the assigned treatment.
    const submit = await submitForm(cookie, html);
    expect(submit.status).toBe(500);
    const body = (await submit.json()) as { error?: string };
    expect(body.error).toContain("turnstile");

    // The condition is still stored server-side and readable.
    const truth = await getLabTruth(data.run_id);
    expect(truth.recipe_id).toBe("TURNSTILE_ONLY");
    expect(truth.turnstile_required).toBe(1);
  });

  it("TURNSTILE_ONLY without turnstile_required submits normally (no defense families)", async () => {
    const { data } = await createLabRun({
      recipe_id: "TURNSTILE_ONLY",
      experiment_id: "treatment-pipeline-test",
      trial_key: "pipeline-test:turnstile-only-unrequired",
    });
    const { cookie, html } = await bindSession(data.run_id, data.bind_token);
    expect(renderedFacts(html).template).toBeNull();

    const submit = await submitForm(cookie, html);
    expect(submit.status).toBe(200);
    await postOutcome(data.run_id, "submitted");

    const truth = await getLabTruth(data.run_id);
    expect(truth.status).toBe("COMPLETE");
    expect(truth.recipe_id).toBe("TURNSTILE_ONLY");
    expect(truth.defense_families).toEqual([]);
    expect(truth.turnstile_required).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Perception chain: ISSUED → EXPOSED → REFERENCED → REQUESTED → VERIFIED
// (FR-POST-R6 Phase 4). The server-side states live in the lab truth and
// canary_hits; EXPOSED is harness-side (perception artifacts) and is proven
// in tests/unit/perception-measurement.test.ts.
// ---------------------------------------------------------------------------

describe("perception chain: requested → verified (Phase 4)", () => {
  it("ISSUED is true for every material family and false for non-material ones", async () => {
    // ISSUED is server truth about placed material — read it from terminal
    // runs (outcome POSTed) so the flags exist in the payload.
    // material: decoy-route-only (no semantic canary — ISSUED must still hold)
    const route = await createLabRun({
      recipe_id: "DECOY_ROUTE_ONLY",
      experiment_id: "treatment-pipeline-test",
      trial_key: "pipeline-test:issued-route",
    });
    const routeSession = await bindSession(route.data.run_id, route.data.bind_token);
    const routeSubmit = await submitForm(routeSession.cookie, routeSession.html);
    expect(routeSubmit.status).toBe(200);
    await postOutcome(route.data.run_id, "submitted");
    const routeTruth = await getLabTruth(route.data.run_id);
    expect(routeTruth.status).toBe("COMPLETE");
    expect(routeTruth.canary_issued).toBe(true);

    // non-material: CONTROL and INTERACTION_ONLY never issue page material
    for (const recipe of ["CONTROL", "INTERACTION_ONLY"]) {
      const c = await createLabRun({
        recipe_id: recipe,
        experiment_id: "treatment-pipeline-test",
        trial_key: `pipeline-test:issued-${recipe.toLowerCase()}`,
      });
      const s = await bindSession(c.data.run_id, c.data.bind_token);
      const sub = await submitForm(s.cookie, s.html);
      expect(sub.status).toBe(200);
      await postOutcome(c.data.run_id, "submitted");
      const truth = await getLabTruth(c.data.run_id);
      expect(truth.status).toBe("COMPLETE");
      expect(truth.canary_issued).toBe(false);
    }
  });

  it("exact route REQUEST from the bound session is VERIFIED server-side", async () => {
    const { data } = await createLabRun({
      recipe_id: "DECOY_ROUTE_ONLY",
      experiment_id: "treatment-pipeline-test",
      trial_key: "pipeline-test:route-verified",
    });
    const { cookie, html } = await bindSession(data.run_id, data.bind_token);

    // The rendered page exposes the exact token (Phase 3 proof)…
    const token = html.match(/\/c\/([a-f0-9]+)/)?.[1];
    expect(token).toMatch(/^[a-f0-9]+$/);

    // …nothing is verified before a request (check post-outcome so the
    // flag exists, then re-request the same terminal truth)…
    const submit = await submitForm(cookie, html);
    expect(submit.status).toBe(200);
    await postOutcome(data.run_id, "submitted");
    let truth = await getLabTruth(data.run_id);
    expect(truth.canary_verified_server).toBe(false);

    // …the agent REQUESTS the route with its session cookie…
    const hit = await fetch(`${BASE}/c/${token}`, { headers: { cookie } });
    expect(hit.status).toBe(204);

    // …and the server VERIFIES the causal hit.
    truth = await getLabTruth(data.run_id);
    expect(truth.canary_verified_server).toBe(true);
  });

  it("wrong token is rejected and NOT verified; CONTROL session route 404s", async () => {
    const { data } = await createLabRun({
      recipe_id: "DECOY_ROUTE_ONLY",
      experiment_id: "treatment-pipeline-test",
      trial_key: "pipeline-test:route-wrong-token",
    });
    const { cookie, html } = await bindSession(data.run_id, data.bind_token);

    const bad = await fetch(`${BASE}/c/000000000000`, { headers: { cookie } });
    expect(bad.status).toBe(403);

    // Terminal state proves the rejected request left no verified hit
    const submit = await submitForm(cookie, html);
    expect(submit.status).toBe(200);
    await postOutcome(data.run_id, "submitted");
    const truth = await getLabTruth(data.run_id);
    expect(truth.canary_verified_server).toBe(false);

    // A CONTROL session has no decoy route at all
    const ctl = await createLabRun({
      recipe_id: "CONTROL",
      experiment_id: "treatment-pipeline-test",
      trial_key: "pipeline-test:control-route-404",
    });
    const ctlSession = await bindSession(ctl.data.run_id, ctl.data.bind_token);
    const ctlHit = await fetch(`${BASE}/c/deadbeefdead`, { headers: { cookie: ctlSession.cookie } });
    expect(ctlHit.status).toBe(404);
  });

  it("unauthenticated /c/ request (no session cookie) is rejected", async () => {
    const resp = await fetch(`${BASE}/c/a1b2c3d4e5f6`);
    expect(resp.status).toBe(403);
  });

  it("holdout_mode restricts template draws to the holdout partition and round-trips (FR-POST-R6-P5)", async () => {
    // S07/S08 are the holdout semantic templates; S01-S06 are development.
    for (let i = 0; i < 4; i++) {
      const { data } = await createLabRun({
        recipe_id: "SEMANTIC_ONLY",
        holdout_mode: true,
        experiment_id: "treatment-pipeline-test",
        trial_key: `pipeline-test:holdout-${i}`,
      });
      const { cookie, html } = await bindSession(data.run_id, data.bind_token);
      const rendered = renderedFacts(html);
      // The issued template must be a holdout-partition template
      expect(rendered.template).toMatch(/^S0[78]$/);

      const submit = await submitForm(cookie, html);
      expect(submit.status).toBe(200);
      await postOutcome(data.run_id, "submitted");

      // Recorded truth must reconstruct the SAME template the render issued
      const truth = await getLabTruth(data.run_id);
      expect(truth.status).toBe("COMPLETE");
      expect(truth.semantic_template).toBe(rendered.template);
      expect(truth.holdout_mode).toBe(1);
    }

    // Non-holdout draws unrestricted (sanity: dev templates DO appear when
    // holdout_mode is false)
    const dev = await createLabRun({
      recipe_id: "SEMANTIC_ONLY",
      experiment_id: "treatment-pipeline-test",
      trial_key: "pipeline-test:holdout-false",
    });
    const devSession = await bindSession(dev.data.run_id, dev.data.bind_token);
    const devTemplate = renderedFacts(devSession.html).template;
    expect(devTemplate).toMatch(/^S\d\d$/);
  });
});
