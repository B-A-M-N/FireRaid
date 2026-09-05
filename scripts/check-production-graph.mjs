#!/usr/bin/env node
/**
 * FR-P1-05 — production Worker import-graph gate.
 *
 * Asserts the PRODUCTION entrypoint (src/worker-production.ts) has NO
 * transitive import path into the evaluation control plane:
 *
 *   - src/eval/                                (review-workflow, eval middleware)
 *   - src/routes/lab.ts                        (lab-run create/ingest/outcome)
 *   - src/routes/admin-review-decision.ts      (reviewer-decision WRITE)
 *   - any module that performs lab lifecycle mutation (expireStaleLabRuns)
 *
 * The property the release stakes is stronger than runtime LAB_MODE guarding:
 * a production deploy must not be able to create a lab run or finalize a
 * reviewer decision at all, because those handlers are ABSENT from the
 * production bundle. A runtime guard is only defense-in-depth.
 *
 * This gate walks the STATIC import graph (the thing wrangler's bundler will
 * actually resolve) and fails if any of the excluded subtrees is reachable.
 * Comments are stripped first so a prose mention of "src/eval/" in the
 * entrypoint header cannot defeat the check.
 *
 * Exit 1 on any reachable forbidden import; 0 otherwise.
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Forbidden subtrees/films (repo-relative prefixes). */
const FORBIDDEN = [
  "src/eval/",
  "src/routes/lab.js", // resolved from the .ts import may be lab.ts
  "src/routes/lab.ts",
  "src/routes/admin-review-decision.js",
  "src/routes/admin-review-decision.ts",
];

/** A module whose presence in production is itself the violation (it only
 * exists to carry the lab lifecycle mutation and is imported solely by the
 * lab route surface). */
const FORBIDDEN_MODULES = new Set(["src/routes/lab.ts", "src/routes/lab.js"]);

/** Strip line and block comments and string-y literals' trivia so an import
 * path written in a doc comment cannot register as a real edge. This is a
 * light lexer; it is sufficient for our import statements. */
function stripComments(src) {
  return (
    src
      // line comments
      .replace(/\/\/[^\n]*/g, "")
      // block comments
      .replace(/\/\*[\s\S]*?\*\//g, "")
  );
}

function resolveSpecifier(spec, fromDir) {
  if (!spec.startsWith(".") && !spec.startsWith("/")) return null; // bare specifier (node builtin/npm)
  const base = resolve(fromDir, spec);
  // TS worker sources import './x.js' but the source file is './x.ts'; the
  // bundler resolves the .js specifier to the .ts source. Mirror that here,
  // otherwise a .js-suffixed import to an eval module slips past the resolver.
  const candidates = [
    base,
    base.endsWith(".js") ? base.slice(0, -3) + ".ts" : null,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.json`,
    join(base, "index.ts"),
  ].filter(Boolean);
  for (const cand of candidates) {
    try {
      if (existsSync(cand) && statSync(cand).isFile()) return cand;
    } catch {
      /* continue */
    }
  }
  return null;
}

const seen = new Set();
const violations = [];

function walk(file) {
  if (seen.has(file)) return;
  seen.add(file);
  const rel = file.replace(`${ROOT}/`, "");
  const src = stripComments(readFileSync(file, "utf-8"));
  // type-only imports (`import type { X } from "..."`) are erased by the
  // TS/worker build and create NO runtime edge — they must not count as a
  // reachable path. Match real (value) imports only.
  const re = /import\s+(?!type\b)[\s\S]*?from\s+["']([^"']+)["']|import\s+["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(src))) {
    const spec = m[1] ?? m[2];
    const target = resolveSpecifier(spec, dirname(file));
    if (!target) continue;
    const trel = target.replace(`${ROOT}/`, "");
    if (FORBIDDEN.some((f) => f.endsWith("/") ? trel.startsWith(f) : trel === f)) {
      violations.push({ from: rel, to: trel });
    }
    if (FORBIDDEN_MODULES.has(trel)) {
      // Even if not a direct match above, a lab module import is a violation
      // whether it resolves to .ts or .js — record it.
      if (!violations.some((v) => v.from === rel && v.to === trel)) {
        violations.push({ from: rel, to: trel });
      }
    }
    walk(target);
  }
}

const entry = resolve(ROOT, "src/worker-production.ts");
if (!existsSync(entry)) {
  console.error("[FAIL] src/worker-production.ts does not exist");
  process.exit(1);
}
walk(entry);

if (violations.length === 0) {
  console.log("[PASS] production Worker import graph is clean — no path into");
  console.log("  src/eval/, src/routes/lab.ts, or the review-decision write.");
  process.exit(0);
}

console.error(`[FAIL] production Worker reaches ${violations.length} forbidden import(s):`);
for (const v of violations) {
  console.error(`  ${v.from} → ${v.to}`);
}
console.error("A production deployment must not bundle the evaluation control plane.");
process.exit(1);