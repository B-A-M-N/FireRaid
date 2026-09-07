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
 *   2. Verifies the worker-version id SHAPE (Wrangler UUID, with the
 *      historical 32-hex form readable) — "banana" is rejected without a
 *      network call.
 *   3. Requires an HTTPS URL whose hostname matches the production
 *      TURNSTILE_EXPECTED_HOSTNAME from wrangler.jsonc (the origin the
 *      Worker itself enforces — smoking a different host proves nothing).
 *   4. Probes, for real, over the network:
 *        signup_page       GET <url>/signup           → expect 200 HTML +
 *                          issued session/CSRF material
 *        health_build      GET <url>/health           → exact candidate SHA
 *        submit_failclosed POST /api/submit WITHOUT a
 *                          solved verification token → exact
 *                          verification_required response (403)
 *        human_submit      POST /api/submit with a well-formed body —
 *                          OBSERVED status recorded; a full "human
 *                          submitted" assertion needs a solved Turnstile
 *                          token, so this check records the OBSERVED
 *                          status and REQUIRES the operator to supply
 *                          --human-submit-observed-status (from their
 *                          solved-widget run) for the ok verdict.
 *   5. Always asks Wrangler for the authoritative production version list and
 *      proves the supplied id belongs to the explicitly named production
 *      Worker. Failure here FAILS the receipt.
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
import { isGitSha, isWorkerVersionId, productionConfig, VERSION_LOOKUP } from "./lib/release-proof.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "release-smoke-receipt.json");
const CONFIG = join(ROOT, "wrangler.jsonc");

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function die(msg) {
  console.error(`release-smoke-record: ${msg}`);
  process.exit(1);
}

const gitSha = arg("git-sha");
const workerVersion = arg("worker-version");
const urlArg = arg("url");
const humanStatus = arg("human-submit-observed-status");
const notes = arg("notes") ?? "";

// ── 1. SHA binding ────────────────────────────────────────────────────────
if (!gitSha || !workerVersion) die("--git-sha and --worker-version are required");
const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf-8" });
const head = r.status === 0 ? r.stdout.trim() : null;
if (!head) die("cannot resolve git HEAD");
if (!isGitSha(gitSha)) die(`--git-sha must be a 40-character lowercase SHA (got ${gitSha})`);
if (gitSha !== head) {
  die(
    `--git-sha ${gitSha} does not equal current HEAD ${head}. A receipt certifies ` +
    "the deployed artifact against THIS tree; deploy the exact HEAD SHA and record that deployment."
  );
}

// ── 2. Worker-version SHAPE (FR-RR-49: "banana" must die here) ───────────
if (!isWorkerVersionId(workerVersion)) {
  die(
    `--worker-version "${workerVersion}" is not a Cloudflare version id ` +
    "(a Wrangler UUID or historical 32 lowercase hex id). Get the id from `wrangler deploy` " +
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
const { workerName: expectedWorkerName, hostname: expectedHostname } = productionConfig(config);
if (!expectedWorkerName) die("wrangler.jsonc production env must declare an explicit Worker name");
if (!expectedHostname) die("wrangler.jsonc production env must declare TURNSTILE_EXPECTED_HOSTNAME");
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
if (parsedUrl.hostname !== expectedHostname) {
  die(
    `--url hostname ${parsedUrl.hostname} does not match the production ` +
    `TURNSTILE_EXPECTED_HOSTNAME ${expectedHostname} — smoking a different ` +
    "origin certifies nothing about the deployed Worker (the Worker itself " +
    "fail-closes on a foreign Host header)."
  );
}
if (parsedUrl.port !== "" || parsedUrl.username !== "" || parsedUrl.password !== "" ||
    parsedUrl.pathname !== "/" || parsedUrl.search !== "" || parsedUrl.hash !== "") {
  die("--url must be the exact HTTPS production origin with no port, path, query, fragment, or userinfo");
}
const BASE = parsedUrl.origin;

// ── 4. The REAL probes ────────────────────────────────────────────────────
/** Native fetch with a hard timeout; transport failure is status 0. */
async function probe(method, path, { body, headers = {}, captureBody = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    return {
      status: response.status,
      body: captureBody ? await response.text() : "",
      headers: response.headers,
      transportError: false,
    };
  } catch {
    return { status: 0, body: "", headers: new globalThis.Headers(), transportError: true };
  } finally {
    clearTimeout(timer);
  }
}

function parseJsonBody(body) {
  try { return JSON.parse(body); } catch { return null; }
}

function signupSessionMaterial(response) {
  const setCookies = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie") ?? ""];
  const cookies = setCookies
    .flatMap((line) => line.match(/(?:^|,\s*)(__Host-fr_[^=]+=[^;]+)/g) ?? [])
    .map((line) => line.replace(/^,\s*/, ""));
  const csrf = response.body.match(/<input[^>]+name="csrf"[^>]+value="([^"]+)"/i)?.[1] ?? "";
  return { cookie: cookies.join("; "), csrf };
}

// Validate operator input before making any remote request. This keeps a
// typo in the attestation command from causing an unnecessary smoke probe.
if (!humanStatus) {
  die(
    "--human-submit-observed-status is required: perform the solved-widget " +
    "human submit yourself (README → Cloudflare Worker Deployment) and pass " +
    "the HTTP status you observed."
  );
}
const humanStatusNum = /^\d{3}$/.test(humanStatus) ? Number(humanStatus) : NaN;
if (!Number.isInteger(humanStatusNum) || humanStatusNum < 100 || humanStatusNum > 599) {
  die(`--human-submit-observed-status "${humanStatus}" is not an HTTP status code`);
}

console.log(`smoking ${BASE} …`);
const signup = await probe("GET", "/signup", { captureBody: true });
const signupMaterial = signupSessionMaterial(signup);
const machineChecks = {
  signup_page: {
    ok: signup.status === 200 && signupMaterial.cookie.includes("__Host-fr_sid=") && signupMaterial.csrf.length > 0,
    observed_status: signup.status,
    expect: "200 HTML with issued session cookie and CSRF field",
    ...(signup.transportError ? { transport_error: true } : {}),
  },
  health_build: null,
  submit_failclosed: null, // filled below
  human_submit: null, // filled below
};

const health = await probe("GET", "/health", { captureBody: true });
const healthBody = parseJsonBody(health.body);
const observedBuildSha = health.headers.get("x-fireraid-build") ?? healthBody?.build ?? null;
machineChecks.health_build = {
  ok: health.status === 200 && observedBuildSha === gitSha,
  observed_status: health.status,
  observed_build_sha: observedBuildSha,
  expect: `200 with X-FireRaid-Build exactly ${gitSha}`,
  ...(health.transportError ? { transport_error: true } : {}),
};

// Fail-closed probe: a submit WITHOUT any verification token must use the
// genuine GET-issued session and CSRF, otherwise an earlier
// generic rejection could masquerade as proof that Turnstile is enforced.
const failclosed = await probe("POST", "/api/submit", {
  headers: { cookie: signupMaterial.cookie },
  captureBody: true,
  body: {
    csrf: signupMaterial.csrf,
    form: { name: "smoke", email: `smoke-${Date.now()}@example.invalid` },
    eventBatch: [],
  },
});
const failclosedBody = parseJsonBody(failclosed.body);
machineChecks.submit_failclosed = {
  ok: failclosed.status === 403 && failclosedBody?.status === "verification_required",
  observed_status: failclosed.status,
  verification_status: failclosedBody?.status ?? null,
  expect: "403 JSON {status: verification_required} with a genuine session/CSRF",
  ...(failclosed.transportError ? { transport_error: true } : {}),
};

// Human submit: the operator's solved-widget run is the only real human
// path. The runner requires its OBSERVED status and applies the honest
// verdict (2xx = the applicant path works end-to-end).
machineChecks.human_submit = {
  ok: humanStatusNum >= 200 && humanStatusNum < 300,
  observed_status: humanStatusNum,
  expect: "2xx (a solved-widget human submission receives a success receipt)",
  source: "operator-observed", // honest provenance — the runner did NOT perform it
};

// ── 5. Mandatory authoritative version proof ────────────────────────────
const versions = spawnSync(
  "npx", ["wrangler", "versions", "list", "--env", "production", "--json"],
  { cwd: ROOT, encoding: "utf-8", timeout: 60_000, shell: false }
);
let versionsJson = null;
try { versionsJson = JSON.parse(versions.stdout ?? ""); } catch { /* unparseable */ }
const versionRows = Array.isArray(versionsJson) ? versionsJson : versionsJson?.versions;
const versionFound = Array.isArray(versionRows) && versionRows.some((row) => row?.id === workerVersion);
if (versions.status !== 0 || !versionFound) {
  die(
    `version ${workerVersion} was not returned by ${VERSION_LOOKUP} ` +
    `for Worker ${expectedWorkerName}; inspect Wrangler authentication/output before recording evidence.`
  );
}
const versionVerified = {
  ok: true,
  worker_name: expectedWorkerName,
  lookup: VERSION_LOOKUP,
  checked_at: new Date().toISOString(),
};
console.log(`version ${workerVersion} confirmed by ${VERSION_LOOKUP} (${expectedWorkerName})`);

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
  deployed_build_sha: gitSha,
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
