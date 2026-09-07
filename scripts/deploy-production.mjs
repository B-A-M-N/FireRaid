#!/usr/bin/env node
/** Deploy the exact clean HEAD and inject its provenance into the Worker. */
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isGitSha } from "./lib/release-proof.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEMO_MODE = process.argv.includes("--demo");

function run(args) {
  return spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
}

const headResult = run(["rev-parse", "HEAD"]);
const sha = headResult.status === 0 ? headResult.stdout.trim() : "";
if (!isGitSha(sha)) {
  console.error("deploy-production: cannot resolve a 40-character git HEAD SHA");
  process.exit(1);
}
const dirtyResult = run(["status", "--porcelain"]);
if (dirtyResult.status !== 0) {
  console.error("deploy-production: cannot inspect git status");
  process.exit(1);
}
if (dirtyResult.stdout.trim()) {
  console.error("deploy-production: refusing to deploy a dirty worktree");
  process.exit(1);
}

console.log(`deploy-production: deploying clean HEAD ${sha}${DEMO_MODE ? " (demo showcase mode)" : ""}`);
const deploy = spawnSync(
  "npx",
  ["wrangler", "deploy", "--env", "production", "--var", `FIRERAID_BUILD_SHA:${sha}`],
  { cwd: ROOT, stdio: "inherit", shell: false }
);
process.exit(deploy.status ?? 1);
