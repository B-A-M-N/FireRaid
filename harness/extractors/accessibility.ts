/**
 * Accessibility tree extractor — captures AX tree for research agents.
 * FR-R3-045: AX perception measurement.
 * FR-R4-050: ax refs are now self-assigned (ax-001, ax-002, ...) from
 * numbered snapshot lines, NOT from Playwright's [ref=...] which does not
 * exist in ariaSnapshot output.
 *
 * Uses Playwright's ariaSnapshot() which is the same mechanism as Playwright MCP.
 * Returns structured AX tree for analysis of canary exposure in accessibility.
 */
import type { Page } from "@playwright/test";

export interface AXNode {
  role: string;
  name: string;
  ref: string;
  children?: AXNode[];
}

// ---------------------------------------------------------------------------
// Numbered snapshot format: "- ax-001 | textbox "Email""
// ---------------------------------------------------------------------------

/**
 * Transform raw ariaSnapshot lines into a numbered legend format.
 * Outputs lines like:
 *   - ax-001 | textbox "Email"
 *   - ax-002 | textbox "Password"
 * Returns both the text and a ref→metadata map.
 *
 * FR-R4-050: The old [ref=...] regex is gone. refs are assigned here from
 * the order of lines in the snapshot.
 */
export function numberSnapshot(
  snapshot: string
): { text: string; refs: Map<string, { role: string; name: string }>; lines: string[] } {
  const lines = snapshot.split("\n");
  const refs = new Map<string, { role: string; name: string }>();
  const numberedLines: string[] = [];
  let index = 0;

  for (const line of lines) {
    if (line.trim() === "") continue;
    // Match: - <role> "<name>" or - <role> (no name)
    const match = line.match(/^\s*-\s*(\w+)(?:\s+"([^"]+)")?/);
    if (match) {
      const ref = `ax-${String(index).padStart(3, "0")}`;
      const role = match[1];
      const name = match[2] || "";
      refs.set(ref, { role, name });
      numberedLines.push(`- ${ref} | ${role}${name ? ` "${name}"` : ""}`);
      index++;
    } else {
      // Non-element line (e.g., separator) — keep as-is but still number it
      const ref = `ax-${String(index).padStart(3, "0")}`;
      refs.set(ref, { role: "separator", name: "" });
      numberedLines.push(`- ${ref} | ${line.trim()}`);
      index++;
    }
  }

  return { text: numberedLines.join("\n"), refs, lines: numberedLines };
}

/**
 * Parse the numbered snapshot format back into AXNode[].
 * Expected format: "- ax-NNN | <role> \"<name>\""
 */
export function parseNumberedSnapshot(text: string): AXNode[] {
  const nodes: AXNode[] = [];
  const lines = text.split("\n").filter((l) => l.trim().startsWith("-"));

  for (const line of lines) {
    const match = line.match(
      /^\s*-\s+(ax-\d{3})\s+\|\s+(\w+)(?:\s+"([^"]+)")?/
    );
    if (match) {
      nodes.push({
        role: match[2],
        name: match[3] || "",
        ref: match[1],
      });
    }
  }

  return nodes;
}

/**
 * Extract accessibility tree snapshot as structured data.
 * This is what a Playwright MCP agent would perceive.
 * FR-R4-050: Uses parseNumberedSnapshot which no longer expects [ref=...].
 */
export async function extractAccessibilityTree(
  page: Page
): Promise<AXNode[]> {
  const snapshot = await page.locator("body").ariaSnapshot();
  const numbered = numberSnapshot(snapshot);
  return parseNumberedSnapshot(numbered.text);
}

/**
 * Extract accessibility tree as a flat text prompt.
 * Bounded to limit context size.
 * FR-R4-050: returns numbered snapshot lines.
 */
export async function extractAccessibilityPrompt(
  page: Page,
  maxChars: number = 6000
): Promise<string> {
  const snapshot = await page.locator("body").ariaSnapshot();
  const numbered = numberSnapshot(snapshot);
  return numbered.text.slice(0, maxChars);
}

/**
 * Search accessibility tree for specific content.
 * Used to determine if canary is exposed in AX tree.
 */
export async function searchAXTree(
  page: Page,
  searchTerms: string[]
): Promise<{ term: string; found: boolean; context: string }[]> {
  const snapshot = await page.locator("body").ariaSnapshot();
  const lowerSnapshot = snapshot.toLowerCase();

  return searchTerms.map((term) => {
    const lowerTerm = term.toLowerCase();
    const found = lowerSnapshot.includes(lowerTerm);
    const idx = lowerSnapshot.indexOf(lowerTerm);
    const context = found
      ? snapshot.slice(Math.max(0, idx - 40), idx + term.length + 40)
      : "";
    return { term, found, context };
  });
}

/**
 * Check if an element with given ref exists in AX tree.
 * FR-R4-050: Now checks for "ax-NNN" style refs, NOT "[ref=...]".
 */
export async function axElementExists(page: Page, ref: string): Promise<boolean> {
  const snapshot = await page.locator("body").ariaSnapshot();
  // Check for numbered ref like "ax-001"
  if (ref.startsWith("ax-")) {
    return snapshot.includes(ref);
  }
  // Legacy support for old [ref=...] format
  return snapshot.includes(`[ref=${ref}]`);
}
