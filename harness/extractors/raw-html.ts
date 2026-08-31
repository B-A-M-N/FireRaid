/**
 * DOM extractors — raw HTML and simplified DOM.
 * FR-INV: extractor is an independent experiment factor.
 */
import type { Page } from "@playwright/test";

export async function extractRawHtml(page: Page): Promise<string> {
  const html = await page.content();
  // Bound: return first 8000 chars to limit context
  return html.slice(0, 8000);
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
