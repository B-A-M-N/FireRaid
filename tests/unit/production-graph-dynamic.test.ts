/**
 * P2 (rereview) — the production-graph gate catches DYNAMIC imports.
 *
 * The gate used to walk only static `import … from` statements, so
 * `await import("../eval/foo.js")` reached the production bundle while the
 * gate stayed green. These tests exercise the REAL script (spawned with
 * FIRERAID_GRAPH_ROOT pointed at a synthetic fixture tree) against:
 *
 *   1. the clean tree → exit 0
 *   2. a STATIC import into src/eval/ → exit 1 (pre-existing behavior)
 *   3. a string-literal DYNAMIC import into src/eval/ → exit 1 (the new edge)
 *   4. a TRANSITIVE dynamic import (via an intermediate module) → exit 1
 *   5. a computed dynamic import (import(variable)) → exit 1 (fail closed —
 *      an unverifiable edge cannot ride through the production graph)
 *   6. a dynamic import to an allowed module → exit 0 (no false positive)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "check-production-graph.mjs");

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fr-graph-"));
  mkdirSync(join(root, "src", "eval"), { recursive: true });
  // The allowed worker: a clean production entry.
  writeFileSync(
    join(root, "src", "worker-production.ts"),
    `import { handler } from "./handler.js";\nexport default handler;\n`
  );
  writeFileSync(
    join(root, "src", "handler.ts"),
    `export const handler = () => "ok";\n`
  );
  // The forbidden evaluation module.
  writeFileSync(
    join(root, "src", "eval", "secret.ts"),
    `export const secret = "eval-plane";\n`
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function runGate(): { status: number; out: string } {
  const r = spawnSync("node", [SCRIPT], {
    encoding: "utf-8",
    env: { ...process.env, FIRERAID_GRAPH_ROOT: root },
  });
  return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

function patchEntry(content: string): void {
  writeFileSync(join(root, "src", "worker-production.ts"), content);
}

describe("P2: check-production-graph walks dynamic imports", () => {
  it("a clean tree passes", () => {
    expect(runGate().status).toBe(0);
  });

  it("a STATIC import into src/eval/ fails (pre-existing behavior intact)", () => {
    patchEntry(`import { secret } from "./eval/secret.js";\nexport const x = secret;\n`);
    const r = runGate();
    expect(r.status).toBe(1);
    expect(r.out).toContain("src/eval/secret.ts");
  });

  it("a string-literal DYNAMIC import into src/eval/ fails (the new edge)", () => {
    patchEntry(
      `export async function f() {\n  const m = await import("./eval/secret.js");\n  return m.secret;\n}\n`
    );
    const r = runGate();
    expect(r.status).toBe(1);
    expect(r.out).toContain("src/eval/secret.ts");
  });

  it("a TRANSITIVE dynamic import (through an intermediate module) fails", () => {
    writeFileSync(
      join(root, "src", "lazy.ts"),
      `export async function lazy() {\n  return (await import("./eval/secret.js")).secret;\n}\n`
    );
    patchEntry(`import { lazy } from "./lazy.js";\nexport const p = lazy();\n`);
    const r = runGate();
    expect(r.status).toBe(1);
    expect(r.out).toContain("src/eval/secret.ts");
  });

  it("a COMPUTED dynamic import fails closed (unverifiable edge)", () => {
    patchEntry(
      `const name = "./eval/secret.js";\nexport async function f() {\n  return import(name);\n}\n`
    );
    const r = runGate();
    expect(r.status).toBe(1);
    expect(r.out).toContain("computed dynamic import");
  });

  it("a dynamic import to an ALLOWED module passes (no false positive)", () => {
    writeFileSync(join(root, "src", "late.ts"), `export const late = 1;\n`);
    patchEntry(
      `export async function f() {\n  return (await import("./late.js")).late;\n}\n`
    );
    expect(runGate().status).toBe(0);
  });

  // ── FR-RR-37: template-literal specifiers are import edges too ──────────
  it("a BACKTICK template-literal dynamic import into src/eval/ fails (was invisible)", () => {
    // `import(`./eval/secret.js`)` matched neither the quoted-literal scan
    // nor the computed-identifier refusal — an invisible edge into the
    // evaluation plane.
    patchEntry(
      "export async function f() {\n  return (await import(`./eval/secret.js`)).secret;\n}\n"
    );
    const r = runGate();
    expect(r.status).toBe(1);
    expect(r.out).toContain("src/eval/secret.ts");
  });

  it("a backtick dynamic import to an ALLOWED module passes (no false positive)", () => {
    writeFileSync(join(root, "src", "late.ts"), `export const late = 1;\n`);
    patchEntry(
      "export async function f() {\n  return (await import(`./late.js`)).late;\n}\n"
    );
    expect(runGate().status).toBe(0);
  });

  it("an INTERPOLATED template specifier fails closed (unverifiable edge)", () => {
    patchEntry(
      "const base = `./eval`;\nexport async function f() {\n  return import(`${base}/secret.js`);\n}\n"
    );
    const r = runGate();
    expect(r.status).toBe(1);
    expect(r.out).toContain("computed dynamic import");
  });
});
