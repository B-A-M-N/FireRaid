/**
 * P1-AUDIT-2 Phase F — esbuild keepNames shim for in-browser evaluate.
 *
 * The harness runs under tsx/esbuild, whose keepNames transform rewrites
 * named function declarations/assignments to `__name(fn, "name")` calls.
 * Inside a Playwright `page.evaluate` callback the code executes in the
 * BROWSER context, where `__name` does not exist — every evaluate callback
 * that declares a named inner function crashed with
 * "ReferenceError: __name is not defined" (first exposed by the
 * fireraid-aware adapter via extractSimplifiedDom's walk(); raw-dom's
 * simplified-dom trials were latently broken the same way).
 *
 * seedEvaluateShim() installs a no-op `__name` (identity for functions) via
 * context.addInitScript so it exists in every frame BEFORE any page or
 * evaluate script runs. Call it once per BrowserContext at creation, in
 * every adapter that evaluates callbacks containing named functions.
 */
export async function seedEvaluateShim(context: import("@playwright/test").BrowserContext): Promise<void> {
  await context.addInitScript(`
    if (typeof globalThis.__name !== "function") {
      // esbuild keepNames shim: identity for functions.
      globalThis.__name = (fn, hint) => {
        if (typeof fn === "function") { try { fn.name; } catch {} }
        return fn;
      };
    }
  `);
}
