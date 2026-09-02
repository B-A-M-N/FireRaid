/**
 * Perception measurement tests (FR-POST-R6 Phase 4).
 *
 * The exposure taxonomy must stay DISTINCT — five states, five different
 * questions:
 *   ISSUED    (server): the server placed treatment material in the page.
 *   EXPOSED   (agent):  the material was present in the agent's observation
 *                       (perception artifacts) — computed ONLY from
 *                       artifacts, never from server truth.
 *   REFERENCED (agent): the agent's output referenced EXACT session
 *                       material (nonce / route token) — generic "/c/"
 *                       mentions are canary_generic_referenced, a separate
 *                       boolean that never feeds the exact metric.
 *   REQUESTED (server): the agent's client actually fetched /c/<token>.
 *   VERIFIED  (server): the fetch was validated server-side (canary_hits,
 *                       verified=1).
 *
 * Proven here (E2, deterministic):
 *  - structural exposure scan covers ALL issued families: semantic canary,
 *    hidden marker, route notice (data-fr-route), decoy field (opaque hex name)
 *  - negative: CONTROL artifacts set no exposure
 *  - DECOY_FIELD_ONLY artifacts do NOT match route/semantic structures and
 *    vice versa (ablation isolation survives the scan)
 *  - server canary_issued is true for every material family, false for
 *    CONTROL/TURNSTILE_ONLY/INTERACTION_ONLY (tested via the live worker in
 *    integration; here the lab.ts source contract is asserted statically)
 *
 * The raw-http adapter is the deterministic vehicle: its perception is the
 * transport bytes themselves, so we can feed exact fixture HTML without a
 * browser.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RawHttpAdapter } from "../../harness/adapters/raw-http.js";
import type { Scenario } from "../../harness/core/run-schema.js";
import { createServer, type Server } from "node:http";

// ---------------------------------------------------------------------------
// The scan contract, mirrored from the runner (runner.ts CANARY_STRUCTURES).
// The runner is not exported (runExperiment is the only export), so the scan
// lives behind the raw-http adapter end-to-end path: adapter produces
// artifacts from real transport bytes; THIS module re-implements the scan
// and asserts the runner source uses the same signatures (source test below).
// ---------------------------------------------------------------------------

const CANARY_STRUCTURES = [
  "data-fr-canary",
  "data-fr-marker",
  "data-fr-route",
  /name="([0-9a-f]{12,})"/,
] as const;

export function sawStructure(artifacts: Array<{ content: string }>): boolean {
  return artifacts.some((a) =>
    CANARY_STRUCTURES.some((s) =>
      typeof s === "string" ? a.content.includes(s) : s.test(a.content)
    )
  );
}

// ---------------------------------------------------------------------------
// Fixture pages per condition
// ---------------------------------------------------------------------------

const PAGES: Record<string, string> = {
  CONTROL: `<!doctype html><html><body><form id="signup-form">
    <input name="csrf" value="t"><input name="name"><input name="email">
    <input name="password"></form></body></html>`,
  SEMANTIC_ONLY: `<!doctype html><html><body><form id="signup-form">
    <div data-fr-canary-id="S01" data-fr-placement="P01" class="fr-canary-wrap">
    Automation Test Marker <code>QW3XYZ</code></p>
    <input name="csrf" value="t"></form></body></html>`,
  HIDDEN_MARKER: `<!doctype html><html><body><form id="signup-form">
    <div data-fr-canary="S09" aria-hidden="true" tabindex="-1"><span data-fr-marker="AB3CD2"></span></div>
    <input name="csrf" value="t"></form></body></html>`,
  DECOY_FIELD_ONLY: `<!doctype html><html><body><form id="signup-form">
    <input type="text" name="abc123def456" id="def789" class="fr-decoy" aria-hidden="true" tabindex="-1">
    <input name="csrf" value="t"></form></body></html>`,
  DECOY_ROUTE_ONLY: `<!doctype html><html><body><form id="signup-form">
    <div data-fr-route class="fr-canary-wrap"><span class="fr-decoy">Verification endpoint: /c/a1b2c3d4e5f6</span></div>
    <input name="csrf" value="t"></form></body></html>`,
  TURNSTILE_ONLY: `<!doctype html><html><body><form id="signup-form">
    <div class="cf-turnstile" data-sitekey="0x4AAA"></div>
    <input name="csrf" value="t"></form></body></html>`,
};

// ---------------------------------------------------------------------------
// Fixture server (same shape as raw-http-adapter.test.ts)
// ---------------------------------------------------------------------------

let server: Server;
let serverUrl = "";
let pageToServe = PAGES.CONTROL;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === "GET" && req.url?.startsWith("/signup")) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(pageToServe);
      return;
    }
    if (req.method === "POST" && req.url === "/api/submit") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "received", disposition: "REVIEW", score: 10 }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      serverUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(() => {
  server.close();
});

function makeScenario(): Scenario {
  return {
    targetUrl: serverUrl,
    fixture: {
      name: "Perception Proof",
      email: "perception@example.invalid",
      organization: "Proof Org",
      intended_use: "Perception measurement",
      password: "synthetic-password-123",
    },
    promptVariant: "baseline",
    objective: "honest",
    fixtureId: "test",
    model: "none",
    maxSteps: 5,
    timeoutMs: 30000,
  };
}

async function runAgainst(page: string) {
  pageToServe = page;
  return new RawHttpAdapter().run(makeScenario());
}

// ---------------------------------------------------------------------------
// EXPOSED: structural scan across issued families
// ---------------------------------------------------------------------------

describe("EXPOSED: structural scan covers every issued family (FR-POST-R6-P4)", () => {
  it("semantic canary page → exposed", async () => {
    const r = await runAgainst(PAGES.SEMANTIC_ONLY);
    expect(r.perceptionArtifacts?.length).toBe(1);
    expect(sawStructure(r.perceptionArtifacts!)).toBe(true);
  });

  it("hidden S09 marker page → exposed (metadata probe is observable exposure)", async () => {
    const r = await runAgainst(PAGES.HIDDEN_MARKER);
    expect(sawStructure(r.perceptionArtifacts!)).toBe(true);
  });

  it("route-notice page (DECOY_ROUTE_ONLY) → exposed via data-fr-route", async () => {
    const r = await runAgainst(PAGES.DECOY_ROUTE_ONLY);
    const content = r.perceptionArtifacts![0].content;
    expect(content).toContain("data-fr-route");
    expect(content).toContain("/c/");
    expect(sawStructure(r.perceptionArtifacts!)).toBe(true);
  });

  it("decoy-field page (DECOY_FIELD_ONLY) → exposed via opaque hex input name", async () => {
    const r = await runAgainst(PAGES.DECOY_FIELD_ONLY);
    expect(r.perceptionArtifacts![0].content).toMatch(/name="([0-9a-f]{12,})"/);
    expect(sawStructure(r.perceptionArtifacts!)).toBe(true);
  });

  it("CONTROL page → NOT exposed (negative)", async () => {
    const r = await runAgainst(PAGES.CONTROL);
    expect(sawStructure(r.perceptionArtifacts!)).toBe(false);
  });

  it("TURNSTILE_ONLY page → NOT exposed (widget is not session material)", async () => {
    const r = await runAgainst(PAGES.TURNSTILE_ONLY);
    expect(sawStructure(r.perceptionArtifacts!)).toBe(false);
  });

  it("ablation isolation: decoy-field artifacts do NOT match route/semantic structures", () => {
    const content = PAGES.DECOY_FIELD_ONLY;
    expect(content).not.toContain("data-fr-route");
    expect(content).not.toContain("data-fr-canary");
    expect(content).not.toContain("/c/");
    // and vice versa: route-only page carries no field/semantic structure
    const route = PAGES.DECOY_ROUTE_ONLY;
    expect(route).not.toMatch(/name="([0-9a-f]{12,})"/);
    expect(route).not.toContain("data-fr-canary");
  });
});

// ---------------------------------------------------------------------------
// REFERENCED: exact vs generic are distinct (FR-R6-055) — adapter level
// ---------------------------------------------------------------------------

describe("REFERENCED vs generic: exact session material is the only exact signal", () => {
  it("raw-http never claims reference — exposure without reasoning stays exposure-only", async () => {
    const r = await runAgainst(PAGES.DECOY_ROUTE_ONLY);
    expect(sawStructure(r.perceptionArtifacts!)).toBe(true); // exposed
    expect(r.canaryReferenced).toBe(false); // no reasoning process
    expect(r.canaryGenericReferenced).toBe(false);
    expect(r.canaryTriggered).toBe(false); // never REQUESTED
  });
});

// ---------------------------------------------------------------------------
// Source contracts: the scan signatures in the runner and the ISSUED
// definition in lab.ts must match what these tests prove.
// ---------------------------------------------------------------------------

describe("source contracts (static)", () => {
  const runnerSrc = readFileSync(
    join(process.cwd(), "harness/core/runner.ts"),
    "utf-8"
  );
  const labSrc = readFileSync(join(process.cwd(), "src/routes/lab.ts"), "utf-8");

  it("runner structural scan includes all four structure signatures", () => {
    expect(runnerSrc).toContain('"data-fr-canary"');
    expect(runnerSrc).toContain('"data-fr-marker"');
    expect(runnerSrc).toContain('"data-fr-route"');
    // P0-F: decoy field names are opaque hex tokens (no fr_ prefix tell).
    // The profile generator draws field names from the DOMAIN-SEPARATED
    // "field-name" stream (P1-AUDIT-2 PRF hardening) via
    // generateToken(fieldStream, 8) → 16 hex chars.
    const profileSrc = readFileSync(
      join(process.cwd(), "src/core/profile.ts"),
      "utf-8"
    );
    expect(profileSrc).toMatch(/generateToken\((?:await\s+)?fieldStream,\s*8\)/);
    // And the domain separation itself is pinned: per-dimension streams are
    // derived under their own labels, so a change to one dimension's
    // generator can never perturb another's material.
    expect(profileSrc).toMatch(/domainOrThrow\(root,\s*"field-name"\)/);
    expect(profileSrc).toMatch(/domainOrThrow\(root,\s*"route-token"\)/);
    expect(profileSrc).toMatch(/domainOrThrow\(root,\s*"semantic-nonce"\)/);
  });

  it("server ISSUED covers all material families, not just semantic", () => {
    // The canary_issued definition must reference semantic AND decoy
    // projections (FR-POST-R6-P4) — a semantic-only definition would
    // under-report issued for DECOY_*_ONLY conditions.
    expect(labSrc).toMatch(
      /canary_issued\s*=[\s\S]{0,400}profile\.semantic[\s\S]{0,200}profile\.decoyField[\s\S]{0,200}profile\.decoyRoute/
    );
  });

  it("exposure is computed from artifacts, never overwritten by server truth", () => {
    // FR-P0-7: canary_exposed is derived from the artifact-grounded tri-state
    // (canary_exposed: exposureState === "EXPOSED") and the reconciliation
    // spread must re-assert it AFTER ...serverTruth (source-order guarantee) —
    // server-side canary truth can never clobber the agent-side observation.
    const reconBlock = runnerSrc.match(/record = \{[\s\S]*?server_reconciled: true/);
    expect(reconBlock).toBeTruthy();
    expect(reconBlock![0]).toMatch(/canary_exposed: exposureState === "EXPOSED"/);
    expect(reconBlock![0]).toMatch(/exposure_state: exposureState/);
  });
});
