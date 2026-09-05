/**
 * HTML-context serialization boundaries for operator-supplied values.
 *
 * The renderers interpolate two classes of strings into emitted HTML:
 *   1. Server-internal material (nonce, field name, route token) — fixed,
 *      reviewed alphabets (A-Z2-9 / hex), structurally injection-proof.
 *   2. Operator/deployment configuration — clientScriptSrc, route endpoints,
 *      Turnstile site key, CSRF cookie material. These are trusted inputs in
 *      the threat model, but they are still interpolated into markup, so a
 *      misconfiguration (or a future server-controlled field landing in the
 *      same artifact) must not be able to break out of its HTML context.
 *
 * Both helpers are pure serialization: they never decide WHAT is emitted.
 */

/**
 * Escape a string for safe interpolation into HTML text or a
 * double-quoted attribute value. `&` first so later entities are not
 * double-encoded.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Serialize a value for a `<script type="application/json">` island.
 *
 * JSON.stringify emits `<` verbatim, so any string in the payload may end
 * the island early (`</script>`) or open a new element (`<script>`). Script
 * content is RAW TEXT — character references are not decoded — so HTML
 * entities cannot be used; the JSON-native `<` escape is the correct
 * neutralizer. Every breakout form (`</script`, `<!--`, `<script`) requires
 * a literal `<`, so escaping `<` alone closes all of them, and
 * `JSON.parse` restores the original value losslessly (the browser client
 * reads islands via `JSON.parse(el.textContent)`).
 */
export function jsonForScriptIsland(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003C");
}
