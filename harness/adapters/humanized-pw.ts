/**
 * P1-AUDIT-2 Phase F — humanized-pw adapter (humanized Playwright, NON-LLM).
 *
 * The attacker the interaction-scoring family must NOT flag: Playwright
 * driven with humanlike cadence — click-to-focus each field, per-character
 * typing with jittered inter-key delays, pauses between fields, a pointer
 * move to the submit button before clicking. No LLM: the behavior model is
 * a fixed human-plausibility policy (the audit's "humanized timing"
 * architecture; if a model-authored cadence is ever wanted it is a
 * different, model-backed row).
 *
 * Experimental role: this is the FALSE-POSITIVE probe for the interaction
 * family. dom-automation/autofill fill programmatically (directFill,
 * ~0 completion time); raw-http sends no telemetry at all. humanized-pw
 * produces focus-first sequences, nonzero completionMs, pointer + key
 * streams — every weak signal the scorer uses, produced honestly. A
 * QUARANTINE on this adapter is a false positive by construction; the
 * ablation measures whether interaction scoring holds the line (REVIEW /
 * ACCEPT) against a patient mechanical human mimic.
 */
import { chromium } from "@playwright/test";
import type {
  AgentAdapter,
  AgentRunResult,
  Scenario,
} from "../core/run-schema.js";
import { signupUrl } from "../core/urls.js";

/** Deterministic jittered delay (seeded per-run, humanish 60–190ms). */
let rngState = 0x2f6e2b1;
function jitter(base: number, spread: number): number {
  // xorshift — deterministic per adapter run, no Math.random flake.
  rngState ^= rngState << 13;
  rngState ^= rngState >>> 17;
  rngState ^= rngState << 5;
  const u = (rngState >>> 0) / 0xffffffff;
  return Math.max(0, Math.round(base + (u - 0.5) * 2 * spread));
}

const FIELD_PAUSE = [420, 620]; // thinking pause between fields (ms)
const KEY_DELAY = [95, 60]; // mean key delay + spread (ms)
const PRE_CLICK_PAUSE = [250, 150];

export class HumanizedPwAdapter implements AgentAdapter {
  readonly type = "humanized-pw" as const;

  async run(scenario: Scenario): Promise<AgentRunResult> {
    const browser = await chromium.launch();
    const start = Date.now();
    let canaryTriggered = false;
    let sessionCookie: string | undefined;
    let transcript = `humanized-pw: humanized Playwright filler (non-LLM)\n`;
    let outcome: AgentRunResult["outcome"] = "error";
    let actionCount = 0;

    try {
      const page = await browser.newPage();
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
      await page.waitForTimeout(jitter(600, 200)); // page-read pause

      // The VISIBLE legitimate fields, in DOM order — like a human tabbing.
      const visible = page.locator(
        'input:not([type="hidden"]):visible, textarea:visible'
      );
      const count = await visible.count();
      const fixture = scenario.fixture as Record<string, string>;
      for (let i = 0; i < count; i++) {
        const el = visible.nth(i);
        const name = (await el.getAttribute("name")) ?? "";
        // Human selects the field with a CLICK (focus follows pointer).
        try {
          await el.click({ timeout: 3000 });
          actionCount++;
        } catch {
          continue; // unclickable — skip like a human would
        }
        await page.waitForTimeout(jitter(FIELD_PAUSE[0], FIELD_PAUSE[1]));

        // Type CHARACTER-BY-CHARACTER with jittered inter-key delays —
        // real keydown/input events, not el.fill().
        const value =
          fixture[name] ?? fixture["password"] ?? fixture["name"] ?? "synthetic-value";
        await el.pressSequentially(value, {
          delay: jitter(KEY_DELAY[0], KEY_DELAY[1]),
          timeout: 30_000,
        });
        actionCount++;
        await page.waitForTimeout(jitter(200, 120));
      }

      // Move the pointer to the submit button, pause, click — the human
      // closing move (real pointerdown near the end of the session).
      const submitBtn = page.locator('#submit-btn, button[type="submit"]').first();
      await submitBtn.hover();
      await page.waitForTimeout(jitter(PRE_CLICK_PAUSE[0], PRE_CLICK_PAUSE[1]));

      const submitPromise = page.waitForResponse(
        (r) => r.url().endsWith("/api/submit") && r.request().method() === "POST",
        { timeout: 15_000 }
      );
      await submitBtn.click();
      actionCount++;
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
      transcript += `humanized-pw error: ${err instanceof Error ? err.message : String(err)}\n`;
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
