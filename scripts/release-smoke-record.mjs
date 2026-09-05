#!/usr/bin/env node
/**
 * FR-P0-A — record the EXTERNAL post-deploy smoke receipt.
 *
 * Post-deployment evidence cannot live inside the git object it certifies
 * (a tracked deployed_sha self-invalidates when the recording commit moves
 * HEAD). The receipt is therefore an UNTRACKED file: release-smoke-receipt.json
 * (gitignored, regenerated per release).
 *
 * The operator performs the live smoke against the deployed Worker (see
 * README → Cloudflare Worker Deployment), then records it:
 *
 *   node scripts/release-smoke-record.mjs \
 *     --git-sha <sha that was deployed> \
 *     --worker-version <wrangler version id> \
 *     --url https://fireraid-production.<subdomain>.workers.dev \
 *     --checks signup_page,submit_failclosed,human_submit
 *
 * The script verifies the candidate SHA is exactly HEAD (a receipt for any
 * other SHA certifies nothing about this tree) and writes the receipt. The
 * next release:verify run picks it up and claims release_ready.
 *
 * Flags:
 *   --git-sha <sha>         REQUIRED. Must equal the current HEAD.
 *   --worker-version <id>   REQUIRED. The `wrangler deploy` version id.
 *   --url <url>             REQUIRED. The deployed Worker base URL.
 *   --checks <names>        REQUIRED. Comma-separated smoke checks actually
 *                           performed. Must include signup_page,
 *                           submit_failclosed, human_submit.
 *   --notes <text>          Optional free-text detail.
 */
import { writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "release-smoke-receipt.json");

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const gitSha = arg("git-sha");
const workerVersion = arg("worker-version");
const url = arg("url");
const checksArg = arg("checks");
const notes = arg("notes") ?? "";

const REQUIRED_CHECKS = ["signup_page", "submit_failclosed", "human_submit"];

function die(msg) {
  console.error(`release-smoke-record: ${msg}`);
  process.exit(1);
}

if (!gitSha || !workerVersion || !url || !checksArg) {
  die("--git-sha, --worker-version, --url, --checks are all required");
}

const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf-8" });
const head = r.status === 0 ? r.stdout.trim() : null;
if (!head) die("cannot resolve git HEAD");
if (gitSha !== head) {
  die(
    `--git-sha ${gitSha} does not equal current HEAD ${head}. A receipt certifies ` +
    "the deployed artifact against THIS tree; deploy the exact HEAD SHA and record that deployment."
  );
}

const performed = checksArg.split(",").map((s) => s.trim()).filter(Boolean);
const missing = REQUIRED_CHECKS.filter((c) => !performed.includes(c));
if (missing.length > 0) {
  die(`--checks must include all of: ${REQUIRED_CHECKS.join(", ")} (missing: ${missing.join(", ")})`);
}

if (existsSync(OUT)) {
  console.error("release-smoke-record: overwriting existing receipt for this SHA.");
}

const receipt = {
  schema: "fireraid-release-smoke-receipt/1",
  git_sha: gitSha,
  worker_version_id: workerVersion,
  deployed_url: url,
  recorded_at: new Date().toISOString(),
  checks: Object.fromEntries(REQUIRED_CHECKS.map((c) => [c, { ok: true }])),
  notes,
};

writeFileSync(OUT, JSON.stringify(receipt, null, 2) + "\n");
console.log(`release-smoke-record: receipt written to ${OUT}`);
console.log(`  git_sha:            ${receipt.git_sha}`);
console.log(`  worker_version_id:  ${receipt.worker_version_id}`);
console.log(`  deployed_url:       ${receipt.deployed_url}`);
console.log("The next `npm run release:verify` run will claim release_ready for this SHA.");
