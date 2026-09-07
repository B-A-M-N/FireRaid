#!/usr/bin/env node
/**
 * FR-P0-A / FR-RR-49 — PERFORM the external post-deploy smoke, then record
 * the receipt.
 *
 * The old recorder was an ATTESTATION in receipt clothing: it accepted
 * `--worker-version banana --url http://anything --checks …` and wrote
 * `{"ok":true}` entries for checks nobody performed. A receipt like that
 * certifies nothing. This runner performs the probes itself and records
 * what it OBSERVED — status codes, not assertions.
 *
 * Post-deployment evidence cannot live inside the git object it certifies
 * (a tracked deployed_sha self-invalidates when the recording commit moves
 * HEAD). The receipt is therefore an UNTRACKED file:
 * release-smoke-receipt.json (gitignored, regenerated per release).
 *
 * What the runner actually does:
 *   1. Verifies the candidate SHA is exactly HEAD (a receipt for any other
 *      SHA certifies nothing about this tree).
 *   2. Verifies the worker-version id SHAPE (32 lowercase hex — Cloudflare
 *      version ids) — "banana" is rejected without a network call.
 *   3. Requires an HTTPS URL whose hostname matches the production
 *      TURNSTILE_EXPECTED_HOSTNAME from wrangler.jsonc (the origin the
 *      Worker itself enforces — smoking a different host proves nothing).
 *   4. Probes, for real, over the network:
 *        signup_page       GET <url>/signup           → expect 200 HTML
 *        submit_failclosed POST /api/submit WITHOUT a
 *                          solved verification token → expect the
 *                          fail-closed 4xx (403), NOT a success receipt
 *        human_submit      POST /api/submit with a well-formed body —
 *                          OBSERVED status recorded; a full "human
 *                          submitted" assertion needs a solved Turnstile
 *                          token, so this check records the OBSERVED
 *                          status and REQUIRES the operator to supply
 *                          --human-submit-observed-status (from their
 *                          solved-widget run) for the ok verdict.
 *   5. Optionally (--verify-version): asks the Cloudflare API whether the
 *      version id belongs to the production Worker (proof the id is not
 *      from some other service). Needs CLOUDFLARE_API_TOKEN; failure here
 *      FAILS the receipt when requested.
 *
 * The receipt distinguishes `machine_checks` (what THIS script observed
 * over the network) from `operator_attestations` (what only a human with a
 * solved widget could establish). release:verify reads the receipt and
 * release_ready requires both halves.
 *
 * Usage:
 *   node scripts/release-smoke-record.mjs \
 *     --git-sha <sha that was deployed> \
 *     --worker-version <wrangler version id> \
 *     [--url https://fireraid-production.<subdomain>.workers.dev] \
 *     --human-submit-observed-status <status from your solved-widget submit> \
 *     [--verify-version] \
 *     [--notes <text>]
 *
 * --url defaults to https://<TURNSTILE_EXPECTED_HOSTNAME> from the
 * production env in wrangler.jsonc.
 */
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parse as parseJsonc } from "jsonc-parser";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "release-smoke-receipt.json");
const CONFIG = join(ROOT, "wrangler.jsonc");

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function die(msg) {
  console.error(`release-smoke-record: ${msg}`);
  process.exit(1);
}

const gitSha = arg("git-sha");
const workerVersion = arg("worker-version");
const urlArg = arg("url");
const humanStatus = arg("human-submit-observed-status");
const verifyVersion = hasFlag("verify-version");
const notes = arg("notes") ?? "";

// ── 1. SHA binding ────────────────────────────────────────────────────────
if (!gitSha || !workerVersion) die("--git-sha and --worker-version are required");
const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf-8" });
const head = r.status === 0 ? r.stdout.trim() : null;
if (!head) die("cannot resolve git HEAD");
if (gitSha !== head) {
  die(
    `--git-sha ${gitSha} does not equal current HEAD ${head}. A receipt certifies ` +
    "the deployed artifact against THIS tree; deploy the exact HEAD SHA and record that deployment."
  );
}

// ── 2. Worker-version SHAPE (FR-RR-49: "banana" must die here) ───────────
const WORKER_VERSION_RE = /^[0-9a-f]{32}$/;
if (!WORKER_VERSION_RE.test(workerVersion)) {
  die(
    `--worker-version "${workerVersion}" is not a Cloudflare version id ` +
    "(32 lowercase hex characters). Get the id from the `wrangler deploy` " +
    "output (or `wrangler versions list`) — the receipt must name the real " +
    "deployed version, not a label."
  );
}

// ── 3. URL: HTTPS + hostname must match the production config ────────────
let config;
try {
  config = parseJsonc(readFileSync(CONFIG, "utf-8"), []);
} catch (err) {
  die(`cannot read ${CONFIG}: ${err.message}`);
}
const expectedHostname = config?.env?.production?.vars?.TURNSTILE_EXPECTED_HOSTNAME;
let url = urlArg;
if (!url && expectedHostname) url = `https://${expectedHostname}`;
if (!url) die("--url is required (or set TURNSTILE_EXPECTED_HOSTNAME in wrangler.jsonc production env)");
let parsedUrl;
try {
  parsedUrl = new URL(url);
} catch {
  die(`--url ${url} is not a valid URL`);
}
if (parsedUrl.protocol !== "https:") {
  die(`--url must be HTTPS (got ${parsedUrl.protocol}) — a plaintext smoke proves nothing about the deployed Worker`);
}
if (expectedHostname && parsedUrl.hostname !== expectedHostname) {
  die(
    `--url hostname ${parsedUrl.hostname} does not match the production ` +
    `TURNSTILE_EXPECTED_HOSTNAME ${expectedHostname} — smoking a different ` +
    "origin certifies nothing about the deployed Worker (the Worker itself " +
    "fail-closes on a foreign Host header)."
  );
}
const BASE = parsedUrl.origin;

// ── 4. The REAL probes ────────────────────────────────────────────────────
/** curl with a hard timeout; returns { status, ok, body } — a transport
 * failure is status 0, never silently "ok". */
function probe(method, path, body) {
  const args = [
    "-sS", "--max-time", "20",
    "-o", "/dev/null", "-w", "%{http_code}",
    "-X", method,
    `${BASE}${path}`,
    "-H", "content-type: application/json",
  ];
  if (body !== undefined) args.push("-d", JSON.stringify(body));
  const p = spawnSync("curl", args, { encoding: "utf-8", timeout: 30_000 });
  const status = parseInt((p.stdout ?? "").trim(), 10);
  return { status: Number.isFinite(status) ? status : 0, transportError: p.status !== 0 };
}

console.log(`smoking ${BASE} …`);
const signup = probe("GET", "/signup");
const machineChecks = {
  signup_page: {
    ok: signup.status === 200,
    observed_status: signup.status,
    expect: "200 (signup page renders)",
    ...(signup.transportError ? { transport_error: true } : {}),
  },
  submit_failclosed: null, // filled below
  human_submit: null, // filled below
};

// Fail-closed probe: a submit WITHOUT any verification token MUST be
// refused. The middleware's decision-blind receipt means the exact status
// lives in the reference runtime (403 for verification_required); the
// property under test is "not 2xx" — a success receipt here would mean the
// deployed Worker forwards unverified submissions.
const failclosed = probe("POST", "/api/submit", {
  csrf: "smoke-probe-no-token",
  form: { name: "smoke", email: `smoke-${Date.now()}@example.invalid` },
  eventBatch: [],
});
machineChecks.submit_failclosed = {
  ok: failclosed.status >= 400 && failclosed.status < 500 && failclosed.status !== 0,
  observed_status: failclosed.status,
  expect: "4xx fail-closed (a submit without a solved verification token must be refused)",
  ...(failclosed.transportError ? { transport_error: true } : {}),
};

// Human submit: the operator's solved-widget run is the only real human
// path. The runner requires its OBSERVED status and applies the honest
// verdict (2xx = the applicant path works end-to-end).
if (!humanStatus) {
  die(
    "--human-submit-observed-status is required: perform the solved-widget " +
    "human submit yourself (README → Cloudflare Worker Deployment) and pass " +
    "the HTTP status you observed. The runner records it as an operator " +
    "attestation backed by a machine check (the other probes are fully " +
    "machine-observed)."
  );
}
const humanStatusNum = parseInt(humanStatus, 10);
if (!Number.isFinite(humanStatusNum) || humanStatusNum < 100 || humanStatusNum > 599) {
  die(`--human-submit-observed-status "${humanStatus}" is not an HTTP status code`);
}
machineChecks.human_submit = {
  ok: humanStatusNum >= 200 && humanStatusNum < 300,
  observed_status: humanStatusNum,
  expect: "2xx (a solved-widget human submission receives a success receipt)",
  source: "operator-observed", // honest provenance — the runner did NOT perform it
};

// ── 5. Optional: confirm the version id belongs to THIS Worker ───────────
let versionVerified = null;
if (verifyVersion) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) {
    die("--verify-version requires CLOUDFLARE_API_TOKEN");
  }
  const account = spawnSync(
    "npx", ["wrangler", "whoami"],
    { cwd: ROOT, encoding: "utf-8", timeout: 60_000 }
  );
  const accountMatch = (account.stdout ?? "").match(/([0-9a-f]{32})/);
  if (!accountMatch) {
    die("could not resolve the Cloudflare account id via `wrangler whoami`");
  }
  const workerName = config?.name ? `${config.name}` : null;
  const envName = config?.env?.production?.name ?? workerName;
  if (!envName) die("cannot determine the production Worker name from wrangler.jsonc");
  const api = spawnSync(
    "curl",
    [
      "-sS", "--max-time", "20",
      "-H", `Authorization: Bearer ${token}`,
      `https://api.cloudflare.com/client/v4/accounts/${accountMatch[1]}/workers/scripts/${envName}/versions/${workerVersion}`,
    ],
    { encoding: "utf-8", timeout: 30_000 }
  );
  let apiJson = null;
  try { apiJson = JSON.parse(api.stdout ?? ""); } catch { /* unparseable */ }
  versionVerified = {
    ok: apiJson?.success === true,
    worker_name: envName,
    checked_at: new Date().toISOString(),
  };
  if (!versionVerified.ok) {
    die(
      `version ${workerVersion} could NOT be confirmed on Worker "${envName}" ` +
      `(api success=${apiJson?.success}). The receipt must bind a version id ` +
      "that really belongs to the production Worker."
    );
  }
  console.log(`version ${workerVersion} confirmed on Worker ${envName}`);
}

const failedChecks = Object.entries(machineChecks)
  .filter(([, c]) => !c.ok)
  .map(([name]) => name);
if (failedChecks.length > 0) {
  console.error("smoke checks FAILED:");
  for (const [name, c] of Object.entries(machineChecks)) {
    console.error(`  ${name}: observed=${c.observed_status} (expect: ${c.expect})`);
  }
  die(
    `not writing a passing receipt — ${failedChecks.join(", ")} failed. ` +
    "Fix the deployment and re-run; a receipt may only record a passing smoke."
  );
}

if (existsSync(OUT)) {
  console.error("release-smoke-record: overwriting existing receipt for this SHA.");
}

const receipt = {
  schema: "fireraid-release-smoke-receipt/2",
  git_sha: gitSha,
  worker_version_id: workerVersion,
  deployed_url: BASE,
  recorded_at: new Date().toISOString(),
  machine_checks: machineChecks,
  operator_attestations: {
    human_submit: {
      attested: true,
      observed_status: humanStatusNum,
      note: "performed by the operator with a solved verification widget; the runner did not execute this submission",
    },
  },
  ...(versionVerified ? { version_verified: versionVerified } : {}),
  notes,
};

writeFileSync(OUT, JSON.stringify(receipt, null, 2) + "\n");
console.log(`release-smoke-record: receipt written to ${OUT}`);
for (const [name, c] of Object.entries(machineChecks)) {
  console.log(`  ${name}: ${c.observed_status} → ${c.ok ? "ok" : "FAIL"}`);
}
console.log(`  git_sha:            ${receipt.git_sha}`);
console.log(`  worker_version_id:  ${receipt.worker_version_id}`);
console.log(`  deployed_url:       ${receipt.deployed_url}`);
console.log("The next `npm run release:verify` run will claim release_ready for this SHA.");
