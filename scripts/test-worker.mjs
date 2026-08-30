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
import { mkdirSync, rmSync, existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const MIGRATIONS_DIR = join(ROOT, "migrations");
const WRANGLER_STATE = join(ROOT, ".wrangler");
/** Local installs ship this bin; it keeps wrangler (and workerd) in our tree. */
const WRANGLER_BIN = join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
const D1_BINDING = "fireraid";
const WRANGLER_ENV = "test";
/** FR-R5-039: must stay Turnstile-free. .dev.vars DOES carry Turnstile keys. */
const DEV_VARS_TEST = join(ROOT, ".dev.vars.test");
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
  const args = { suite: "test-e2e", port: 9999, command: [], persist: null, https: false };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--suite") args.suite = argv[++i];
    else if (a === "--port") args.port = Number(argv[++i]);
    else if (a === "--persist") args.persist = argv[++i];
    else if (a === "--https") args.https = true;
    else if (a === "--") { args.command = argv.slice(i + 1); break; }
    i++;
  }
  return args;
}

const log = (msg) => console.error(`[test-worker] ${msg}`);

const args = parseArgs(process.argv.slice(2));
const persistDir = args.persist ?? join(WRANGLER_STATE, args.suite);
const port = args.port;
// HTTPS default off; `--https` (Playwright suites) is required for __Host-
// Secure cookies in WebKit, which distrusts plain-http localhost.
const protocol = args.https ? "https" : "http";
const baseUrl = `${protocol}://localhost:${port}`;

log(`suite=${args.suite} persistence=${persistDir} port=${port}`);

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

if (!existsSync(DEV_VARS_TEST)) {
  console.error(
    `[test-worker] FATAL: ${DEV_VARS_TEST} is missing. Wrangler (-e test) must load it ` +
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
    "d1", "migrations", "apply", D1_BINDING,
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
    "d1", "execute", D1_BINDING,
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
const SECRET_ENV = {
  FIRERAID_PROFILE_SECRET: profileSecret,
  FIRERAID_CSRF_SECRET: csrfSecret,
  ADMIN_SECRET: adminSecret,
  FIRERAID_LAB_API_SECRET: labSecret,
  PROFILE_VERSION: "1",
  LAB_MODE: "true",
};

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
  return reaper;
}
const wranglerReaper = spawnGroupReaper(process.pid, child.pid, "wrangler");

// Keep a tail of wrangler output for diagnostics, and watch for the line that
// names which .dev.vars file it actually loaded.
const OUTPUT_TAIL_LINES = 200;
const outputTail = [];
let devVarsSource = null;
let sawDevVarsLine = false;

function recordOutput(chunk) {
  const text = String(chunk);
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    outputTail.push(line);
    if (outputTail.length > OUTPUT_TAIL_LINES) outputTail.shift();
    const m = /^Using secrets defined in (.+)$/.exec(line);
    if (m) {
      sawDevVarsLine = true;
      devVarsSource = m[1].trim();
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
      if (resp.ok) return true;
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
  const fakeSession = "00000000-0000-4000-8000-000000000000";
  let status = 0;
  let body = "";
  try {
    const resp = await fetch(`${baseUrl}/api/submit`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `${SESSION_COOKIE}=${fakeSession}`,
      },
      body: JSON.stringify({ csrf: "probe", form: {} }),
      signal: AbortSignal.timeout(10000),
    });
    status = resp.status;
    body = (await resp.text()).slice(0, 500);
  } catch (err) {
    failWithOutput(`Turnstile probe could not reach /api/submit: ${err?.message ?? err}`);
    shutdown(1, "probe-unreachable");
    return;
  }
  if (/turnstile|verification_required/i.test(body)) {
    failWithOutput(
      `the test Worker is ENFORCING Turnstile (HTTP ${status}: ${body}). ` +
      `Expected Turnstile to be disabled via .dev.vars.test (FR-R5-039/FR-R6-002).`
    );
    shutdown(1, "turnstile-enabled");
    return;
  }
  log(`turnstile disabled (probe: HTTP ${status} ${body.replace(/\s+/g, " ").trim()})`);
}

function checkDevVarsSource() {
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

  if (targets.length > 0) {
    for (const [label, pid] of targets) killPidGroup(pid, "SIGTERM", label);
    // Real race: give the group 2s to die gracefully, then SIGKILL whatever is
    // left. (The old code used a setTimeout that process.exit() always won.)
    const grace = new Promise((r) => setTimeout(r, 2000).unref?.());
    await Promise.race([watchWranglerExit(), grace]);
    for (const [label, pid] of targets) killPidGroup(pid, "SIGKILL", label);
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
  const closed = await portClosed(port);
  if (!closed) log(`WARNING: port ${port} still listening after teardown`);
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
  spawnGroupReaper(process.pid, suiteChild.pid, "suite");
  suiteChild.on("exit", (code) => shutdown(code ?? 1, "suite-exit"));
  suiteChild.on("error", (err) => { console.error(err); shutdown(1, "suite-spawn-error"); });
}
