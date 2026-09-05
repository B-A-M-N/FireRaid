/**
 * Security-header integrity — the CSP hash↔style-string parity contract.
 *
 * The decoy-field hiding technique ships as INLINE styles (P0-7: no host
 * CSS dependency). CSP has no 'unsafe-inline', so the exact style string is
 * allowlisted via its SHA-256 hash in SECURITY_HEADERS. If either side
 * changes alone — a renderer tweaks the hiding style, or the CSP is edited —
 * the browser silently refuses the style and the decoy becomes VISIBLE (or
 * worse, host CSS-dependent), with every test still green: nothing parses
 * computed styles in unit space.
 *
 * This test extracts BOTH strings from source and asserts the hash
 * relationship mechanically, so the parity can never silently drift again.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SECURITY_HEADERS } from "../../src/security/headers.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Extract a template-literal-free concatenated string constant from source. */
function extractStringConstant(src: string, constName: string): string {
  const re = new RegExp(`const ${constName}\\s*=\\s*([\\s\\S]*?);\\n`, "m");
  const m = src.match(re);
  if (!m) throw new Error(`${constName} not found in source`);
  // Concatenated double-quoted segments only — evaluate the simple form.
  const parts = [...m[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) =>
    x[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\")
  );
  if (parts.length === 0) throw new Error(`${constName} has no string segments`);
  return parts.join("");
}

describe("CSP hash ↔ decoy-hiding style parity", () => {
  it("SECURITY_HEADERS style-src hash matches the renderers' exact style string", () => {
    const csp = SECURITY_HEADERS["Content-Security-Policy"];
    const hashInCsp = csp.match(/style-src[^;]*'sha256-([A-Za-z0-9+/=]+)'/)?.[1];
    expect(hashInCsp, "CSP must allowlist the hiding style by hash").toBeTruthy();

    // BOTH renderers use the same constant name; each must match the hash.
    for (const file of [
      "src/core/renderer.ts",
      "src/host-adapter/reference-render.ts",
    ]) {
      const src = readFileSync(join(ROOT, file), "utf-8");
      const style = extractStringConstant(src, "VISUALLY_HIDDEN_STYLE");
      const computed = createHash("sha256").update(style).digest("base64");
      expect(computed, `${file} style hash vs CSP`).toBe(hashInCsp);
    }
  });

  it("the renderers' hiding styles are byte-identical to each other", () => {
    const a = extractStringConstant(
      readFileSync(join(ROOT, "src/core/renderer.ts"), "utf-8"),
      "VISUALLY_HIDDEN_STYLE"
    );
    const b = extractStringConstant(
      readFileSync(join(ROOT, "src/host-adapter/reference-render.ts"), "utf-8"),
      "VISUALLY_HIDDEN_STYLE"
    );
    expect(a).toBe(b);
  });
});
