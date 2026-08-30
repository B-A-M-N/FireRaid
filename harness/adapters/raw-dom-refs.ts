/**
 * Stable element refs for DOM-based adapters.
 * FR-R4-044/045: Stable element refs, no free-form CSS.
 * Stamps data-fr-ref attributes on interactive elements for deterministic
 * selectors that survive DOM mutations.
 */
import type { Page } from "@playwright/test";

export interface RefEntry {
  ref: string;
  role: string;
  name: string;
  locator: string;
}

/**
 * Build stable element refs from interactive elements in the signup form.
 * Stamps data-fr-ref attributes, then returns a Map of ref → RefEntry.
 */
export async function buildElementRefs(
  page: Page
): Promise<Map<string, RefEntry>> {
  const entries = await page.evaluate(() => {
    const elements: Array<{
      ref: string;
      role: string;
      name: string;
      locator: string;
    }> = [];

    const selectors = ["input", "textarea", "select", "button"];
    const allElements = document.querySelectorAll(selectors.join(", "));
    let i = 0;

    for (const el of Array.from(allElements)) {
      const ref = "node-" + String(i).padStart(3, "0");
      // Derive role from tag name
      const role = el.tagName.toLowerCase();
      // Derive name from label[for], aria-label, or name attribute
      let name = "";
      if (el.id) {
        const label = document.querySelector(`label[for="${el.id}"]`);
        if (label) name = label.textContent?.trim() || "";
      }
      if (!name) name = (el as HTMLElement).getAttribute("aria-label") || "";
      if (!name) {
        const nAttr = (el as HTMLElement).getAttribute("name");
        if (nAttr) name = nAttr;
      }
      // Stamping the data-fr-ref attribute here ensures it appears in
      // subsequent DOM/HTML extraction
      (el as HTMLElement).setAttribute("data-fr-ref", ref);
      const locator = `[data-fr-ref="${ref}"]`;
      elements.push({ ref, role, name, locator });
      i++;
    }

    return elements;
  });

  const map = new Map<string, RefEntry>();
  for (const e of entries) {
    map.set(e.ref, e);
  }
  return map;
}

/**
 * Resolve a target string to a Playwright selector.
 * FR-R4-045: node-ref targets map to [data-fr-ref="..."];
 * legacy targets fall back to #id or [name="..."].
 */
export function selectorFor(target: string): string {
  if (/^node-\d{3}$/.test(target)) {
    return `[data-fr-ref="${target}"]`;
  }
  // Legacy fallback: keep backward compatibility for any code
  // that still emits bare IDs or name-based selectors.
  return `#${target}, [name="${target}"]`;
}
