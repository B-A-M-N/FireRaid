#!/usr/bin/env node
/**
 * P1-24 / P1-AUDIT-2 (P0-2) — Ledger proof: CONTROL vs DEFENDED arms.
 *
 * The audit: the prior version claimed "CONTROL vs FULL" but ran ONE random
 * production profile and one benign registration — proving only that the
 * middleware/origin seam agrees with the ledger, not that the defense
 * blocks anything. This gate runs FOUR ARMS through the same middleware +
 * ordinary upstream:
 *
 *   CONTROL             (families: []) → a clean submission MUST register
 *                         (the ledger gains the account). Guards against a
 *                         defense that breaks legitimate signup.
 *   INTERACTION_ONLY    → scripted humanish telemetry MUST still register
 *                         (interaction evidence alone is not disqualifying).
 *   PRODUCTION_DEFAULT  → the REAL production random composition (no recipe
 *                         override — the deployable config) driven TWICE:
 *                         (a) a clean humanish submission MUST register;
 *                         (b) an omnivorous direct-fill bot MUST NOT reach
 *                         the ledger whenever the arm drew a decoy field
 *                         (P02/P03/P04 composition guarantees one trap —
 *                         the bot's omnivorous fill exercises whichever
 *                         trap the session actually drew).
 *   FULL (evaluation)   → the explicit full recipe + direct-fill bot, the
 *                         historical deterministic arm.
 *
 * The bot is OMNIVOROUS: it fills every writable form field it can see in
 * the served HTML (the strategy the behavior actually models) — so it works
 * whatever field names the randomized profile issued, hex-named decoy or
 * not. No stale fr_* regex: the proof reads the SERVED PAGE, not a
 * signature the opacity work removed.
 *
 * PRIMARY assertion, per arm: the upstream ledger contains the synthetic
 * account IFF the middleware forwarded — and for bot arms, that a populated
 * trap keeps the ledger EMPTY.
 *
 * Run: npm run test:ledger-proof
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
const HARD = setTimeout(() => { console.error("ledger proof HARD TIMEOUT"); process.exit(1); }, 60000);

async function main() {
  const upstream = await startUpstream();
  console.log("[proof] upstream up");

  // Dynamically import the host-adapter middleware + the evaluation entry
  // (recipes are an EVALUATION concept — the production entry has no
  // override). tsx resolves .ts.
  const {
    ReferenceSessionAdapter,
    referenceInject,
    HostOwnedVerificationAdapter,
    ReferenceTelemetryAdapter,
    ReferenceEnforcementAdapter,
    ReferenceCanaryStore,
  } = await import("../src/host-adapter/index.ts");
  const { admitEvaluation } = await import("../src/eval/evaluation-middleware.ts");

  // Secret signs the session cookie + CSRF token (P1-AUDIT-2). Must match the
  // deps.secret below so the GET-issued cookie/token verify on POST.
  const session = new ReferenceSessionAdapter(SECRET);
  const verification = new HostOwnedVerificationAdapter(() => true);
  const telemetry = new ReferenceTelemetryAdapter();
  const enforcement = new ReferenceEnforcementAdapter();
  const canaryStore = new ReferenceCanaryStore();

  const baseDeps = {
    secret: SECRET,
    version: VERSION,
    upstreamRegisterUrl: `http://localhost:${UPSTREAM_PORT}/api/register`,
    session,
    render: { inject: (html, profile, csrf, lab) => referenceInject(html, profile, csrf, lab) },
    verification,
    telemetry,
    enforcement,
    canaryStore,
    // The proof asserts that trap evidence BLOCKS forwarding. Advisory mode
    // (the deployment default) never blocks — it forwards everything with a
    // review annotation — so under advisory the ledger assertion would be
    // meaningless. ENFORCEMENT posture: non-ACCEPT dispositions are denied.
    enforcementMode: "enforcement",
  };

  const htmlLoader = async () => {
    const r = await fetch(`http://localhost:${UPSTREAM_PORT}/signup`);
    return r.text();
  };

  // ── Middleware http proxy ────────────────────────────────────────────────
  // Each arm drives its OWN condition; the serial proof swaps a module-level
  // `current` deps object per arm (no interleaved arms to race). Evaluation
  // arms carry the recipe through the EVALUATION entry; the production arm
  // carries NO recipe — it is the deployable config.
  let current = baseDeps;
  const mw = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${MIDDLEWARE_PORT}`);
    // lift method + body into a fresh Request for admitEvaluation()
    const buf = req.method === "GET" ? undefined : await new Promise((r) => {
      let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => r(Buffer.from(d)));
    });
    const fetchReq = new Request(`http://localhost:${MIDDLEWARE_PORT}${url.pathname}${url.search}`, {
      method: req.method,
      headers: { cookie: req.headers.cookie ?? "", "content-type": req.headers["content-type"] ?? "application/json" },
      body: buf,
    });
    const result = await admitEvaluation(fetchReq, current, htmlLoader);
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

  /** Start an arm: fresh session, GET signup (injects that arm's artifacts).
   * The evaluation arms set the arm's recipe; the production arm sets NO
   * recipe at all (the deployable composition). */
  const startArm = (recipe) => {
    current = recipe === undefined ? { ...baseDeps } : { ...baseDeps, recipe };
    return startArmAsync();
  };
  const startArmAsync = async () => {
    const getResp = await fetch(`${BASE}/signup`);
    const cookie = getResp.headers.get("set-cookie") ?? "";
    const html = await getResp.text();
    const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1] ?? "";
    return { cookie, html, csrf };
  };

  /** Submit one arm's form, then read the LEDGER (read-only probe). ONE POST
   * per account identity — a second POST would hit duplicate-email
   * rejection and muddy upstreamCreated. */
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
  const runArm = (recipe, form, eventBatch) => startArm(recipe).then((arm) => submitArm(arm, form, eventBatch));

  /** The omnivorous bot shape: fill EVERY writable text/email field the
   * served page exposes (the CSRF hidden field excluded — that is protocol,
   * not form answer). Works whatever field names the randomized profile
   * issued. Returns { form, filledNames }. */
  const omnivorousForm = (arm, identity) => {
    const form = { ...identity };
    const inputs = arm.html.match(/<input\b[^>]*>/g) ?? [];
    for (const tag of inputs) {
      const name = tag.match(/name="([^"]+)"/)?.[1];
      const type = tag.match(/type="([^"]+)"/)?.[1] ?? "text";
      if (!name || name === "csrf") continue;
      if (type === "hidden" || type === "submit" || type === "button") continue;
      if (type === "checkbox" || type === "radio") continue;
      form[name] = "bot-fills-everything";
    }
    return { form, filledNames: Object.keys(form).filter((k) => !(k in identity)) };
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

  // ARM 3 — PRODUCTION_DEFAULT: the deployable config. NO recipe override.
  // (a) A clean humanish submission MUST register (the production random
  //     composition never breaks a legitimate signup).
  // (b) An omnivorous direct-fill bot MUST NOT reach the ledger whenever
  //     the session's production draw issued a decoy field (the composition
  //     guarantees a trap layer; the omnivorous fill exercises it).
  {
    // (a) clean human.
    const humanEvents = [];
    let seq = 0, dt = 0;
    for (const field of ["name", "email", "password"]) {
      dt += 350; humanEvents.push({ seq: ++seq, dt, kind: "focus", target: field });
      dt += 250; humanEvents.push({ seq: ++seq, dt, kind: "key", target: field });
      dt += 180; humanEvents.push({ seq: ++seq, dt, kind: "input", target: field });
    }
    dt += 600; humanEvents.push({ seq: ++seq, dt, kind: "submit_attempt" });
    const clean = await runArm(undefined, {
      name: "Production Human",
      email: "production-human@example.invalid",
      password: "synthetic-password-123",
    }, humanEvents);
    lines.push(`[PRODUCTION_DEFAULT clean] disposition=${clean.disposition} upstreamCreated=${clean.upstreamCreated} ledger=${clean.ledgerHasAccount}`);
    if (clean.disposition !== "ACCEPT") { pass = false; lines.push("FAIL: PRODUCTION_DEFAULT clean submission was not ACCEPT"); }
    if (!clean.ledgerHasAccount) { pass = false; lines.push("FAIL: PRODUCTION_DEFAULT clean submission did NOT register"); }

    // (b) omnivorous bot, fresh production session.
    const botArm = await startArm(undefined);
    const { form: botForm, filledNames } = omnivorousForm(botArm, {
      name: "Bot Direct-Fill",
      email: "production-bot@example.invalid",
      password: "synthetic-password-123",
    });
    if (filledNames.length === 0) {
      pass = false;
      lines.push("FAIL: production arm exposed no fillable extra field — omnivorous bot not exercisable");
    }
    const bot = await submitArm(botArm, botForm);
    lines.push(`[PRODUCTION_DEFAULT bot] filled=${filledNames.join("|") || "none"} disposition=${bot.disposition} upstreamCreated=${bot.upstreamCreated} ledger=${bot.ledgerHasAccount}`);
    if (bot.disposition === "ACCEPT") {
      pass = false;
      lines.push("FAIL: production arm forwarded the omnivorous direct-fill bot (trap evidence ignored)");
    }
    if (bot.ledgerHasAccount) {
      pass = false;
      lines.push("FAIL: production arm let the omnivorous bot reach the upstream ledger");
    }
  }

  // ARM 4 — FULL (evaluation recipe) + direct-fill bot: the historical
  // deterministic arm, now driven through the EVALUATION entry (recipes are
  // not a production concept).
  {
    const recipe = { families: ["decoy-field", "decoy-route", "interaction"] };
    const botArm = await startArm(recipe);
    const { form: botForm } = omnivorousForm(botArm, {
      name: "Bot Direct-Fill Full",
      email: "full-arm-bot@example.invalid",
      password: "synthetic-password-123",
    });
    const r = await submitArm(botArm, botForm);
    lines.push(`[FULL bot direct-fill] disposition=${r.disposition} upstreamCreated=${r.upstreamCreated} ledger=${r.ledgerHasAccount}`);
    if (r.disposition === "ACCEPT") {
      pass = false;
      lines.push("FAIL: FULL-arm bot with populated decoy scored ACCEPT (decoy evidence ignored)");
    }
    if (r.ledgerHasAccount) {
      pass = false;
      lines.push("FAIL: FULL-arm bot with populated decoy reached the upstream ledger");
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
