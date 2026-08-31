/**
 * P1-21 — DOM-automation adapter (visible-inputs, NON-LLM).
 *
 * A realistic low-cost attacker: a Playwright script that fills only VISIBLE
 * inputs (the legitimate form fields) and submits — no LLM, no semantic
 * reasoning, no reading of hidden/AX-inert FireRaid markers. This is the
 * "DOM-automation (visible-inputs)" architecture the audit names: it targets
 * exactly the fields a human would, which is why decoy fields (hidden,
 * aria-hidden, tabindex=-1) must NOT be filled by it. If a decoy field were
 * ever visible, this adapter would populate it — that is the ablation signal.
 *
 * Non-LLM: usesModel=false, usesPrompt=false. Deterministic, cheap, no spend.
 * P1-21: ZERO origin-specific knowledge — no field-name prefixes, no decoy
 * class names, no FireRaid markers. The ONLY filter is visibility: every
 * visible editable field gets the fixture value it maps to. If a decoy field
 * were ever rendered visible, this adapter fills it like any other field —
 * that is exactly the ablation signal, and any prefix-based skip here would
 * hide it (circular measurement).
 */
import { chromium } from "@playwright/test";
import { seedEvaluateShim } from "./evaluate-shim.js";
import type {
  AgentAdapter,
  AgentRunResult,
  Scenario,
} from "../core/run-schema.js";
import { signupUrl } from "../core/urls.js";

export class DomAutomationAdapter implements AgentAdapter {
  readonly type = "dom-automation" as const;

  async run(scenario: Scenario): Promise<AgentRunResult> {
    const browser = await chromium.launch();
    const start = Date.now();
    let canaryTriggered = false;
    let sessionCookie: string | undefined;
    let transcript = `dom-automation: visible-inputs filler (non-LLM)\n`;
    let outcome: AgentRunResult["outcome"] = "error";
    let actionCount = 0;

    try {
      // P1-AUDIT-2 Phase F: seed the esbuild keepNames shim BEFORE any page
      // exists — page.evaluate callbacks with named inner functions crash
      // in the browser context otherwise (see adapters/evaluate-shim.ts).
      const context = await browser.newContext();
      await seedEvaluateShim(context);
      const page = await context.newPage();
      page.on("response", (resp) => {
        const setCookie = resp.headers()["set-cookie"];
        if (setCookie && setCookie.includes("__Host-fr_sid")) {
          const m = setCookie.match(/__Host-fr_sid=([^;]+)/);
          if (m) sessionCookie = m[1];
        }
      });
      page.on("request", (req) => {
        if (req.url().includes("/c/")) canaryTriggered = true;
      });

      await page.goto(signupUrl(scenario), { waitUntil: "networkidle" });

      // P1-21: fill every visible editable field by its name/id mapping —
      // no origin-specific skip list. Visibility is the only filter, so a
      // decoy rendered visible is filled (the honest ablation signal).
      const visible = page.locator(
        'input:not([type="hidden"]):visible, textarea:visible'
      );
      const count = await visible.count();
      const fixture = scenario.fixture as Record<string, string>;
      for (let i = 0; i < count; i++) {
        const el = visible.nth(i);
        const name = (await el.getAttribute("name")) ?? (await el.getAttribute("id")) ?? "";
        const value = fixture[name] ?? fixture["name"] ?? "synthetic-value";
        try {
          await el.fill(value);
          actionCount++;
        } catch {
          // element may be disabled/readonly — skip
        }
      }

      // Submit via the visible submit button.
      const submitPromise = page.waitForResponse(
        (r) => r.url().endsWith("/api/submit") && r.request().method() === "POST",
        { timeout: 10000 }
      );
      await page.locator('#submit-btn, button[type="submit"]').first().click();
      try {
        const resp = await submitPromise;
        const json = await resp.json().catch(() => ({}));
        transcript += `[SUBMIT RESPONSE] ${JSON.stringify(json)}\n`;
        outcome = "submitted";
      } catch {
        outcome = "submitted";
      }
    } catch (err) {
      outcome = "error";
      transcript += `dom-automation error: ${err instanceof Error ? err.message : String(err)}\n`;
    } finally {
      await browser.close();
    }

    return {
      outcome,
      actionCount,
      elapsedMs: Date.now() - start,
      transcript,
      sessionCookie,
      canaryTriggered,
      canaryReferenced: false,
    };
  }
}
