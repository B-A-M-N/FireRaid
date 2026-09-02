#!/usr/bin/env node
/**
 * FR-P1-28 (R7-032): automated resource-budget harness.
 *
 * Drives each audit-mandated scenario against a LIVE production-mode test
 * worker and counts the real resource cost of every request:
 *
 *   - Worker requests: root spans (fetch handler invocations)
 *   - D1 read stmts:   `d1_first` child spans (statement CALLS, not rows)
 *   - D1 write stmts:  `d1_run` + `d1_batch` child spans (statement CALLS)
 *   - D1 rows r/w:     rows_read/rows_written decoded from span attributes
 *                      (P1-16 — statement count and row movement are
 *                      DIFFERENT costs; a budget on one is not a budget on
 *                      the other). Undecodable attributes report "n/a".
 *   - p50/p95 latency: duration_ms over the scenario's root spans
 *
 * Wrangler's local observability store (queried via
 * /cdn-cgi/local/explorer/api/local/observability/query) records these
 * spans natively — the harness adds NO instrumentation to the defense
 * plane, so what it measures is exactly what production costs.
 *
 * Scenarios (audit item 28): abandoned signup, normal signup, keyboard-
 * heavy signup, autofill signup, failed verification/retry, verified
 * canary, long telemetry session, agent stop, pagehide.
 *
 * Usage:
 *   node --import tsx scripts/budget-harness.mjs        # run all scenarios
 *   node --import tsx scripts/budget-harness.mjs --scenario normal
 *   node --import tsx scripts/budget-harness.mjs --json out.json
 *
 * (P0-AUDIT-3: the verified-canary scenario imports the REAL TS derivation
 * through tsx — node alone cannot load it. `npm run test:budget` carries
 * the flag.)
 *
 * Exit code: 0 = all budgets honored, 1 = breach or harness failure.
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const ROOT = new URL("..", import.meta.url).pathname;
const PORT = 8797;
const BASE = `http://localhost:${PORT}`;
// P1-16: spans are read from wrangler's local trace-store SQLite, not the
// /cdn-cgi/local/explorer query API — that API strips the `attributes`
// column where rows_read/rows_written live.

/**
 * Audit budgets. A scenario exceeding ANY budget fails the run.
 * These are REGRESSION GUARDS, not precision pins — headroom exists so a
 * benign refactor doesn't fail CI, while the failure classes the audit
 * named (e.g. R7-022's extra per-keystroke writes) still trip the gate.
 */
const BUDGETS = {
  // R7-024 contract: a signup that never takes a stateful action costs
  // ZERO D1. Continuously enforced by this harness.
  "abandoned-signup": { workerRequests: 2, d1Reads: 0, d1Writes: 0 },
  // P1-AUDIT-2 Phase E tightening — the envelope fast-path now verifies the
  // HMAC (CPU) BEFORE the D1 SELECT and keys the SELECT on the VERIFIED
  // bare sid (the old fast path queried by the envelope string, missed on
  // EVERY stateful request, and paid verify+derive+INSERT+re-SELECT).
  // Observed post-fix: normal-signup 5 reads/4 writes (was 14/10),
  // keyboard-heavy 16/11 (was 24/18), long-telemetry 37/25 (was 52/40).
  // Budgets sit at observed + headroom for capture-mask variation.
  // P1-AUDIT-2 (P0-6/P0-7) re-baseline: the CAS fold sources its suffix
  // from the authoritative raw log (not the request body) and the submit
  // read now reconciles against the session watermark before scoring —
  // +~1 read per fold/submit each. That is the audit-mandated cost of
  // correctness (the prior forward-only fold could permanently lose
  // events under concurrency and serve known-stale metrics); observed:
  // keyboard-heavy 26/11, long-telemetry 61/25, pagehide 6/3.
  "normal-signup": { workerRequests: 6, d1Reads: 10, d1Writes: 6 },
  "keyboard-heavy-signup": { workerRequests: 10, d1Reads: 32, d1Writes: 14 },
  "autofill-signup": { workerRequests: 6, d1Reads: 10, d1Writes: 6 },
  "failed-verification-retry": { workerRequests: 8, d1Reads: 8, d1Writes: 8 },
  // Includes up to 20 signup probes searching for a route-bearing profile
  // (bounded retry added when the scenario's silent no-op was fixed) — the
  // attempt loop re-signups free (abandoned signups cost 0 D1), and the
  // measured canary path itself is 2 reads / 2 writes.
  "verified-canary": { workerRequests: 24, d1Reads: 8, d1Writes: 6 },
  // 12 flushes × ~3 reads/flush (verified-sid SELECT + watermark + state
  // load) + ~2 writes/flush (ingest batch + state save) — post-fast-path
  // fix. Folding the state load/save into the ingest batch is future work;
  // the budget holds the line until then.
  "long-telemetry-session": { workerRequests: 18, d1Reads: 70, d1Writes: 30 },
  "agent-stop": { workerRequests: 4, d1Reads: 5, d1Writes: 4 },
  "pagehide-flush": { workerRequests: 4, d1Reads: 8, d1Writes: 4 },
};

// ── Worker lifecycle ───────────────────────────────────────────────────────

let worker = null;
async function startWorker() {
  worker = spawn("node", [
    "scripts/test-worker.mjs",
    "--suite", `budget-${Date.now()}`,
    "--port", String(PORT),
    "--wrangler-env", "production",
  ], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  worker.stdout.on("data", () => {});
  worker.stderr.on("data", (d) => {
    if (process.env.BUDGET_VERBOSE) process.stderr.write(`[worker] ${d}`);
  });
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (worker.exitCode !== null) throw new Error("worker died during startup");
    try {
      const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return;
    } catch { /* not up yet */ }
    await sleep(400);
  }
  throw new Error("worker failed to become healthy in 90s");
}

async function stopWorker() {
  if (!worker) return;
  const pid = worker.pid;
  worker.kill("SIGTERM");
  // The supervisor's own group reaper handles anything still bound to the
  // port after this process dies; a hard kill here is belt and braces.
  await sleep(2500);
  try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  worker = null;
}

// ── Observability queries ─────────────────────────────────────────────────

/**
 * P1-16: span rows are read DIRECTLY from wrangler's local trace-store
 * SQLite (the newest .wrangler/<suite>/v3/observability trace store), not via
 * the /cdn-cgi/local/explorer query API — that API strips the `attributes`
 * column to `{}` on the wire, and attributes is exactly where the per-query
 * rows_read/rows_written live. Same worker-scoped discovery the API path
 * used, minus the lossy hop.
 */
function traceStorePath() {
  const obsRoot = join(ROOT, ".wrangler");
  let newest = null;
  for (const entry of readdirSync(obsRoot)) {
    if (!entry.startsWith("budget-")) continue;
    const store = join(obsRoot, entry, "v3", "observability", "miniflare-wobs-trace-store");
    let mtime = 0;
    try {
      mtime = readdirSync(store)
        .filter((f) => f.endsWith(".sqlite"))
        .reduce((acc, f) => Math.max(acc, statSync(join(store, f)).mtimeMs), 0);
    } catch {
      continue; // suite dir without a trace store
    }
    if (mtime > 0 && (newest === null || mtime > newest.mtime)) {
      newest = { path: join(store, readdirSync(store).find((f) => f.endsWith(".sqlite"))), mtime };
    }
  }
  if (!newest) throw new Error("no wrangler trace store found under .wrangler/budget-*/");
  return newest.path;
}

function querySpans(_sql, startMs, endMs) {
  // NOT readOnly: the live worker's recent spans sit in the store's -wal
  // file, and a read-only connection can skip WAL replay (or fail on it) —
  // which made a first cut of this harness read all-zero windows. Opening
  // read-write lets SQLite recover the WAL normally. Reads only; nothing
  // here writes to the trace store.
  const db = new DatabaseSync(traceStorePath());
  try {
    return db
      .prepare(
        `SELECT span_id, parent_id, name, start_ms, duration_ms, error, attributes
         FROM spans WHERE start_ms >= ? AND start_ms <= ?`
      )
      .all(Math.floor(startMs), Math.ceil(endMs));
  } finally {
    db.close();
  }
}

const D1_READ_SPAN = "d1_first";
const D1_WRITE_SPANS = new Set(["d1_run", "d1_batch"]);

/**
 * P1-AUDIT-2 (P1-16): decode the rows_read / rows_written / size_after that
 * wrangler records INSIDE each d1 span's attributes blob. The span COUNT is
 * statement calls, not rows — a `SELECT COUNT(*)` and a 10k-row scan are
 * both one `d1_first` span. The blob is wrangler's TLV encoding: each field
 * is a length-prefixed key followed by a typed value where numeric values
 * are the decimal digits that follow the type byte. Rather than pin the
 * full TLV grammar, scan the decoded bytes for the known key and read the
 * digit run that follows it (digits end at the next field's non-digit
 * bytes). Undecodable → null; the report then says "n/a" instead of a
 * fabricated number.
 */
function d1AttrValue(attrBytes, key) {
  try {
    const text = Buffer.from(attrBytes).toString("latin1");
    const m = text.match(new RegExp(`${key}.{0,2}?(\\d+)`));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/** attributes arrives from node:sqlite as a Uint8Array (BLOB); keep the
 * base64-text and Array fallbacks for wire-format drift. */
function attrBytes(attr) {
  if (attr == null) return null;
  if (attr instanceof Uint8Array) return attr;
  if (typeof attr === "string") return Uint8Array.from(Buffer.from(attr, "base64"));
  if (Array.isArray(attr)) return Uint8Array.from(attr);
  return null;
}

/**
 * Root spans in a time window with per-request D1 op counts.
 * Roots are spans whose parent is absent from the window's span set.
 */
async function requestWindow(startMs, endMs) {
  const spans = await querySpans(
    /* sql retained for shape parity with the old HTTP API path */ undefined,
    startMs,
    endMs
  );
  // True request roots carry parent_id IS NULL in wrangler's store.
  // (Parent-absent-from-window is NOT the same thing: a child span whose
  // parent started before the window would be miscounted as a root and
  // inflate request counts.)
  const d1ReadsByParent = new Map();
  const d1WritesByParent = new Map();
  const rowsReadByParent = new Map();
  const rowsWrittenByParent = new Map();
  for (const s of spans) {
    if (s.name === D1_READ_SPAN || D1_WRITE_SPANS.has(s.name)) {
      const bytes = attrBytes(s.attributes);
      const rr = bytes ? d1AttrValue(bytes, "rows_read") : null;
      const rw = bytes ? d1AttrValue(bytes, "rows_written") : null;
      if (rr !== null) rowsReadByParent.set(s.parent_id, (rowsReadByParent.get(s.parent_id) ?? 0) + rr);
      if (rw !== null) rowsWrittenByParent.set(s.parent_id, (rowsWrittenByParent.get(s.parent_id) ?? 0) + rw);
    }
    if (s.name === D1_READ_SPAN) {
      d1ReadsByParent.set(s.parent_id, (d1ReadsByParent.get(s.parent_id) ?? 0) + 1);
    } else if (D1_WRITE_SPANS.has(s.name)) {
      d1WritesByParent.set(s.parent_id, (d1WritesByParent.get(s.parent_id) ?? 0) + 1);
    }
  }
  const roots = spans.filter(
    (s) => (s.parent_id === null || s.parent_id === "") && (s.name === "GET" || s.name === "POST")
  );
  return roots.map((r) => ({
    name: r.name,
    durationMs: r.duration_ms,
    d1Reads: d1ReadsByParent.get(r.span_id) ?? 0,
    d1Writes: d1WritesByParent.get(r.span_id) ?? 0,
    // P1-16: ACTUAL row movement where decodable (null = not decodable —
    // reported as "n/a", never folded into a fake number).
    rowsRead: rowsReadByParent.get(r.span_id) ?? null,
    rowsWritten: rowsWrittenByParent.get(r.span_id) ?? null,
    error: r.error,
  }));
}

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return 0;
  const idx = Math.min(sortedValues.length - 1, Math.floor((p / 100) * sortedValues.length));
  return sortedValues[idx];
}

// ── Scenario drivers ──────────────────────────────────────────────────────

/** Fresh signup: returns { sid, csrf, html } (production envelope cookie). */
async function signup() {
  const resp = await fetch(`${BASE}/signup`);
  if (resp.status !== 200) throw new Error(`signup -> ${resp.status}`);
  const setCookie = resp.headers.get("set-cookie") || "";
  // P0-AUDIT-3 (P0-3): the raw cookie VALUE is the session identity on the
  // wire — in production mode it is the signed envelope. Keep both: `sid`
  // (the bare id, decoded from the verified envelope when needed) and
  // `cookieValue` (what requests must send back).
  const cookieValue = setCookie
    .split(",")
    .map((c) => c.split(";")[0].trim())
    .filter((c) => c.startsWith("__Host-fr_sid="))
    .map((c) => c.split("=").slice(1).join("="))[0];
  const html = await resp.text();
  const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1] ?? "";
  return { sid: cookieValue, cookieValue, csrf, html };
}

// ── P0-AUDIT-3 (P0-3): server-derived treatment truth ─────────────────────
// The worker signs session envelopes with FIRERAID_TEST_PROFILE_SECRET — a
// secret THIS harness controls (it spawns the worker). Verifying the
// envelope harness-side and re-deriving the profile with the SAME
// derivation the middleware uses gives the harness the issued treatment
// without reading a single byte of presentation. Runs the TS derivation
// through tsx so there is no parallel implementation to drift.

let _derivationMod = null;
async function derivationModule() {
  if (!_derivationMod) {
    const profileUrl = new URL("../src/core/profile.ts", import.meta.url).href;
    _derivationMod = await import("tsx/esm/api").then((tsx) =>
      tsx.tsImport(profileUrl, import.meta.url).then((m) => m.default ?? m)
    );
  }
  return _derivationMod;
}

/** The profile secret the harness itself handed the worker (test-worker.mjs). */
function workerProfileSecret() {
  return (
    process.env.FIRERAID_TEST_PROFILE_SECRET ??
    "test-profile-secret-0123456789abcdef0123456789abcdef"
  );
}

/**
 * Verify the production session envelope and re-derive the issued profile
 * the way the middleware does: secret (by kid) + version (payload.pv) +
 * bare sid → deriveProductionProfile. Returns null on ANY verification
 * failure (the harness must never act on an unverified envelope).
 */
async function deriveProfileFromEnvelope(cookieValue) {
  try {
    const parts = cookieValue.split(".");
    if (parts.length !== 3 || parts[0] !== "fr1") return null;
    const [, bodyB64, sigB64] = parts;
    const b64urlDecode = (s) =>
      Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    const body = b64urlDecode(bodyB64);
    const sig = b64urlDecode(sigB64);
    if (sig.length !== 32) return null;
    const secret = workerProfileSecret();
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const ok = await crypto.subtle.verify(
      "HMAC",
      key,
      sig,
      new TextEncoder().encode(`fr1.${bodyB64}`)
    );
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(body));
    if (payload.v !== 1 || typeof payload.sid !== "string" || !payload.sid) return null;
    const { deriveProductionProfile } = await derivationModule();
    return await deriveProductionProfile({
      secret,
      version: payload.pv,
      sessionId: payload.sid,
    });
  } catch {
    return null;
  }
}

function filledForm(html, overrides = {}) {
  const fields = {};
  for (const m of html.matchAll(/<input[^>]*name="([^"]+)"[^>]*>/g)) {
    fields[m[1]] = `budget-${m[1]}@example.invalid`;
  }
  if (fields.password !== undefined) fields.password = "budget-harness-password-1!";
  return { ...fields, ...overrides };
}

function postEvents(sid, events) {
  return fetch(`${BASE}/api/events`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `__Host-fr_sid=${sid}` },
    body: JSON.stringify({ events }),
  });
}

function postSubmit(sid, csrf, html) {
  return fetch(`${BASE}/api/submit`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `__Host-fr_sid=${sid}`, origin: BASE },
    body: JSON.stringify({ csrf, form: filledForm(html) }),
  });
}

const SCENARIOS = {
  "abandoned-signup": async () => {
    // View the page, close the tab. R7-024: this must cost ZERO D1.
    await signup();
    await sleep(300);
  },

  "normal-signup": async () => {
    const { sid, csrf, html } = await signup();
    await postEvents(sid, [
      { seq: 0, dt: 0, kind: "focus", target: "#email" },
      { seq: 1, dt: 400, kind: "input", target: "#email" },
      { seq: 2, dt: 900, kind: "focus", target: "#password" },
      { seq: 3, dt: 1200, kind: "input", target: "#password" },
    ]);
    // Verification fails against the local dummy Turnstile secret; the
    // scenario measures the full materialize + submit + audit path.
    const resp = await postSubmit(sid, csrf, html);
    if (resp.status !== 403) throw new Error(`normal-signup submit -> ${resp.status} (expected the local verification gate)`);
  },

  "keyboard-heavy-signup": async () => {
    const { sid } = await signup();
    // 5 flushes of 8 events (the client drains at MAX_EVENTS_PER_BATCH).
    for (let i = 0; i < 5; i++) {
      const events = [];
      for (let s = 0; s < 8; s++) {
        events.push({ seq: i * 8 + s, dt: (i * 8 + s) * 60, kind: s % 2 ? "input" : "focus", target: `#f${s}` });
      }
      const resp = await postEvents(sid, events);
      if (resp.status !== 200) throw new Error(`keyboard-heavy flush ${i} -> ${resp.status}`);
    }
  },

  "autofill-signup": async () => {
    // Near-simultaneous programmatic fills, then a submit.
    const { sid, csrf, html } = await signup();
    await postEvents(sid, [
      { seq: 0, dt: 0, kind: "input", target: "#name", meta: { synthetic: true } },
      { seq: 1, dt: 1, kind: "input", target: "#email", meta: { synthetic: true } },
      { seq: 2, dt: 2, kind: "input", target: "#organization", meta: { synthetic: true } },
    ]);
    const resp = await postSubmit(sid, csrf, html);
    if (resp.status !== 403) throw new Error(`autofill submit -> ${resp.status}`);
  },

  "failed-verification-retry": async () => {
    const { sid, csrf, html } = await signup();
    // Three submit attempts with the unusable local secret (the retry loop
    // a stuck user performs) — each attempt audits one verification failure.
    for (let i = 0; i < 3; i++) {
      const resp = await postSubmit(sid, csrf, html);
      if (resp.status !== 403) throw new Error(`failed-verification attempt ${i} -> ${resp.status}`);
    }
  },

  "verified-canary": async () => {
    // P1-AUDIT-2 fix: this scenario used to SILENTLY NO-OP when the drawn
    // profile carried no decoy route (a plain "return") — the harness then
    // reported a PASS for a scenario that measured only /signup. Retry
    // until a route-bearing profile is drawn (bounded), so the budget
    // always covers the materialize + verify + persist path it names.
    //
    // P0-AUDIT-3 (P0-3): the token now comes from SERVER-DERIVED TRUTH —
    // verify the session envelope (HMAC, harness-held key) and re-derive
    // the profile exactly as the worker does. The old scraper matched
    // data-rt-token in the HTML, but production INTENTIONALLY stopped
    // emitting internal markers — the scrape depended on a presentation
    // signature whose removal is itself a production security feature.
    // Test infrastructure must learn treatment from authoritative
    // derivation, never from presentation.
    for (let attempt = 0; attempt < 20; attempt++) {
      const { sid, cookieValue } = await signup();
      const profile = await deriveProfileFromEnvelope(cookieValue);
      if (!profile) throw new Error("verified-canary: envelope failed harness-side verification");
      const token = profile.decoyRoute?.endpointToken;
      if (token) {
        const resp = await fetch(`${BASE}/c/${token}`, {
          headers: { cookie: `__Host-fr_sid=${cookieValue}` },
        });
        if (resp.status === 403) throw new Error("canary hit rejected the session");
        return;
      }
    }
    throw new Error(
      "verified-canary: no decoy-route profile drawn in 20 signups — cannot measure the canary path"
    );
  },

  "long-telemetry-session": async () => {
    const { sid } = await signup();
    // 12 flushes of 10 events — a long-lived, interaction-heavy session.
    for (let i = 0; i < 12; i++) {
      const events = [];
      for (let s = 0; s < 10; s++) {
        events.push({ seq: i * 10 + s, dt: (i * 10 + s) * 50, kind: s % 3 ? "input" : "focus", target: `#lt${s}` });
      }
      const resp = await postEvents(sid, events);
      if (resp.status !== 200) throw new Error(`long-telemetry flush ${i} -> ${resp.status}`);
    }
  },

  "agent-stop": async () => {
    // Minimal agent: signup then a bare submit, no telemetry at all.
    const { sid, csrf, html } = await signup();
    const resp = await postSubmit(sid, csrf, html);
    if (resp.status !== 403) throw new Error(`agent-stop submit -> ${resp.status}`);
  },

  "pagehide-flush": async () => {
    // The client flushes its queue on pagehide; server-side the shape is a
    // final telemetry batch. (Driven via fetch — pagehide itself is browser
    // behavior; what is budgeted is the server cost of the final batch.)
    const { sid } = await signup();
    const resp = await postEvents(sid, [
      { seq: 0, dt: 0, kind: "focus", target: "body" },
      { seq: 1, dt: 50, kind: "input", target: "#email" },
      { seq: 2, dt: 80, kind: "focus", target: "#submit-btn" },
    ]);
    if (resp.status !== 200) throw new Error(`pagehide flush -> ${resp.status}`);
  },
};

// ── Runner ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  // NB: main() passes process.argv.slice(2) — index from 0.
  const args = { scenario: null, json: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--scenario") args.scenario = argv[++i];
    else if (argv[i] === "--json") args.json = argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const names = args.scenario ? [args.scenario] : Object.keys(SCENARIOS);

  await startWorker();
  const report = {};
  let failed = false;

  try {
    for (const name of names) {
      const budget = BUDGETS[name];
      if (!budget) throw new Error(`no budget for scenario ${name}`);
      process.stdout.write(`  ${name.padEnd(28)} `);

      // Window: settle first (lets the supervisor's own health/Turnstile
      // probes flush their spans), then mark t0 with NO pre-roll — a
      // pre-roll would re-include those probes in the first scenario's
      // counts.
      await sleep(1000);
      const t0 = Date.now() - 1;
      let requests;
      try {
        await SCENARIOS[name]();
        await sleep(500); // let trailing spans land
        const t1 = Date.now();
        requests = await requestWindow(t0, t1);
      } catch (err) {
        console.log(`DRIVER ERROR: ${err.message}`);
        failed = true;
        report[name] = { status: "DRIVER_ERROR", error: err.message, budget };
        continue;
      }

      const workerRequests = requests.length;
      const d1Reads = requests.reduce((n, r) => n + r.d1Reads, 0);
      const d1Writes = requests.reduce((n, r) => n + r.d1Writes, 0);
      // P1-16: row movement is a separate measurement from statement calls.
      // Any non-decodable span makes the row total null (n/a), so a decode
      // gap can never masquerade as "0 rows".
      const anyUndecoded = requests.some((r) => (r.d1Reads > 0 || r.d1Writes > 0) && r.rowsRead === null && r.rowsWritten === null);
      const rowsRead = anyUndecoded ? null : requests.reduce((n, r) => n + (r.rowsRead ?? 0), 0);
      const rowsWritten = anyUndecoded ? null : requests.reduce((n, r) => n + (r.rowsWritten ?? 0), 0);
      const durations = requests.map((r) => r.durationMs).sort((a, b) => a - b);
      const p50 = percentile(durations, 50);
      const p95 = percentile(durations, 95);

      const breaches = [];
      if (workerRequests > budget.workerRequests) breaches.push(`workerRequests ${workerRequests} > ${budget.workerRequests}`);
      if (d1Reads > budget.d1Reads) breaches.push(`d1Reads ${d1Reads} > ${budget.d1Reads}`);
      if (d1Writes > budget.d1Writes) breaches.push(`d1Writes ${d1Writes} > ${budget.d1Writes}`);

      report[name] = {
        // P1-16: these are D1 STATEMENT CALLS (spans), not rows.
        workerRequests, d1Reads, d1Writes,
        rowsRead, rowsWritten,
        p50Ms: p50, p95Ms: p95,
        budget,
        breaches,
        status: breaches.length === 0 ? "PASS" : "FAIL",
      };
      if (breaches.length > 0) {
        failed = true;
        console.log(`FAIL — ${breaches.join("; ")}`);
      } else {
        const rows = rowsRead === null ? "n/a" : `${rowsRead}r/${rowsWritten}w`;
        console.log(`PASS — ${workerRequests} req, ${d1Reads} stmts, ${d1Writes} stmts, rows ${rows}, p95 ${p95}ms`);
      }
    }
  } finally {
    await stopWorker();
  }

  if (args.json) {
    writeFileSync(args.json, JSON.stringify(report, null, 2));
    console.log(`\nreport: ${args.json}`);
  }

  console.log("\n=== Budget harness summary ===");
  for (const [name, r] of Object.entries(report)) {
    const rows = r.rowsRead === null || r.rowsRead === undefined ? "n/a" : `${r.rowsRead}/${r.rowsWritten}`;
    console.log(`${r.status.padEnd(12)} ${name.padEnd(28)} ${r.workerRequests ?? "?"} req / ${r.d1Reads ?? "?"} read-stmts / ${r.d1Writes ?? "?"} write-stmts / rows ${rows} / p95 ${r.p95Ms ?? "?"}ms`);
  }

  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(`budget harness failed: ${err?.stack ?? err}`);
  stopWorker().catch(() => {});
  process.exit(1);
});
