/**
 * FR-RR-48 — the product-boundary gate FAILS on computed dynamic imports.
 *
 * The checker recorded `import(variable)` as a `<computed dynamic import>`
 * edge and DEFINED a violation for it, but its edge-evaluation loop never
 * ran that rule — computed imports could not fail the gate. These tests
 * exercise the REAL script (spawned with FIRERAID_BOUNDARY_ROOT pointed at
 * a synthetic fixture tree) against:
 *
 *   1. the clean tree → exit 0
 *   2. import(variable)              → exit 1 (computed, unverifiable)
 *   3. import(`./${name}.js`)        → exit 1 (interpolated, unverifiable)
 *   4. import("./allowed.js")        → exit 0 (string literal, resolvable)
 *   5. import(`./allowed.js`)        → exit 0 (backtick, no interpolation)
 *   6. literal import into src/eval  → exit 1 (eval plane stays out)
 *   7. literal import into src/cloudflare → exit 1 (Worker plane stays out)
 *   8. a TYPE-position import()      → exit 0 (compile-time reference,
 *      never a runtime edge — the false positive this gate initially
 *      produced when the rule was first wired)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "scripts",
  "check-product-boundary.mjs"
);

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fr-boundary-"));
  mkdirSync(join(root, "src", "eval"), { recursive: true });
  mkdirSync(join(root, "src", "cloudflare"), { recursive: true });
  // The allowed worker entry: a clean production file.
  writeFileSync(join(root, "src", "worker-production.ts"), `export const ok = true;\n`);
  // An allowed sibling the dynamic imports may legally resolve to.
  writeFileSync(join(root, "src", "allowed.ts"), `export const allowed = 1;\n`);
  // The forbidden evaluation module.
  writeFileSync(join(root, "src", "eval", "secret.ts"), `export const secret = "eval-plane";\n`);
  // The forbidden Worker-plane module.
  writeFileSync(join(root, "src", "cloudflare", "d1.ts"), `export const d1 = "worker-plane";\n`);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function runGate(): { status: number; out: string } {
  const r = spawnSync("node", [SCRIPT], {
    encoding: "utf-8",
    env: { ...process.env, FIRERAID_BOUNDARY_ROOT: root },
  });
  return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

function patchEntry(content: string): void {
  writeFileSync(join(root, "src", "worker-production.ts"), content);
}

describe("FR-RR-48: check-product-boundary evaluates computed dynamic imports", () => {
  it("a clean tree passes", () => {
    expect(runGate().status).toBe(0);
  });

  it("import(variable) FAILS (computed specifier — unverifiable edge)", () => {
    patchEntry(
      `const name = "./allowed.js";\nconst m = await import(name);\nexport const ok = m;\n`
    );
    const r = runGate();
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/computed dynamic import/);
  });

  it("import(`./${name}.js`) FAILS (interpolated template — unverifiable edge)", () => {
    patchEntry(
      "const name = `allowed`;\nconst m = await import(`./${name}.js`);\nexport const ok = m;\n"
    );
    const r = runGate();
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/computed dynamic import/);
  });

  it("import(\"./allowed.js\") PASSES (string literal resolves inside the closure)", () => {
    patchEntry(`const m = await import("./allowed.js");\nexport const ok = m;\n`);
    expect(runGate().status).toBe(0);
  });

  it("import(`./allowed.js`) PASSES (backtick template WITHOUT interpolation resolves)", () => {
    patchEntry("const m = await import(`./allowed.js`);\nexport const ok = m;\n");
    expect(runGate().status).toBe(0);
  });

  it("a literal import into src/eval FAILS (eval plane stays out of the product)", () => {
    patchEntry(`import { secret } from "./eval/secret.js";\nexport const ok = secret;\n`);
    const r = runGate();
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/product → src\/eval import/);
  });

  it("a literal import into src/cloudflare FAILS (Worker plane stays out of the product)", () => {
    patchEntry(`import { d1 } from "./cloudflare/d1.js";\nexport const ok = d1;\n`);
    const r = runGate();
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/product → src\/cloudflare import/);
  });

  it("a TYPE-position import() PASSES (compile-time type reference, not a runtime edge)", () => {
    // The exact false positive the real tree hit when the rule was first
    // wired: session-envelope.ts's `type CryptoKey = import("node:crypto")…`.
    patchEntry(
      `type CryptoKey = import("node:crypto").webcrypto.CryptoKey;\nexport const ok: CryptoKey | null = null;\n`
    );
    expect(runGate().status).toBe(0);
  });
});
