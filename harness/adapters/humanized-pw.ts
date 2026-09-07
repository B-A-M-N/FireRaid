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
 *
 * FR-DEMO-03: the jitter RNG is PER-RUN (SeededRng), not module-global —
 * the paired demo runs both arms CONCURRENTLY, and a shared mutable state
 * made each arm's cadence depend on scheduler interleaving. The scenario's
 * fixtureId seeds the run (same trial id ⇒ same timing sequence), so arms
 * are independent yet identically parameterized — actually paired.
 *
 * FR-DEMO-02: accepts an optional AgentRunObserver (live event points).
 * FR-DEMO-01: submitPosted/submitResponded wire facts reported like
 * fill-everything's — a dropped submit is observable, never silent.
 */
import { chromium } from "@playwright/test";
import { seedEvaluateShim } from "./evaluate-shim.js";
import { SeededRng, seedFromString } from "./seeded-rng.js";
import type {
  AgentAdapter,
  AgentRunObserver,
  AgentRunResult,
  Scenario,
} from "../core/run-schema.js";
import { signupUrl } from "../core/urls.js";

const FIELD_PAUSE = [420, 620]; // thinking pause between fields (ms)
const KEY_DELAY = [95, 60]; // mean key delay + spread (ms)
const PRE_CLICK_PAUSE = [250, 150];

export class HumanizedPwAdapter implements AgentAdapter {
  readonly type = "humanized-pw" as const;

  async run(scenario: Scenario, observer?: AgentRunObserver): Promise<AgentRunResult> {
    const browser = await chromium.launch();
    const start = Date.now();
    let canaryTriggered = false;
    let sessionCookie: string | undefined;
    let transcript = `humanized-pw: humanized Playwright filler (non-LLM)\n`;
    let outcome: AgentRunResult["outcome"] = "error";
    let actionCount = 0;
    let submitPosted = false;
    let submitResponded = false;

    // FR-DEMO-03: instance-owned deterministic RNG, seeded by the scenario
    // identity (fixtureId when present). One run = one state; concurrent
    // arms never share it.
    const rng = new SeededRng(seedFromString(scenario.fixtureId ?? scenario.targetUrl));
    const jitter = (base: number, spread: number) => rng.jitter(base, spread);

    /** Failure-isolated observer dispatch. */
    const safe = (
      fn?: ((arg?: string) => void) | ((status: "received" | "no-response", detail?: string) => void),
      arg?: string
    ): void => {
      try {
        (fn as (a?: string) => void)?.(arg);
      } catch { /* observer errors are not run errors */ }
    };

    try {
      // FR-DEMO-10: the launch is an observable event point — emit it so the
      // demo timeline shows the browser start before any navigation.
      safe(observer?.onBrowserStarted);
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
        // The submit is the FORM's POST — /api/submit under FireRaid's client
        // script, the native action (/api/register) on a defenseless page
        // (CONTROL strips the client script, so the form posts natively).
        if (
          resp.request().method() === "POST" &&
          /\/api\/(submit|register)$/.test(resp.url())
        ) {
          submitResponded = true;
          safe(observer?.onSubmitResponse, "received");
        }
      });
      page.on("request", (req) => {
        if (req.url().includes("/c/")) {
          canaryTriggered = true;
          safe(observer?.onCanaryRequested, req.url());
        }
        if (
          req.method() === "POST" &&
          /\/api\/(submit|register)$/.test(req.url())
        ) {
          submitPosted = true;
          safe(observer?.onSubmitDispatched);
        }
      });

      await page.goto(signupUrl(scenario), { waitUntil: "networkidle" });
      safe(observer?.onPageLoaded, page.url());
      await page.waitForTimeout(jitter(600, 200)); // page-read pause
      safe(observer?.onFillStarted);

      // The VISIBLE legitimate fields, in DOM order — like a human tabbing.
      const visible = page.locator(
        'input:not([type="hidden"]):visible, textarea:visible'
      );
      const count = await visible.count();
      const fixture = scenario.fixture as Record<string, string>;
      for (let i = 0; i < count; i++) {
        const el = visible.nth(i);
        const name = (await el.getAttribute("name")) ?? "";
        // PERCEPTION GATE — a human fills only what they can perceive and
        // operate. Playwright's `:visible` accepts any non-empty bounding
        // box, which a visually-hidden field (1px box + clip-path/clip
        // zero-area technique) passes while being imperceptible to a
        // human. Filling such a field IS bot behavior — the traps depend
        // on it — so a human-plausible actor must hit-test before typing:
        // a usable size, no zero-area clip, and a center point whose
        // topmost element is the field itself.
        const perceivable = await el
          .evaluate((node) => {
            const r = node.getBoundingClientRect();
            if (r.width < 8 || r.height < 8) return false;
            const cs = getComputedStyle(node);
            if (cs.visibility === "hidden" || cs.display === "none") return false;
            if (parseFloat(cs.opacity) < 0.1) return false;
            const clip = `${cs.clipPath} ${cs.clip}`;
            if (/inset\(50%\)|rect\(0(px)?,\s*0(px)?,\s*0(px)?,\s*0(px)?\)/.test(clip))
              return false;
            const cx = r.left + r.width / 2;
            const cy = r.top + r.height / 2;
            const top = document.elementFromPoint(cx, cy);
            return top === node || node.contains(top) === true;
          })
          .catch(() => false);
        if (!perceivable) continue; // imperceptible — a human never sees it
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

      await submitBtn.click();
      actionCount++;
      // FR-DEMO-01: the wait no longer invents success — the response
      // listener records the wire truth.
      await page
        .waitForResponse(
          (r) => /\/api\/(submit|register)$/.test(r.url()) && r.request().method() === "POST",
          { timeout: 15_000 }
        )
        .then(async (resp) => {
          const json = await resp.json().catch(() => ({}));
          transcript += `[SUBMIT RESPONSE] ${JSON.stringify(json)}\n`;
        })
        .catch(() => {
          transcript += `[SUBMIT RESPONSE] none received within timeout (posted=${submitPosted})\n`;
          safe(observer?.onSubmitResponse, "no-response");
        });
      if (submitPosted) {
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
      submitPosted,
      submitResponded,
    };
  }
}
