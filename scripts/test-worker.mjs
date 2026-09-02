#!/usr/bin/env node
/**
 * Test Worker bootstrap (FR-R5-001/002, FR-R6-002).
 * Gives every browser/integration suite a Worker backed by a FRESH local D1
 * that exactly matches migrations/ — never the developer's ambient
 * .wrangler/state.
 *
 * Lifecycle:
 *   1. init a dedicated, disposable persistence dir (wiped every run)
 *   2. apply ALL migrations with a single `wrangler d1 migrations apply`
 *   3. VERIFY the schema actually landed (no silent migration misses)
 *   4. launch `wrangler dev` in its own process group with a sanitized env
 *      and the `test` env (→ .dev.vars.test, no Turnstile credentials)
 *   5. wait for /health, then PROBE that Turnstile is genuinely disabled
 *   6. hand off to the suite command (or idle) and kill the whole wrangler
 *      process group on any exit path (never orphan workerd)
 *
 * Usage:
 *   node scripts/test-worker.mjs --suite test-e2e --port 9999 --https
 *   node scripts/test-worker.mjs --suite test-integration --port 8799 -- command args...
 *   (with a command: runs it with FIRERAID_BASE_URL set, exits with its code)
 *
 * Consumers (contract — do not break):
 *   - playwright.config.ts / playwright.a11y.config.ts webServer.command
 *     (--suite <name> --port 9999 --https, readiness = GET /health, 90s budget)
 *   - package.json "test:integration" (--suite test-integration --port 8799 -- vitest ...)
 *
 * Env:
 *   FIRERAID_TEST_ADMIN_SECRET   admin secret for tests (default: local test value)
 *   FIRERAID_TEST_LAB_SECRET     lab API secret for tests (default: local test value)
 */
import { spawn, execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const MIGRATIONS_DIR = join(ROOT, "migrations");
const WRANGLER_STATE = join(ROOT, ".wrangler");
/** Local installs ship this bin; it keeps wrangler (and workerd) in our tree. */
const WRANGLER_BIN = join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
/** FR-P1-19: per-env D1 database NAME (wrangler resolves by name first).
 * test → "fireraid"; production → "fireraid-production"; production-test →
 * "fireraid-production-test" (wrangler.jsonc). */
function d1DatabaseName(wranglerEnv) {
  if (wranglerEnv === "production") return "fireraid-production";
  if (wranglerEnv === "production-test") return "fireraid-production-test";
  return "fireraid";
}
// (WRANGLER_ENV is derived below, after parseArgs — FR-P1-19.)
/** FR-R5-039: must stay Turnstile-free. .dev.vars DOES carry Turnstile keys.
 * FR-P1-19: the file is per wrangler env (.dev.vars.<env> is what wrangler
 * loads for `-e <env>`). P1 (P0-AUDIT-3): production-SHAPE tests use the
 * TRACKED env.production-test (LAB_MODE=false, TURNSTILE_MODE=disabled-test)
 * — never a developer's local .dev.vars.production. */

/** FR-R6-002: these tables MUST exist after `d1 migrations apply`. */
const REQUIRED_TABLES = [
  "sessions",
  "lab_runs",
  "event_batches",
  "submissions",
  "canary_hits",
];
/** src/cloudflare/cookies.ts — only needed to address a session for the probe. */
const SESSION_COOKIE = "__Host-fr_sid";

function parseArgs(argv) {
  const args = {
    suite: "test-e2e", port: 9999, command: [], persist: null, https: false,
    // FR-P1-19: wrangler env selector — "test" (lab) by default;
    // "production" boots LAB_MODE=false for stateless-envelope tests.
    wranglerEnv: "test",
  };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--suite") args.suite = argv[++i];
    else if (a === "--port") args.port = Number(argv[++i]);
    else if (a === "--persist") args.persist = argv[++i];
    else if (a === "--https") args.https = true;
    else if (a === "--wrangler-env") args.wranglerEnv = argv[++i];
    else if (a === "--") { args.command = argv.slice(i + 1); break; }
    i++;
  }
  return args;
}

const log = (msg) => console.error(`[test-worker] ${msg}`);

const args = parseArgs(process.argv.slice(2));
// FR-P1-19: wrangler env selector — "test" (lab) by default; "production"
// boots LAB_MODE=false for stateless-envelope tests.
const WRANGLER_ENV = args.wranglerEnv;
const DEV_VARS_FILE = join(ROOT, `.dev.vars.${WRANGLER_ENV}`);
const persistDir = args.persist ?? join(WRANGLER_STATE, args.suite);
const port = args.port;
// HTTPS default off; `--https` (Playwright suites) is required for __Host-
// Secure cookies in WebKit, which distrusts plain-http localhost.
const protocol = args.https ? "https" : "http";
const baseUrl = `${protocol}://localhost:${port}`;

log(`suite=${args.suite} persistence=${persistDir} port=${port}`);

// --------------------------------------------------------------------------------
// 1. PORT IDENTITY (P0-AUDIT-3, P0-4): the requested port must be CLOSED
//    before we spawn anything. Any process already answering on it — a stale
//    workerd from a killed run, an unrelated dev server — would satisfy the
//    health poll and this suite would run against a DIFFERENT Worker than
//    the one in the repo (false red AND false green both observed in
//    practice). Fail hard, never reuse.
// --------------------------------------------------------------------------------
{
  const s = spawnSync(
    "bash",
    ["-c", `(exec 3<>/dev/tcp/127.0.0.1/${port}) 2>/dev/null && echo OPEN || echo CLOSED`],
    { encoding: "utf8", timeout: 2000 }
  );
  if ((s.stdout || "").trim() === "OPEN") {
    console.error(
      `[test-worker] FATAL: TEST_PORT_ALREADY_IN_USE — port ${port} has a listener. ` +
      `A stale Worker (or any other process) would silently serve this suite ` +
      `against the wrong code. Find and stop it (e.g. \`ss -ltnp | grep ${port}\`), ` +
      `or pass a different --port. Refusing to start.`
    );
    process.exit(1);
  }
  log(`port ${port} is free (pre-spawn probe)`);
}

// --------------------------------------------------------------------------------
// 1. Dedicated, disposable persistence directory per suite.
// --------------------------------------------------------------------------------
if (existsSync(persistDir)) {
  rmSync(persistDir, { recursive: true, force: true });
}
mkdirSync(persistDir, { recursive: true });

// --------------------------------------------------------------------------------
// 2. Sanity: migrations must exist, and the Turnstile-free env file must exist.
// --------------------------------------------------------------------------------
const migrations = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();
if (migrations.length === 0) {
  console.error(`[test-worker] FATAL: no *.sql migrations in ${MIGRATIONS_DIR}`);
  process.exit(1);
}
log(`migrations present: ${migrations.join(", ")}`);

// P1 (P0-AUDIT-3): production-test is HERMETIC — the bootstrap WRITES
// .dev.vars.production-test from its own synthetic SECRET_ENV before
// spawning wrangler (the write itself happens below, right after
// SECRET_ENV is assembled). Without this, wrangler (-e production-test,
// no such file yet) falls back to plain .dev.vars — which on a dev machine
// carries REAL Turnstile credentials (found live: the first
// production-test boot fataled on exactly that). The file is rewritten
// each run (gitignored), and the contamination check below verifies
// wrangler actually loaded it.
const HERMETIC_DEV_VARS = WRANGLER_ENV === "production-test";
if (!HERMETIC_DEV_VARS && !existsSync(DEV_VARS_FILE)) {
  console.error(
    `[test-worker] FATAL: ${DEV_VARS_FILE} is missing. Wrangler (-e ${args.wranglerEnv}) must load it ` +
    `so the test Worker has NO Turnstile credentials (FR-R5-039).`
  );
  process.exit(1);
}

/**
 * `node_modules/.bin/wrangler` is a shim that re-spawns wrangler's real bin,
 * which itself re-spawns the CLI — three processes to reap. Spawning the real
 * bin directly with the node binary keeps the chain (and workerd) in one
 * process group we can kill.
 */
function wranglerArgs(argv) {
  return existsSync(WRANGLER_BIN)
    ? { cmd: process.execPath, argv: [WRANGLER_BIN, ...argv] }
    : { cmd: "npx", argv: ["wrangler", ...argv] };
}

// --------------------------------------------------------------------------------
// 3. Apply every pending migration in ONE wrangler invocation (FR-R6-002).
//    wrangler reads ./migrations by convention (matches our layout).
// --------------------------------------------------------------------------------
log("applying migrations (single `d1 migrations apply`)…");
{
  const { cmd, argv } = wranglerArgs([
    "d1", "migrations", "apply", d1DatabaseName(WRANGLER_ENV),
    "--local",
    "--persist-to", persistDir,
    "-e", WRANGLER_ENV,
  ]);
  try {
    execFileSync(cmd, argv, { cwd: ROOT, stdio: "inherit" });
  } catch (err) {
    console.error(
      `[test-worker] FATAL: \`wrangler d1 migrations apply\` failed (${err?.message ?? err}). ` +
      `Refusing to start a Worker against an unmigrated D1 (FR-R6-002).`
    );
    process.exit(1);
  }
}

// --------------------------------------------------------------------------------
// 4. VERIFY the schema landed. A migration that silently misses tables caused
//    10/15 integration failures before — this is the hard gate against that.
// --------------------------------------------------------------------------------
function readTablesFromSqlite(file) {
  // node:sqlite (Node >=22.5, stable-ish in 22 LTS) avoids spawning wrangler.
  const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all();
    return rows.map((r) => String(r.name));
  } finally {
    db.close();
  }
}

async function readTablesViaWrangler() {
  const { cmd, argv } = wranglerArgs([
    "d1", "execute", d1DatabaseName(WRANGLER_ENV),
    "--local",
    "--persist-to", persistDir,
    "-e", WRANGLER_ENV,
    "--json",
    "--command", "SELECT name FROM sqlite_master WHERE type = 'table'",
  ]);
  const res = spawnSync(cmd, argv, { cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (res.status !== 0) {
    throw new Error(`wrangler d1 execute exited ${res.status}: ${res.stderr?.slice(0, 2000)}`);
  }
  const parsed = JSON.parse(res.stdout);
  const rows = Array.isArray(parsed) ? parsed : (parsed?.results ?? []);
  return rows.flatMap((r) => (r && typeof r.name === "string" ? [r.name] : []));
}

{
  let tables = null;
  let how = "";
  // Preferred: read the D1 sqlite file directly under the persist dir.
  const d1ObjDir = join(persistDir, "v3", "d1", "miniflare-D1DatabaseObject");
  let dbFile = null;
  if (existsSync(d1ObjDir)) {
    const candidates = readdirSync(d1ObjDir)
      .filter((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite")
      .sort();
    if (candidates.length === 1) dbFile = join(d1ObjDir, candidates[0]);
  }
  if (dbFile) {
    try {
      tables = readTablesFromSqlite(dbFile);
      how = `sqlite ${dbFile.replace(ROOT + "/", "")}`;
    } catch (err) {
      log(`direct sqlite read unavailable (${err?.message ?? err}); falling back to wrangler`);
    }
  } else {
    log("could not locate a single D1 sqlite file; using `wrangler d1 execute` fallback");
  }
  if (!tables) {
    tables = await readTablesViaWrangler();
    how = "`wrangler d1 execute --json`";
  }

  const missing = REQUIRED_TABLES.filter((t) => !tables.includes(t));
  if (missing.length > 0) {
    console.error(
      `[test-worker] FATAL: migrations did not produce required tables (via ${how}).\n` +
      `  missing: ${missing.join(", ")}\n` +
      `  found:   ${tables.sort().join(", ")}\n` +
      `This is the FR-R6-002 silent-miss failure class — failing instead of continuing.`
    );
    process.exit(1);
  }
  log(`schema verified via ${how}: ${REQUIRED_TABLES.join(", ")} present`);
}

// --------------------------------------------------------------------------------
// 5. Launch `wrangler dev` in its OWN process group (detached) so we can reap
//    wrangler AND workerd together (FR-R6-002 orphan-workerd fix).
// --------------------------------------------------------------------------------
const adminSecret = process.env.FIRERAID_TEST_ADMIN_SECRET ?? "local-admin-secret-do-not-use-in-prod";
const labSecret = process.env.FIRERAID_TEST_LAB_SECRET ?? "local-lab-secret-do-not-use-in-prod";
// 32-char minimums enforced by validateConfig
const profileSecret = process.env.FIRERAID_TEST_PROFILE_SECRET ?? "test-profile-secret-0123456789abcdef0123456789abcdef";
const csrfSecret = process.env.FIRERAID_TEST_CSRF_SECRET ?? "test-csrf-secret-0123456789abcdef0123456789abcdef";

/**
 * Secrets the Worker needs, matching .dev.vars.test exactly (they are only a
 * fallback — `-e test` loads that file — but explicit is safer than implicit).
 */
/**
 * FR-P1-19: LAB_MODE comes from the wrangler env block (-e test → true,
 * -e production → false); overriding it here would desync the test worker
 * from the deployment shape it is supposed to exercise. The remaining
 * secrets are identical across envs (they mirror .dev.vars.<env>).
 */
const SECRET_ENV = {
  FIRERAID_PROFILE_SECRET: profileSecret,
  FIRERAID_CSRF_SECRET: csrfSecret,
  ADMIN_SECRET: adminSecret,
  FIRERAID_LAB_API_SECRET: labSecret,
  PROFILE_VERSION: "1",
};

// Hermetic production-test: write the vars file NOW (before the wrangler
// spawn and the contamination check that verifies it). See the HERMETIC_
// DEV_VARS note above for why this file must exist.
if (HERMETIC_DEV_VARS) {
  writeFileSync(
    DEV_VARS_FILE,
    `# Generated by scripts/test-worker.mjs — synthetic test secrets only.
# NEVER hold real credentials here (the file is gitignored and rewritten
# every run; wrangler -e production-test loads THIS file, not .dev.vars).
` +
      Object.entries(SECRET_ENV)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n") +
      "\n"
  );
  log("env=production-test: wrote hermetic .dev.vars.production-test (synthetic secrets)");
}

/**
 * FR-R6-002: wrangler auto-loads `.dev.vars` (Turnstile keys!) unless `-e test`
 * steers it to `.dev.vars.test`, and even then it MERGES process.env. Scrub
 * every credential-bearing var from the child env so nothing can leak in from
 * the developer's shell or .dev.vars.
 */
function buildWranglerEnv() {
  const env = { ...process.env };
  // Wrangler/Cloudflare creds must never reach a local test dev session.
  for (const k of [
    "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_KEY",
    "CLOUDFLARE_EMAIL", "CLOUDFLARE_ACCOUNT_API_TOKEN", "CLOUDFLARE_USER_API_TOKEN",
  ]) delete env[k];
  // Turnstile is OFF for the test Worker — absent, not empty-string, so
  // `Boolean(env.TURNSTILE_SECRET_KEY)` in src/routes/submit.ts is false.
  for (const k of [
    "TURNSTILE_SECRET_KEY", "TURNSTILE_SITE_KEY",
    "FIRERAID_PROFILE_SECRET", "FIRERAID_CSRF_SECRET",
    "ADMIN_SECRET", "FIRERAID_LAB_API_SECRET", "PROFILE_VERSION", "LAB_MODE",
  ]) delete env[k];
  Object.assign(env, SECRET_ENV, { WRANGLER_SEND_METRICS: "false" });
  return env;
}

const { cmd: devCmd, argv: devArgv } = wranglerArgs([
  "dev",
  "--port", String(port),
  "--local",
  "--persist-to", persistDir,
  // FR-R5-039: dedicated test env → loads .dev.vars.test (no Turnstile).
  "-e", WRANGLER_ENV,
  // Self-signed TLS for __Host- Secure cookie semantics across all browsers.
  ...(args.https ? ["--local-protocol", "https"] : []),
]);

const child = spawn(devCmd, devArgv, {
  cwd: ROOT,
  // Own process group ⇒ `process.kill(-pid)` reaches wrangler + workerd.
  detached: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: buildWranglerEnv(),
});
log(`wrangler dev pid=${child.pid} group=${child.pid} (${devCmd})`);

// P0-AUDIT-3 (P0-4): arm the watchdogs IMMEDIATELY — not after suite
// handoff. Found live in the SIGKILL drill: a supervisor killed during its
// own readiness sequence (health poll, Turnstile probe, .dev.vars check)
// had spawned no reapers yet, and its in-progress wrangler/workerd chain
// orphaned onto the port. From this line on, ANY death of this supervisor
// — including SIGKILL mid-readiness — triggers both reapers.
spawnGroupReaper(process.pid, child.pid, "wrangler");

/**
 * FR-P0-14 (found in practice): every in-process teardown path — signal
 * handlers, 'exit', uncaughtException — only runs while THIS supervisor is
 * alive. Playwright escalates webServer teardown to SIGKILL against our
 * process GROUP after its graceful timeout; SIGKILL runs no handlers, so the
 * detached wrangler group (a different pgid) survived as an orphan holding
 * the port — the exact orphan-workerd failure FR-R6-002 was meant to close.
 *
 * Fix: an independent watchdog (its own session, stdio discarded) that
 * SIGKILLs the wrangler group the moment this supervisor's pid disappears —
 * whatever the cause. It self-terminates right after, so it never outlives
 * the run by more than one poll interval.
 */
function spawnGroupReaper(supervisorPid, groupPid, label) {
  // NB: dash (sh) rejects `kill -KILL -- -PGID` ("Illegal number: -") — the
  // `--` makes it treat the negative pid as an option-operand. Without `--`
  // the builtin accepts "-PGID" and signals the whole group. The first live
  // SIGKILL drill proved this: the `--` form failed rc=2, the pid fallback
  // killed only the group leader, and workerd survived. No `--`, ever.
  const script =
    `sup=${supervisorPid}; grp=${groupPid}; ` +
    `while kill -0 "$sup" 2>/dev/null; do sleep 0.3; done; ` +
    `kill -KILL "-$grp" 2>/dev/null; ` +
    `kill -KILL "$grp" 2>/dev/null; exit 0`;
  const reaper = spawn("sh", ["-c", script], { detached: true, stdio: "ignore" });
  reaper.unref?.();
  log(`group reaper (${label}): pid=${reaper.pid} watches supervisor=${supervisorPid} group=${groupPid}`);
  // P0-AUDIT-3 (P0-4): the pgid above is the wrangler child's — workerd
  // re-groups out of it (found live in the SIGKILL drill). A SECOND,
  // node-based reaper discovers workerd's real group from /proc + the port
  // and kills it. It self-exits once the port is free (bounded).
  const workerdReaperScript = `
    const { readdirSync, readFileSync } = require("node:fs");
    const { spawnSync } = require("node:child_process");
    const SUP = ${supervisorPid}, PORT = ${port};
    const deadline = Date.now() + 60000;
    function portHeld() {
      const s = spawnSync("bash",
        ["-c", \`(exec 3<>/dev/tcp/127.0.0.1/\${PORT}) 2>/dev/null && echo OPEN || echo CLOSED\`],
        { encoding: "utf8", timeout: 2000 });
      return (s.stdout || "").trim() === "OPEN";
    }
    function mine() {
      const mine = new Set([SUP]);
      let procs = new Map();
      try {
        for (const d of readdirSync("/proc")) {
          if (!/^\\d+$/.test(d)) continue;
          try {
            const stat = readFileSync("/proc/" + d + "/stat", "utf8");
            const close = stat.lastIndexOf(")");
            const f = stat.slice(close + 2).split(/\\s+/);
            procs.set(Number(d), { ppid: Number(f[1]), comm: (readFileSync("/proc/" + d + "/comm", "utf8") || "").trim() });
          } catch {}
        }
      } catch {}
      let grew = true;
      while (grew) { grew = false;
        for (const [pid, info] of procs) if (!mine.has(pid) && mine.has(info.ppid)) { mine.add(pid); grew = true; }
      }
      const out = [];
      // Port ownership is the AUTHORITATIVE claim once the supervisor is
      // dead: the orphaned chain re-parents to init, so ancestry from SUP
      // can miss it, but the workerd holding OUR port is unambiguous (the
      // pre-spawn probe proved the port was free before we spawned).
      try {
        const ss = spawnSync("bash", ["-c", "ss -ltnp 2>/dev/null | grep ':" + PORT + " ' || true"], { encoding: "utf8", timeout: 4000 });
        for (const m of (ss.stdout || "").matchAll(/pid=(\\d+)/g)) {
          const pid = Number(m[1]);
          const info = procs.get(pid);
          if (info && info.comm === "workerd" && !out.includes(pid)) out.push(pid);
        }
      } catch {}
      for (const [pid, info] of procs) {
        if (mine.has(pid) && pid !== SUP && info.comm === "workerd" && !out.includes(pid)) out.push(pid);
      }
      return out;
    }
    while (Date.now() < deadline) {
      let alive = true;
      try {
        // kill(pid,0) succeeds for a ZOMBIE (exited but unreaped) — a dead
        // supervisor that its spawner hasn't waited on would pin this loop
        // for the full deadline. Check the process STATE instead: "Z" means
        // dead for our purposes.
        const stat = readFileSync("/proc/" + SUP + "/stat", "utf8");
        const close = stat.lastIndexOf(")");
        const state = stat.slice(close + 2).split(/\\s+/)[0];
        alive = state !== "Z";
      } catch { alive = false; }
      if (!alive) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    }
    for (let round = 0; round < 5 && portHeld(); round++) {
      for (const pid of mine()) {
        // Kill workerd's whole GROUP (the wrangler shim re-groups; the
        // group contains bin → cli.js → workerd) and the pid itself.
        let pgid = pid;
        try {
          const stat = readFileSync("/proc/" + pid + "/stat", "utf8");
          const close = stat.lastIndexOf(")");
          pgid = Number(stat.slice(close + 2).split(/\\s+/)[2]);
        } catch {}
        try { process.kill(-pgid, "SIGKILL"); } catch {}
        try { process.kill(pid, "SIGKILL"); } catch {}
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
  `;
  const workerdReaper = spawn(process.execPath, ["-e", workerdReaperScript], {
    detached: true, stdio: "ignore",
  });
  workerdReaper.unref?.();
  log(`workerd reaper (${label}): pid=${workerdReaper.pid} watches supervisor=${supervisorPid} port=${port}`);
  return reaper;
}

// Keep a tail of wrangler output for diagnostics, and watch for the line that
// names which .dev.vars file it actually loaded. P0-AUDIT-3 (P0-4): also
// watch for THIS child's own "Ready on …:<port>" line — health alone cannot
// establish process identity (any stale listener can answer /health), so
// readiness requires the child's own ready line naming OUR port.
const OUTPUT_TAIL_LINES = 200;
const outputTail = [];
let devVarsSource = null;
let sawDevVarsLine = false;
let sawReadyOnOurPort = false;

function recordOutput(chunk) {
  const text = String(chunk);
  for (const rawLine of text.split(/\r?\n/)) {
    // Strip ANSI escapes BEFORE matching: wrangler colors its stderr when it
    // detects a color-capable pipeline (found live under Playwright:
    // "…[wrangler:info]… Ready on …https://localhost:9990…" with SGR codes
    // around the URL), which broke the "Ready on <url>" regex and made the
    // P0-4 ready-line guard false-positive against our own healthy child.
    // Diagnostics keep the RAW line (colors help humans; matches need clean).
    const line = rawLine.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trim();
    if (!line) continue;
    outputTail.push(line);
    if (outputTail.length > OUTPUT_TAIL_LINES) outputTail.shift();
    const m = /^Using secrets defined in (.+)$/.exec(line);
    if (m) {
      sawDevVarsLine = true;
      devVarsSource = m[1].trim();
    }
    // Wrangler prints e.g. "Ready on http://localhost:8799" (also
    // "⎔ Starting local server..." / "Ready on http://127.0.0.1:8799").
    const rm = /Ready on (https?:\/\/[^\s]*?):(\d+)/i.exec(line);
    if (rm && Number(rm[2]) === port) {
      sawReadyOnOurPort = true;
    }
  }
}
child.stdout.on("data", (d) => { recordOutput(d); process.stderr.write(`[wrangler] ${d}`); });
child.stderr.on("data", (d) => { recordOutput(d); process.stderr.write(`[wrangler] ${d}`); });

// --------------------------------------------------------------------------------
// 6. Readiness: /health must answer, and Turnstile must be provably OFF.
// --------------------------------------------------------------------------------
async function waitForHealth(timeoutMs = 60000) {
  // Self-signed cert in https mode: relax verification for THIS process only
  // (the bootstrap never handles sensitive data — it polls /health).
  if (args.https) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  // FR-R6-002 (found in e2e): keep the relaxation for the WHOLE bootstrap —
  // deleting it after health succeeds makes the very next fetch
  // (verifyTurnstileDisabled) die with DEPTH_ZERO_SELF_SIGNED_CERT against
  // wrangler's self-signed cert. This process only ever talks to the local
  // test Worker (never real credentials), so relaxing for its lifetime is
  // safe; the suite child gets its own explicit env below.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) return false;
    try {
      const resp = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
      // P0-AUDIT-3 (P0-4): health alone is NOT readiness. A stale process
      // left on this port answers /health too (the false-green/false-red
      // failure class this file exists to prevent). Readiness requires the
      // wrangler child WE spawned to have announced OUR port.
      if (resp.ok) {
        if (!sawReadyOnOurPort) {
          // Output and health race each other across TWO pipes (wrangler's
          // stdout and stderr are separate streams, and under Playwright the
          // supervisor's own stdio is piped too) — found live: the ready
          // line sat undelivered past a single 500ms recheck and the guard
          // fataled on a healthy worker. Reconcile for a bounded window
          // before declaring a stale listener.
          for (let i = 0; i < 20 && !sawReadyOnOurPort; i++) {
            if (child.exitCode !== null || child.signalCode !== null) break;
            await new Promise((r) => setTimeout(r, 250));
          }
          if (!sawReadyOnOurPort) {
            failWithOutput(
              `something answers /health on :${port}, but THIS wrangler child never announced ` +
              `"Ready on …:${port}" within 5s (ready-line flag=${sawReadyOnOurPort}). ` +
              `A stale listener is the suspected cause — refusing to run the suite ` +
              `against an unidentified process (P0-4).`
            );
            await shutdown(1, "stale-listener-on-port");
            return false;
          }
        }
        return true;
      }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function failWithOutput(msg) {
  console.error(`[test-worker] FATAL: ${msg}`);
  console.error(`[test-worker] ---- last ${outputTail.length} lines of wrangler output ----`);
  for (const l of outputTail) console.error(`  | ${l}`);
  console.error("[test-worker] ---- end wrangler output ----");
}

/**
 * Turnstile-disabled probe. /health does not expose config, and the submit
 * path short-circuits on session/CSRF *before* Turnstile, so an unknown
 * session can only ever be rejected for "no session". If Turnstile were
 * wrongly enabled we would instead see "Turnstile verification required" /
 * "verification_required". Anything Turnstile-shaped here is a hard failure.
 */
async function verifyTurnstileDisabled() {
  // P1 (P0-AUDIT-3): the OLD probe posted an invalid session and read the
  // 403 — but submit rejects an unknown session BEFORE Turnstile evaluation,
  // so a Turnstile-ENABLED worker passed this probe too (a false green).
  // The probe must REACH the verification stage: issue a real session
  // (GET /signup → envelope/bare cookie + CSRF token), submit a clean form
  // WITHOUT a Turnstile token. Disabled → normal admission path (200);
  // enabled → the verification gate (403 verification_required).
  // Teardown race: shutdown() is fire-and-forget — a prior failure path may
  // already be killing workerd while this probe still runs. Treat transport
  // errors here as a symptom, not a diagnosis.
  let signupResp;
  try {
    signupResp = await fetch(`${baseUrl}/signup`, { signal: AbortSignal.timeout(10000) });
  } catch (err) {
    log(`note: Turnstile probe /signup unreachable (${err?.message ?? err}) — worker likely being torn down`);
    return;
  }
  if (signupResp.status !== 200) {
    failWithOutput(`Turnstile probe could not issue a session (/signup -> ${signupResp.status})`);
    shutdown(1, "probe-signup-failed");
    return;
  }
  const setCookie = signupResp.headers.get("set-cookie") || "";
  const sidCookie = setCookie
    .split(",")
    .map((c) => c.split(";")[0].trim())
    .filter((c) => c.startsWith(`${SESSION_COOKIE}=`))
    .map((c) => c.split("=").slice(1).join("="))[0];
  const html = await signupResp.text();
  const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1] ?? "";
  if (!sidCookie || !csrf) {
    failWithOutput("Turnstile probe could not extract session cookie / CSRF token from /signup");
    shutdown(1, "probe-session-unreadable");
    return;
  }
  // Ordinary clean form fields (matches the signup template's ids).
  const form = {
    name: "turnstile-probe",
    email: "turnstile-probe@example.invalid",
    organization: "Probe Research",
    "intended-use": "Research purposes",
    password: "probe-password-123!",
  };
  let status = 0;
  let body = "";
  try {
    const resp = await fetch(`${baseUrl}/api/submit`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `${SESSION_COOKIE}=${sidCookie}`,
        origin: baseUrl,
      },
      body: JSON.stringify({ csrf, form }),
      signal: AbortSignal.timeout(15000),
    });
    status = resp.status;
    body = (await resp.text()).slice(0, 500);
  } catch (err) {
    failWithOutput(`Turnstile probe could not reach /api/submit: ${err?.message ?? err}`);
    shutdown(1, "probe-unreachable");
    return;
  }
  if (/verification_required|turnstile/i.test(body) || status === 403) {
    failWithOutput(
      `the test Worker is ENFORCING verification (HTTP ${status}: ${body.replace(/\s+/g, " ")}). ` +
      `Expected Turnstile to be OFF for this env (FR-R5-039 / TURNSTILE_MODE=disabled-test).`
    );
    shutdown(1, "turnstile-enabled");
    return;
  }
  log(`turnstile disabled (probe: HTTP ${status} — reached the admission stage)`);
}

function checkDevVarsSource() {
  if (HERMETIC_DEV_VARS) {
    // production-test: wrangler MUST have loaded the file we just wrote.
    // (It merges process.env too — SECRET_ENV also rides the child env —
    // but if it silently loaded .dev.vars instead, the page data would come
    // from an uncontrolled source, so fail on the reported source.)
    const src = devVarsSource ?? "";
    if (!/(^|\/)\.dev\.vars\.production-test$/.test(src)) {
      failWithOutput(
        `env=production-test must load .dev.vars.production-test (the hermetic synthetic ` +
        `file written by this bootstrap), but wrangler reported: ${src || "(no source reported)"}.`
      );
      shutdown(1, "dev-vars-not-hermetic");
      return;
    }
    log(`hermetic secrets source confirmed: ${src}`);
    return;
  }
  if (!sawDevVarsSource()) {
    log("wrangler did not report a .dev.vars source — relying on the /api/submit probe");
    return;
  }
  const src = devVarsSource ?? "";
  if (/(^|\/)\.dev\.vars$/.test(src)) {
    failWithOutput(
      `wrangler loaded "${src}", which carries Turnstile credentials. ` +
      `It must load .dev.vars.test via -e ${WRANGLER_ENV} (FR-R6-002).`
    );
    shutdown(1, "dev-vars-contaminated");
    return;
  }
  if (!/(^|\/)\.dev\.vars(\.\w+)?$/.test(src)) {
    log(`note: wrangler reported an unexpected secrets source: "${src}"`);
  }
}
function sawDevVarsSource() {
  return sawDevVarsLine && !!devVarsSource;
}

// --------------------------------------------------------------------------------
// 7. Teardown — kill the WHOLE process group, then exit. Never orphan workerd.
// --------------------------------------------------------------------------------
let exiting = false;
let suiteChild = null;
let wranglerExitPromise = null;

function killPidGroup(pid, signal, label) {
  if (typeof pid !== "number" || Number.isNaN(pid)) return;
  // Negative pid ⇒ signal the entire process group.
  try { process.kill(-pid, signal); }
  catch (err) {
    if (err?.code !== "ESRCH") log(`kill(${label}, ${signal}) group: ${err?.message ?? err}`);
  }
  // Belt and braces: also signal the direct child (covers a group leader that
  // already exited while its children linger in the group).
  try { process.kill(pid, signal); }
  catch { /* already gone */ }
}

/**
 * P0-AUDIT-3 (P0-4), found live in the SIGKILL drill: wrangler's real bin
 * RE-GROUPS itself — workerd lands in a DIFFERENT process group than the
 * `node …/wrangler-dist/cli.js` child we spawned, so `kill -KILL -<child.pid>`
 * signals an empty group while workerd survives as an orphan holding the
 * port. The `sh -c` reaper inherited the same wrong group id.
 *
 * Fix: discover workerd's ACTUAL pgid from /proc (walk every workerd whose
 * ancestry roots at this supervisor, or whose pgid differs from the wrangler
 * child's) and signal THAT group. Ancestor check keeps us from killing some
 * OTHER session's workerd.
 */
function workerdGroupsForOurRun() {
  const groups = new Set();
  let procEntries;
  try {
    procEntries = readdirSync("/proc").filter((d) => /^\d+$/.test(d));
  } catch {
    return groups;
  }
  // pid → { ppid, pgid, comm, args }
  const procs = new Map();
  for (const pid of procEntries) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // comm is parenthesized and may contain spaces — split from the LAST ')'.
      const closeIdx = stat.lastIndexOf(")");
      const [ppidS, _pgrpS] = stat.slice(closeIdx + 2).split(/\s+/);
      const pgidS = stat.slice(closeIdx + 2).split(/\s+/)[2];
      let comm = "";
      let args = "";
      try { comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim(); } catch { /* raced exit */ }
      try { args = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " "); } catch { /* raced exit */ }
      procs.set(Number(pid), { ppid: Number(ppidS), pgid: Number(pgidS), comm, args });
    } catch { /* raced exit */ }
  }
  // Anything in OUR supervisor's descendant set is ours (wrangler, workerd,
  // the suite, transient shims). The supervisor's own pid is the root.
  const mine = new Set([process.pid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [pid, info] of procs) {
      if (!mine.has(pid) && mine.has(info.ppid)) {
        mine.add(pid);
        grew = true;
      }
    }
  }
  // ALSO claim by port: a workerd listening on OUR port is ours even if a
  // reparent race broke the ancestry chain (e.g. an intermediate died).
  const portOwners = new Set();
  try {
    const ss = spawnSync("bash", ["-c", `ss -ltnp 2>/dev/null | grep ":${port} " || true`], {
      encoding: "utf8", timeout: 4000,
    });
    for (const m of (ss.stdout || "").matchAll(/pid=(\d+)/g)) {
      portOwners.add(Number(m[1]));
    }
  } catch { /* ss unavailable — ancestry check alone */ }
  for (const [pid, info] of procs) {
    const oursByAncestry = mine.has(pid) && pid !== process.pid;
    const oursByPort = portOwners.has(pid);
    if ((oursByAncestry || oursByPort) && info.comm === "workerd") {
      groups.add(info.pgid);
      groups.add(pid); // the process itself, in case the group leader logic differs
    }
  }
  // P0-AUDIT-3 (P0-4), found live: the wrangler SHIM re-groups — the whole
  // chain (bin → cli.js → workerd) lands in a NEW group led by the shim's
  // pid, NOT the child.pid we spawned. Claim the port-owner's pgid too: it
  // contains the entire orphaned chain.
  for (const owner of portOwners) {
    const info = procs.get(owner);
    if (info) {
      groups.add(info.pgid);
      groups.add(owner);
    }
  }
  return groups;
}

function killOurWorkerd(signal, label) {
  const targets = workerdGroupsForOurRun();
  for (const t of targets) {
    try { process.kill(-t, signal); } catch { /* group gone */ }
    try { process.kill(t, signal); } catch { /* process gone */ }
  }
  if (targets.size > 0) log(`killOurWorkerd(${label}): signaled ${targets.size} workerd target(s)`);
}

function watchWranglerExit() {
  if (wranglerExitPromise) return wranglerExitPromise;
  wranglerExitPromise = new Promise((res) => child.once("exit", (c, s) => res({ c, s })));
  return wranglerExitPromise;
}

/**
 * FR-P0-14: wait until nothing is listening on our port (best effort).
 * Killing the wrangler process group can leave the kernel a moment to close
 * the listener; a sequential suite (e2e then a11y on distinct ports, or a
 * rerun on the same port) must not race a half-closed socket. Falls back
 * after the deadline so a wedged socket can't hang teardown forever.
 */
function portClosed(port, deadlineMs = 8000) {
  const deadline = Date.now() + deadlineMs;
  return new Promise((res) => {
    const probe = () => {
      const s = spawnSync(
        "bash",
        ["-c", `(exec 3<>/dev/tcp/127.0.0.1/${port}) 2>/dev/null && echo OPEN || echo CLOSED`],
        { encoding: "utf8", timeout: 2000 }
      );
      const out = (s.stdout || "").trim();
      if (out === "CLOSED") { res(true); return; }
      if (Date.now() > deadline) { res(false); return; }
      setTimeout(probe, 250);
    };
    probe();
  });
}

async function shutdown(code, reason = "done") {
  if (exiting) return;
  exiting = true;
  log(`shutting down (exit ${code}, reason ${reason})`);

  const targets = [];
  if (typeof child.pid === "number") targets.push(["wrangler", child.pid]);
  if (suiteChild && typeof suiteChild.pid === "number") targets.push(["suite", suiteChild.pid]);
  // P0-AUDIT-3 (P0-4): the wrangler child's group is NOT necessarily
  // workerd's group (wrangler re-groups its real bin). Discover and include
  // workerd's actual group so the SIGTERM grace reaches it too.
  killOurWorkerd("SIGTERM", "shutdown-sweep");

  if (targets.length > 0) {
    for (const [label, pid] of targets) killPidGroup(pid, "SIGTERM", label);
    // Real race: give the group 2s to die gracefully, then SIGKILL whatever is
    // left. (The old code used a setTimeout that process.exit() always won.)
    const grace = new Promise((r) => setTimeout(r, 2000).unref?.());
    await Promise.race([watchWranglerExit(), grace]);
    for (const [label, pid] of targets) killPidGroup(pid, "SIGKILL", label);
    // P0-AUDIT-3 (P0-4): workerd's real group — the sweep above may have
    // signaled an empty group (wrangler re-groups).
    killOurWorkerd("SIGKILL", "shutdown-grace-expiry");
  }

  // Final sweep — synchronous, no awaits after this point.
  if (typeof child.pid === "number") {
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
  }
  if (suiteChild && typeof suiteChild.pid === "number") {
    try { process.kill(-suiteChild.pid, "SIGKILL"); } catch { /* already gone */ }
  }
  // FR-P0-14: hold the process until the port is actually released (bounded)
  // so a following suite never meets our orphaned listener.
  // P0-AUDIT-3 (P0-4): a leaked listener after full teardown is a FAILURE,
  // not a warning — it is exactly the stale-Worker hazard this file guards
  // against, and the next run would either false-fail or (worse) test
  // against the orphan. Exit nonzero so CI catches the leak.
  const closed = await portClosed(port);
  if (!closed) {
    console.error(
      `[test-worker] FATAL: port ${port} is STILL LISTENING after teardown — ` +
      `a workerd/wrangler process survived every kill. Find it with ` +
      `\`ss -ltnp | grep ${port}\`. Failing the run so the leak is caught here, ` +
      `not by the next suite attaching to a stale Worker.`
    );
    process.exit(1);
  }
  log(`teardown verified: port ${port} released`);
  process.exit(code);
}

// Last-resort synchronous reaping (process 'exit' handlers must be sync).
process.on("exit", () => {
  if (typeof child?.pid === "number") {
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
  }
  if (suiteChild && typeof suiteChild.pid === "number") {
    try { process.kill(-suiteChild.pid, "SIGKILL"); } catch { /* already gone */ }
  }
  // P0-AUDIT-3 (P0-4): last-resort workerd sweep. killOurWorkerd is
  // sync-friendly (readdir/readFileSync + spawnSync) — safe in an exit
  // handler, and the only path that reaches workerd's REAL group when the
  // graceful sweep already lost the race.
  try { killOurWorkerd("SIGKILL", "exit-handler"); } catch { /* dying anyway */ }
});

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => shutdown(sig === "SIGINT" ? 130 : 143, sig));
}
process.on("uncaughtException", (err) => {
  console.error(`[test-worker] uncaughtException: ${err?.stack ?? err}`);
  shutdown(1, "uncaughtException");
});
process.on("unhandledRejection", (err) => {
  console.error(`[test-worker] unhandledRejection: ${err?.stack ?? err}`);
  shutdown(1, "unhandledRejection");
});

// FR-R6-002: detect parent death.
// (a) Node IPC channel closing — only present when spawned with an IPC fd.
process.on("disconnect", () => shutdown(143, "parent-disconnect"));
// (b) FR-P0-14: stdin is NO LONGER a liveness signal. Playwright/CI invoke
// this script with stdin closed or at EOF (< /dev/null, FIFO holders,
// detached automation) — reading EOF there as "parent died" killed healthy
// runs with exit 143 and forced shell workarounds. Parent liveness is (c)'s
// ppid poll plus (a)'s IPC disconnect; both are reliable and neither
// depends on our stdio plumbing.
// (c) ppid reparented to init/launchd — poll, cheap and unconditional.
const parentPid = process.ppid;
const parentWatch = setInterval(() => {
  if (process.ppid !== parentPid) shutdown(143, "parent-reparented");
}, 2000);
parentWatch.unref?.();

// --------------------------------------------------------------------------------
// 8. Gate the handoff on real readiness.
// --------------------------------------------------------------------------------
const healthy = await waitForHealth();
if (!healthy) {
  failWithOutput("Worker failed to become healthy — FAILING (FR-R5-002: no silent skip)");
  await shutdown(1, "health-timeout");
}
log(`healthy at ${baseUrl}`);

checkDevVarsSource();
await verifyTurnstileDisabled();

// --------------------------------------------------------------------------------
// 9. Hand off to the suite command (or idle if none — for manual debugging).
// --------------------------------------------------------------------------------
if (args.command.length === 0) {
  log("no command given — idling (Ctrl-C to stop)");
  setInterval(() => {}, 1 << 30);
} else {
  // Own process group too, so a teardown can reap the suite and its children.
  suiteChild = spawn(args.command[0], args.command.slice(1), {
    stdio: "inherit",
    cwd: ROOT,
    detached: true,
    env: {
      ...process.env,
      NODE_TLS_REJECT_UNAUTHORIZED: "",
      FIRERAID_BASE_URL: baseUrl,
      // FR-P0-14: the a11y spec derives its lab API base from this — always
      // the port THIS bootstrap actually bound, never a hardcoded default.
      FIRERAID_TEST_BASE_URL: baseUrl,
      FIRERAID_TEST_LAB_SECRET: labSecret,
      FIRERAID_TEST_ADMIN_SECRET: adminSecret,
    },
  });
  log(`suite pid=${suiteChild.pid}: ${args.command.join(" ")}`);
  // Same watchdog contract as the wrangler group: if the supervisor is
  // SIGKILLed, the detached suite group must not outlive it either.
  // (The wrangler-group + workerd reapers were armed at spawn time — P0-4.)
  spawnGroupReaper(process.pid, suiteChild.pid, "suite");
  suiteChild.on("exit", (code) => shutdown(code ?? 1, "suite-exit"));
  suiteChild.on("error", (err) => { console.error(err); shutdown(1, "suite-spawn-error"); });
}
