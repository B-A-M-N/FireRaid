#!/usr/bin/env node
/**
 * P1-24 / P1-AUDIT-2 (P0-2) — Ledger proof: CONTROL vs DEFENDED arms.
 *
 * The audit: the prior version claimed "CONTROL vs FULL" but ran ONE random
 * production profile and one benign registration — proving only that the
 * middleware/origin seam agrees with the ledger, not that the defense
 * blocks anything. This gate now runs BOTH ARMS through the same middleware
 * + ordinary upstream:
 *
 *   CONTROL  (families: [])      → a clean submission MUST register (the
 *                                  ledger gains the account). Guards against
 *                                  a defense that breaks legitimate signup.
 *   INTERACTION_ONLY             → scripted telemetry-free submission MUST
 *                                  still register (interaction evidence
 *                                  alone is not disqualifying for a benign
 *                                  shape).
 *   FULL (all families)          → a DIRECT-FILL bot submission (form
 *                                  filled without interaction, decoy field
 *                                  populated omnivorously, no telemetry)
 *                                  MUST NOT reach the ledger.
 *
 * PRIMARY assertion, per arm: the upstream ledger contains the synthetic
 * account IFF the middleware forwarded (upstreamCreated) — and for the
 * FULL bot arm, that the ledger stays EMPTY.
 *
 * Run: node --import tsx scripts/ledger-proof.mjs
 * Exit: 0 = proof holds, 1 = fail.
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";

const UPSTREAM_PORT = 5051;
const MIDDLEWARE_PORT = 5052;
const SECRET = "x".repeat(64); // 64-char test secret
const VERSION = 1;

async function startUpstream() {
  const proc = spawn(process.execPath, ["scripts/ledger-upstream.mjs", String(UPSTREAM_PORT)], {
    cwd: process.cwd(),
    stdio: ["ignore", "inherit", "inherit"],
  });
  // wait for health
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://localhost:${UPSTREAM_PORT}/signup`);
      if (r.ok) return proc;
    } catch {
      // not up yet — poll again
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("upstream did not start");
}

// Hard self-timeout so a hang surfaces as a clear FAIL, not a 60s spinner.
const HARD = setTimeout(() => { console.error("ledger proof HARD TIMEOUT"); process.exit(1); }, 30000);

async function main() {
  const upstream = await startUpstream();
  console.log("[proof] upstream up");

  // Dynamically import the compiled host-adapter middleware. The repo runs
  // TS via tsx; we import the source directly (tsx resolves .ts).
  const {
    admit,
    ReferenceSessionAdapter,
    referenceInject,
    ReferenceVerificationAdapter,
    ReferenceTelemetryAdapter,
    ReferenceEnforcementAdapter,
    ReferenceCanaryStore,
  } = await import("../src/host-adapter/index.ts");

  // Secret signs the session cookie + CSRF token (P1-AUDIT-2). Must match the
  // deps.secret below so the GET-issued cookie/token verify on POST.
  const session = new ReferenceSessionAdapter(SECRET);
  const verification = new ReferenceVerificationAdapter();
  const telemetry = new ReferenceTelemetryAdapter();
  const enforcement = new ReferenceEnforcementAdapter();
  const canaryStore = new ReferenceCanaryStore();

  const deps = {
    secret: SECRET,
    version: VERSION,
    upstreamRegisterUrl: `http://localhost:${UPSTREAM_PORT}/api/register`,
    session,
    render: { inject: (html, profile, csrf, lab) => referenceInject(html, profile, csrf, lab) },
    verification,
    telemetry,
    enforcement,
    canaryStore,
    labMode: false,
  };

  const htmlLoader = async () => {
    const r = await fetch(`http://localhost:${UPSTREAM_PORT}/signup`);
    return r.text();
  };

  // ── Middleware http proxy ────────────────────────────────────────────────
  // P0-2: each arm drives its OWN condition. admit() reads deps.recipe at
  // request time, so arms swap a module-level `current` deps object (the
  // proof is serial — no interleaved arms to race).
  let current = deps;
  const mw = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${MIDDLEWARE_PORT}`);
    // lift method + body into a fresh Request for admit()
    const buf = req.method === "GET" ? undefined : await new Promise((r) => {
      let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => r(Buffer.from(d)));
    });
    const fetchReq = new Request(`http://localhost:${MIDDLEWARE_PORT}${url.pathname}${url.search}`, {
      method: req.method,
      headers: { cookie: req.headers.cookie ?? "", "content-type": req.headers["content-type"] ?? "application/json" },
      body: buf,
    });
    const result = await admit(fetchReq, current, htmlLoader);
    if (result.kind === "get") {
      res.writeHead(200, { "content-type": "text/html", "set-cookie": result.setCookie ?? "" });
      res.end(result.html);
    } else if (result.kind === "canary-verified") {
      res.writeHead(204);
      res.end();
    } else if (result.kind === "ingest") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ received: result.received, acceptedThrough: result.acceptedThrough }));
    } else if (result.kind === "admit") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "received", disposition: result.disposition, upstreamCreated: result.upstreamCreated }));
    } else {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "denied", disposition: result.disposition }));
    }
  });
  await new Promise((r) => mw.listen(MIDDLEWARE_PORT, r));
  console.log("[proof] middleware up");

  // ── Drive ONE registration PER ARM through the middleware ───────────────
  const BASE = `http://localhost:${MIDDLEWARE_PORT}`;

  const armDeps = (recipe) => ({
    ...deps,
    recipe, // P0-2: the arm's EXPLICIT condition — not one random profile
  });

  /** Start an arm: fresh session, GET signup (injects that arm's artifacts).
   * The mw server reads deps.recipe per-request from the module-level `current`
   * slot, so each arm sets it before driving traffic. */
  const startArm = async (recipe) => {
    current = armDeps(recipe);
    const getResp = await fetch(`${BASE}/signup`);
    const cookie = getResp.headers.get("set-cookie") ?? "";
    const html = await getResp.text();
    const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1] ?? "";
    return { cookie, html, csrf };
  };

  /** Submit one arm's form, then read the LEDGER (read-only probe). Returns
   * everything the assertions need. ONE POST per account identity — a second
   * POST would hit duplicate-email rejection and muddy upstreamCreated. */
  const submitArm = async (arm, form, eventBatch) => {
    const regResp = await fetch(`${BASE}/signup`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: arm.cookie },
      body: JSON.stringify({ csrf: arm.csrf, form, ...(eventBatch ? { eventBatch } : {}) }),
    });
    const regJson = await regResp.json();
    // Read-only ledger probe (the prior probe POSTed and MUTATED).
    const ledgerResp = await fetch(
      `http://localhost:${UPSTREAM_PORT}/api/ledger?email=${encodeURIComponent(form.email)}`
    );
    const ledgerJson = await ledgerResp.json();
    return {
      disposition: regJson.disposition,
      upstreamCreated: regJson.upstreamCreated === true,
      ledgerHasAccount: ledgerJson.exists === true,
    };
  };

  /** Convenience: start + submit in one step (arms that need no page pre-read). */
  const runArm = async (recipe, form, eventBatch) => {
    const arm = await startArm(recipe);
    return submitArm(arm, form, eventBatch);
  };

  let pass = true;
  const lines = [];

  // ARM 1 — CONTROL: no defense. A clean submission MUST register.
  {
    const r = await runArm({ families: [] }, {
      name: "Control Human",
      email: "control-arm@example.invalid",
      password: "synthetic-password-123",
    });
    lines.push(`[CONTROL] disposition=${r.disposition} upstreamCreated=${r.upstreamCreated} ledger=${r.ledgerHasAccount}`);
    if (r.disposition !== "ACCEPT") { pass = false; lines.push("FAIL: CONTROL submission was not ACCEPT"); }
    if (!r.ledgerHasAccount) { pass = false; lines.push("FAIL: CONTROL did NOT create an upstream account"); }
  }

  // ARM 2 — INTERACTION_ONLY: benign humanish telemetry → still registers.
  {
    const events = [];
    let seq = 0, dt = 0;
    for (const field of ["name", "email", "password"]) {
      dt += 400; events.push({ seq: ++seq, dt, kind: "focus", target: field });
      dt += 300; events.push({ seq: ++seq, dt, kind: "key", target: field });
      dt += 200; events.push({ seq: ++seq, dt, kind: "input", target: field });
    }
    dt += 500; events.push({ seq: ++seq, dt, kind: "submit_attempt" });
    const r = await runArm(
      { families: ["interaction"] },
      { name: "Interaction Human", email: "interaction-arm@example.invalid", password: "synthetic-password-123" },
      events
    );
    lines.push(`[INTERACTION_ONLY] disposition=${r.disposition} upstreamCreated=${r.upstreamCreated} ledger=${r.ledgerHasAccount}`);
    if (r.ledgerHasAccount !== true) { pass = false; lines.push("FAIL: humanish INTERACTION_ONLY submission did not register (legit-user FP)"); }
  }

  // ARM 3 — FULL + direct-fill bot: omnivorous fill, NO interaction, decoy
  // populated. The defense MUST NOT forward this submission: the populated
  // decoy (DECOY_FIELD_POPULATED, class B, weight 60) alone clears the
  // default policy's review threshold (50) → REVIEW → deny. Scoring math,
  // not a hope: one POST, assertions on that POST.
  {
    const recipe = { families: ["decoy-field", "decoy-route", "interaction"] };
    // Learn the decoy field name from the injected page WITHOUT submitting —
    // the prior throwaway POST scored ACCEPT (score 0) and REGISTERED the
    // bot's email, so the real bot POST then hit duplicate-email rejection.
    const probe = await startArm(recipe);
    // The reference renderer's decoy is an offscreen input named fr_*.
    const decoyField = probe.html.match(/name="(fr_[a-f0-9]+)"/)?.[1];
    if (!decoyField) {
      pass = false;
      lines.push("FAIL: FULL arm drew no decoy field — bot shape not exercisable");
    } else {
      // ONE POST: omnivorous bot fills every writable field, including the
      // decoy, with zero telemetry events.
      const r = await submitArm(probe, {
        name: "Bot Direct-Fill",
        email: "bot-direct-fill@example.invalid",
        password: "synthetic-password-123",
        [decoyField]: "bot-fills-everything",
      });
      lines.push(`[FULL bot direct-fill] decoy=${decoyField} disposition=${r.disposition} upstreamCreated=${r.upstreamCreated} ledger=${r.ledgerHasAccount}`);
      if (r.disposition === "ACCEPT") {
        pass = false;
        lines.push("FAIL: direct-fill bot with populated decoy scored ACCEPT (decoy evidence ignored)");
      }
      if (r.ledgerHasAccount) {
        pass = false;
        lines.push("FAIL: direct-fill bot with populated decoy reached the upstream ledger");
      }
    }
  }

  console.log(lines.join("\n"));
  mw.close();
  upstream.kill("SIGTERM");
  clearTimeout(HARD);
  console.log(pass ? "\nLEDGER PROOF: PASS" : "\nLEDGER PROOF: FAIL");
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error("ledger proof error:", err);
  process.exit(1);
});
