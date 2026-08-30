#!/usr/bin/env node
/**
 * Test Worker bootstrap (FR-R5-001/002).
 * Gives every browser/integration suite a Worker backed by a FRESH local D1
 * that exactly matches migrations/ — never the developer's ambient
 * .wrangler/state. Lifecycle: init persistence dir → apply migrations →
 * launch wrangler dev → wait for /health → hand off → kill on exit.
 *
 * Usage:
 *   node scripts/test-worker.mjs --suite test-e2e --port 9999 -- command args...
 *   (runs `command` with FIRERAID_BASE_URL set, exits with its code)
 *
 * Env:
 *   FIRERAID_TEST_ADMIN_SECRET   admin secret for tests (default: local test value)
 *   FIRERAID_TEST_LAB_SECRET     lab API secret for tests (default: local test value)
 */
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const MIGRATIONS_DIR = join(ROOT, "migrations");
const WRANGLERState = join(ROOT, ".wrangler");

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

function log(msg) { console.error(`[test-worker] ${msg}`); }

// 1. Dedicated, disposable persistence directory per suite.
const args = parseArgs(process.argv.slice(2));
const persistDir = args.persist ?? join(WRANGLERState, args.suite);
const port = args.port;
// HTTPS default: __Host- Secure cookies need a secure context for WebKit,
// which (unlike Chromium/Firefox) does not trust plain-http localhost.
const protocol = args.https ? "https" : "http";
const baseUrl = `${protocol}://localhost:${port}`;

log(`suite=${args.suite} persistence=${persistDir} port=${port}`);

// 2. Reset persistence so migrations run from scratch.
if (existsSync(persistDir)) {
  rmSync(persistDir, { recursive: true, force: true });
}
mkdirSync(persistDir, { recursive: true });

// 3. Apply migrations in lexical order via wrangler d1 execute --local.
const migrations = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
if (migrations.length === 0) {
  console.error("no migrations found"); process.exit(1);
}
for (const m of migrations) {
  log(`applying ${m}`);
  execFileSync("npx", ["wrangler", "d1", "execute", "fireraid", "--local",
    "--persist-to", persistDir, "--file", join(MIGRATIONS_DIR, m)],
    { cwd: ROOT, stdio: "inherit" });
}

// 4. Launch wrangler dev against exactly that persistence directory.
const adminSecret = process.env.FIRERAID_TEST_ADMIN_SECRET ?? "local-admin-secret-do-not-use-in-prod";
const labSecret = process.env.FIRERAID_TEST_LAB_SECRET ?? "local-lab-secret-do-not-use-in-prod";
// 32-char minimums enforced by validateConfig
const profileSecret = process.env.FIRERAID_TEST_PROFILE_SECRET ?? "test-profile-secret-0123456789abcdef0123456789abcdef";
const csrfSecret = process.env.FIRERAID_TEST_CSRF_SECRET ?? "test-csrf-secret-0123456789abcdef0123456789abcdef";

const wrangler = spawn("npx", [
  "wrangler", "dev", "--port", String(port), "--local",
  "--persist-to", persistDir,
  // FR-R5-039: dedicated test env → loads .dev.vars.test (no Turnstile).
  "-e", "test",
  // Self-signed TLS for __Host- Secure cookie semantics across all browsers.
  ...(args.https ? ["--local-protocol", "https"] : []),
], {
  cwd: ROOT,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    FIRERAID_PROFILE_SECRET: profileSecret,
    FIRERAID_CSRF_SECRET: csrfSecret,
    ADMIN_SECRET: adminSecret,
    FIRERAID_LAB_API_SECRET: labSecret,
    PROFILE_VERSION: "1",
    LAB_MODE: "true",
    // FR-R5-039: the test Worker has NO Turnstile credentials — the submit
    // path must skip Turnstile entirely (no siteverify mock, no network).
    // .dev.vars sets a test secret for manual runs; force it unset here.
    TURNSTILE_SECRET_KEY: "",
    TURNSTILE_SITE_KEY: "",
  },
});
wrangler.stdout.on("data", (d) => process.stderr.write(`[wrangler] ${d}`));
wrangler.stderr.on("data", (d) => process.stderr.write(`[wrangler] ${d}`));

// 5. Wait for /health — fail hard if the Worker never comes up.
async function waitForHealth(timeoutMs = 60000) {
  // Self-signed cert in https mode: relax verification for THIS process only
  // (the bootstrap never handles sensitive data — it polls /health).
  if (args.https) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
      if (resp.ok) {
        // Restore strict TLS for the child-suite environment we export below.
        delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        return true;
      }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

let exiting = false;
function shutdown(code) {
  if (exiting) return;
  exiting = true;
  log(`shutting down (exit ${code})`);
  wrangler.kill("SIGTERM");
  setTimeout(() => { try { wrangler.kill("SIGKILL"); } catch { /* already dead */ } }, 2000);
  process.exit(code);
}
process.on("exit", () => { try { wrangler.kill("SIGKILL"); } catch { /* already dead */ } });
process.on("SIGINT", () => shutdown(130));
process.on("SIGTERM", () => shutdown(143));

const healthy = await waitForHealth();
if (!healthy) {
  console.error("[test-worker] Worker failed to become healthy — FAILING (FR-R5-002: no silent skip)");
  shutdown(1);
}
log(`healthy at ${baseUrl}`);

// 6. Hand off to the suite command (or idle if none — for manual debugging).
if (args.command.length === 0) {
  log("no command given — idling (Ctrl-C to stop)");
  setInterval(() => {}, 1 << 30);
} else {
  const child = spawn(args.command[0], args.command.slice(1), {
    stdio: "inherit",
    cwd: ROOT,
    env: {
      ...process.env,
      FIRERAID_BASE_URL: baseUrl,
      FIRERAID_TEST_LAB_SECRET: labSecret,
      FIRERAID_TEST_ADMIN_SECRET: adminSecret,
    },
  });
  child.on("exit", (code) => shutdown(code ?? 1));
  child.on("error", (err) => { console.error(err); shutdown(1); });
}
