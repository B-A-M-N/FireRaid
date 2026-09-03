/**
 * DOM extractors — raw HTML and simplified DOM.
 * FR-INV: extractor is an independent experiment factor.
 */
import type { Page } from "@playwright/test";

export async function extractRawHtml(page: Page): Promise<string> {
  const html = await page.content();
  // Bound: return first 8000 chars to limit context
  let out = html.slice(0, 8000);
  // P0-FIX (E5): page.content() serializes the value ATTRIBUTE, not the
  // live value PROPERTY — a filled input looks identical to an empty one,
  // and agents loop re-filling the first field until the budget dies
  // (observed live in E5: CONTROL agents 13-step fill loops, both arms
  // equally poisoned). Append the live form state so progress is visible
  // while the raw HTML keeps the treatment-visible template content.
  const state = await page.evaluate(() => {
    const lines: string[] = [];
    document.querySelectorAll("input, textarea").forEach((el) => {
      const inp = el as HTMLInputElement | HTMLTextAreaElement;
      const id = inp.id || inp.name || "(unnamed)";
      const filled = inp.value ? `="${inp.value.slice(0, 60)}"` : " (empty)";
      lines.push(`${inp.tagName.toLowerCase()}#${id}${filled}`);
    });
    return lines;
  });
  if (state.length) out += "\n\n--- Live Field State ---\n" + state.join("\n");
  return out;
}

export async function extractSimplifiedDom(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const skipTags = new Set(["SCRIPT", "STYLE", "HEAD", "META", "LINK"]);
    const out: string[] = [];

    function walk(el: Element, depth: number) {
      if (depth > 8) return;
      const tag = el.tagName;
      if (skipTags.has(tag)) return;

      const attrs: string[] = [];
      for (const a of Array.from(el.attributes)) {
        if (a.name === "class" && a.value.includes("fr-")) continue; // hide fireraid markers from simplified view? No — keep for raw-dom
        if (a.name === "style") continue;
        attrs.push(`${a.name}="${a.value.slice(0, 80)}"`);
      }
      // Form controls carry their live state in the value PROPERTY, not an
      // attribute — surface it so the model can see which fields it has
      // already filled (otherwise a filled page looks identical to a fresh
      // one and the agent loops on the first field forever).
      if (tag === "INPUT" || tag === "TEXTAREA") {
        const inp = el as HTMLInputElement | HTMLTextAreaElement;
        if (inp.value) attrs.push(`value="${inp.value.slice(0, 80)}"`);
        if (tag === "INPUT" && (el as HTMLInputElement).checked) attrs.push("checked");
      }

      const text = el.children.length === 0
        ? (el.textContent || "").trim().slice(0, 100)
        : "";

      const attrStr = attrs.length ? " " + attrs.join(" ") : "";
      out.push(`${"  ".repeat(depth)}<${tag.toLowerCase()}${attrStr}>${text}`);

      for (const child of Array.from(el.children)) walk(child, depth + 1);
    }

    walk(document.body, 0);
    return out.slice(0, 500).join("\n");
  });
}
