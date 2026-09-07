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
 * P2 (rereview): DYNAMIC imports are edges too. `await import("../eval/x.js")`
 * reaches the same bundle as a static import (wrangler's bundler follows
 * string-literal dynamic specifiers), so this gate matches BOTH import
 * forms. A computed specifier (`import(variable)`) is UNVERIFIABLE here and
 * fails closed: the bundler would either error on it or emit an
 * unverifiable edge, and neither belongs in the production graph.
 *
 * Exit 1 on any reachable forbidden import; 0 otherwise.
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// P2 (testability): the root defaults to the repo but can be overridden
// (FIRERAID_GRAPH_ROOT) so the behavioral tests can point the gate at a
// synthetic fixture tree without touching the real one.
const ROOT = process.env.FIRERAID_GRAPH_ROOT
  ? resolve(process.env.FIRERAID_GRAPH_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Forbidden subtrees/films (repo-relative prefixes). */
const FORBIDDEN = [
  "src/eval/",
  "src/routes/lab.js", // resolved from the .ts import may be lab.ts
  "src/routes/lab.ts",
  "src/routes/admin-review-decision.js",
  "src/routes/admin-review-decision.ts",
  // FR-RR-01: the evaluation-plane admin analytics read lab-only tables
  // (experiments / harness_runs / lab_runs); the production artifact must
  // never bundle them, or the /readyz product schema contract lies.
  "src/routes/admin/evaluation.js",
  "src/routes/admin/evaluation.ts",
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
    recordEdge(rel, m[1] ?? m[2], dirname(file));
  }
  // P2: string-literal DYNAMIC imports — `await import("./x.js")` — are
  // real bundle edges (the wrangler bundler follows them). The static
  // regex above does not match the `import(` form, so scan for it
  // explicitly. FR-RR-37: the accepted literal forms are quotes AND a
  // backtick template literal WITHOUT interpolation (`` import(`./x.js`) ``
  // resolves exactly like the quoted form, so skipping it was an invisible
  // edge). A template WITH `${` or any other expression is unverifiable —
  // itself a violation (fail closed — no unverifiable edges in the
  // production graph).
  const dynRe = /\bimport\s*\(\s*("[^"]*"|'[^']*'|`[^`$]*`)\s*\)/g;
  while ((m = dynRe.exec(src))) {
    recordEdge(rel, m[1].slice(1, -1), dirname(file));
  }
  const computedRe = /\bimport\s*\(\s*[^)]*\)/g;
  while ((m = computedRe.exec(src))) {
    // Skip the literal forms already handled above (quote or plain backtick).
    if (/^import\s*\(\s*("[^"]*"|'[^']*'|`[^`$]*`)\s*\)$/.test(m[0].trim())) continue;
    violations.push({ from: rel, to: `<computed dynamic import> ${m[0].slice(0, 60)}` });
  }
}

/** Register an import edge: forbidden-target check + recursion. */
function recordEdge(rel, spec, fromDir) {
  const target = resolveSpecifier(spec, fromDir);
  if (!target) return;
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