/**
 * check-product-boundary.mjs
 *
 * Scans the PRODUCT dependency closure (the file list this script derives
 * from PRODUCT_FILES — the same whitelist tsconfig.product.json includes)
 * and enforces the product/evaluation build boundary as HARD ERRORS:
 *
 *   1. harness import                        — the attack harness is never
 *                                              in the shipped product.
 *   2. FIRERAID_LLM_ literal                 — provider config is harness-only.
 *   3. model-provider/openai/browser-use     — AI machinery is harness-only.
 *   4. D1Database / KVNamespace              — the origin product runs on
 *                                              node:http with NO Cloudflare
 *                                              binding; a D1 type in the
 *                                              product closure is a build
 *                                              failure, not a warning.
 *   5. product → src/eval import             — the dependency direction is
 *                                              evaluation → production,
 *                                              NEVER the reverse.
 *   6. product → src/cloudflare import       — D1 persistence is Worker-plane;
 *                                              the product closure must build
 *                                              and run without Cloudflare.
 *
 * If you add a product file, add it to PRODUCT_FILES (mirroring
 * tsconfig.product.json's include list) — the whitelist is the point.
 */
import { readFile } from "node:fs/promises";
import { resolve, relative, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// FR-RR-48: an overridable root (FIRERAID_BOUNDARY_ROOT) so the behavioral
// fixture tests can point the gate at a synthetic tree — same pattern as
// the production-graph checker's FIRERAID_GRAPH_ROOT.
const ROOT = process.env.FIRERAID_BOUNDARY_ROOT
  ? resolve(process.env.FIRERAID_BOUNDARY_ROOT)
  : resolve(fileURLToPath(import.meta.url), "..", "..");

/** The product dependency closure — MUST mirror tsconfig.product.json.
 * Under FIRERAID_BOUNDARY_ROOT the fixtures provide their own closure
 * entry (the synthetic worker-production.ts) instead. */
const PRODUCT_FILES = process.env.FIRERAID_BOUNDARY_ROOT
  ? ["src/worker-production.ts"]
  : [
  // core (host-neutral)
  "src/core/artifacts.ts",
  "src/core/catalog.ts",
  "src/core/correlation.ts",
  "src/core/decision.ts",
  "src/core/engine.ts",
  "src/core/prng.ts",
  "src/core/profile.ts",
  "src/core/recipe-schema.ts",
  "src/core/renderer.ts",
  "src/core/review.ts",
  "src/core/risk.ts",
  "src/core/session-envelope.ts",
  "src/core/session.ts",
  "src/core/tokens.ts",
  // types
  "src/types/event.ts",
  "src/types/index.ts",
  "src/types/profile.ts",
  "src/types/telemetry.ts",
  // telemetry (PURE modules only — D1 persistence is Worker-plane)
  "src/telemetry/aggregate.ts",
  "src/telemetry/state.ts",
  "src/telemetry/validate.ts",
  // security (env-free modules)
  "src/security/headers.ts",
  "src/security/request-validation.ts",
  // host adapter + origin runtime
  "src/host-adapter/interface.ts",
  "src/host-adapter/middleware.ts",
  "src/host-adapter/reference-adapters.ts",
  "src/host-adapter/reference-render.ts",
  "src/host-adapter/index.ts",
  "src/runtime/index.ts",
  "src/runtime/node.ts",
  // evaluation ENTRY (the only eval-plane file the product ships, so the
  // eval middleware can call the production admit body it wraps; it must
  // itself stay free of harness/Cloudflare/AI imports)
  "src/eval/evaluation-middleware.ts",
];

async function resolveImports(files) {
  // Walk the relative-import graph from PRODUCT_FILES so a product file
  // that imports a NEW helper is still checked (closure, not list).
  const seen = new Set();
  const queue = [...files];
  const edges = []; // { from, to, line, text }
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    let content;
    try {
      content = await readFile(join(ROOT, file), "utf-8");
    } catch {
      continue; // listed but absent — the tsc build will catch that
    }
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      // FR-RR-37: dynamic imports are edges too. A quoted string OR an
      // interpolated-free backtick template literal resolves statically;
      // anything else after `import(` is a computed specifier — recorded
      // as an UNRESOLVABLE edge (the boundary check below refuses it).
      const m = lines[i].match(/(?:from\s+|import\s*\(\s*)["'](\.[^"']+)["']/);
      const dyn = !m
        ? lines[i].match(/import\s*\(\s*`(\.[^`$]*)`\s*\)/)
        : null;
      // FR-RR-48 fix-note: `import("…")` in TYPE position (e.g.
      // `type CryptoKey = import("node:crypto").webcrypto.CryptoKey`) is a
      // compile-time type reference, not a runtime dynamic import — strip
      // type annotations before hunting computed specifiers.
      const typeStripped = lines[i].replace(/\btype\s+\w+\s*=\s*import\s*\([^)]*\)[^;]*/, "");
      const computed = !m && !dyn && /import\s*\(\s*[^)\s][^)]*[^)\s]*\)/.test(typeStripped)
        ? typeStripped.match(/import\s*\(\s*([^)]*)\)/)
        : null;
      if (computed) {
        edges.push({
          from: file,
          to: `<computed dynamic import> ${(computed[1] ?? "").trim().slice(0, 40)}`,
          line: i + 1,
          text: lines[i].trim(),
        });
        continue;
      }
      if (!m && !dyn) continue;
      const spec = (m ? m[1] : dyn[1]).replace(/\.js$/, ".ts");
      const resolvedRel = relative(ROOT, join(dirname(join(ROOT, file)), spec)).replace(/\\/g, "/");
      edges.push({ from: file, to: resolvedRel, line: i + 1, text: lines[i].trim() });
      if (!seen.has(resolvedRel)) queue.push(resolvedRel);
    }
  }
  return { files: [...seen].sort(), edges };
}

const VIOLATIONS = [
  {
    name: "harness import",
    test: (edge) => /(^|\/)harness\//.test(edge.to) || /["'][^"']*harness\//.test(edge.text),
  },
  {
    name: "FIRERAID_LLM literal",
    test: (edge, content) => content.includes("FIRERAID_LLM_"),
  },
  {
    name: "model-provider/openai/browser-use import",
    test: (edge) =>
      /(?:from\s+|import\s*\(\s*)["'][^"']*(?:model-provider|openai|browser-use)["']/.test(edge.text),
  },
  {
    name: "D1Database/KVNamespace annotation",
    test: (edge, content, _file) => {
      const lines = content.split("\n");
      return lines.some((l) => {
        const code = l.replace(/\/\/.*/, "").replace(/\/\*.*?\*\//, "");
        return code.includes("D1Database") || code.includes("KVNamespace");
      });
    },
  },
  {
    name: "product → src/eval import",
    test: (edge) =>
      edge.to.startsWith("src/eval/") && edge.from !== "src/eval/evaluation-middleware.ts",
  },
  {
    name: "product → src/cloudflare import",
    test: (edge) => edge.to.startsWith("src/cloudflare/"),
  },
  {
    // FR-RR-37: a computed dynamic import specifier cannot be verified to
    // stay inside the product closure — refused outright.
    name: "computed dynamic import",
    test: (edge) => edge.to.startsWith("<computed dynamic import>"),
  },
];

/** FR-RR-48: the violations evaluated PER EDGE (as opposed to file-level
 * rules like the LLM literal / D1 annotations, which run once per file).
 * Every entry of VIOLATIONS that names an edge rule MUST appear here —
 * the omission of "computed dynamic import" from the old inline list is
 * exactly the defect this closes. */
const EDGE_VIOLATION_NAMES = [
  "harness import",
  "model-provider/openai/browser-use import",
  "product → src/eval import",
  "product → src/cloudflare import",
  "computed dynamic import",
];

async function main() {
  const { files, edges } = await resolveImports(PRODUCT_FILES);

  if (!process.env.FIRERAID_BOUNDARY_ROOT && !files.includes("src/host-adapter/middleware.ts")) {
    console.error("Boundary check misconfigured: product closure did not resolve");
    process.exit(1);
  }

  const found = [];
  for (const file of files) {
    let content = "";
    try {
      content = await readFile(join(ROOT, file), "utf-8");
    } catch {
      continue;
    }
    for (const v of VIOLATIONS) {
      if (v.test({ from: file, to: "", line: 0, text: "" }, content, file)) {
        // File-level violations (literals, annotations): one finding.
        found.push(`${file}: ${v.name}`);
      }
    }
  }
  for (const edge of edges) {
    for (const v of VIOLATIONS) {
      // FR-RR-48: EVERY edge rule runs against every edge. The old
      // hand-picked list omitted "computed dynamic import", so a computed
      // specifier was recorded as an unresolvable edge and then NEVER
      // evaluated — the violation existed in name only.
      if (EDGE_VIOLATION_NAMES.includes(v.name)) {
        if (v.test(edge)) {
          found.push(`${edge.from}:${edge.line}: ${v.name} — ${edge.text}`);
        }
      }
    }
  }

  if (found.length === 0) {
    console.log(`product boundary OK (${files.length} files in closure, ${edges.length} internal edges)`);
    process.exit(0);
  }

  console.error("Product boundary VIOLATIONS (all fatal):");
  for (const f of [...new Set(found)]) {
    console.error(`  ${f}`);
  }
  process.exit(1);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
