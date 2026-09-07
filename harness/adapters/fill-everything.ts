/**
 * P1-AUDIT-2 Phase F — fill-everything adapter (omnivorous, NON-LLM).
 *
 * The attacker architecture the decoy-field family exists to catch: a script
 * that brute-fills EVERY input on the page — visible fields AND the
 * visually-hidden decoy (which programmatic enumeration sees regardless of
 * styling) — then submits. This is the causal path Class-A evidence pins:
 * a filled decoy ( decoyFieldPopulated, and with the semantic nonce present
 * in the page, decoyFieldMatchesNonce ) must QUARANTINE at the origin.
 *
 * Capability-row deviation from the P1-21 note (usesModel: LLM): the causal
 * mechanism — enumerate every field, fill it — is fully deterministic and
 * needs no model, so this adapter is NON-LLM (usesModel=false,
 * usesPrompt=false) exactly like dom-automation. An LLM spending tokens to
 * do what a 10-line loop does would be a cost defect, not an architecture.
 * If a model-backed omnivorous attacker is ever wanted, it is a DIFFERENT
 * row.
 *
 * Contrast with dom-automation (the visible-inputs attacker): dom-automation
 * MUST NOT trigger decoys (it is the legitimate-user proxy); fill-everything
 * MUST trigger them (it is the trap-springer). The pair brackets the decoy
 * field's true/false-positive behavior.
 *
 * FR-DEMO-02: accepts an optional AgentRunObserver and emits observations
 * AT THE EVENT POINT (page load, first fill, canary fetch, submit POST,
 * submit response) — the demo timeline streams live facts, not post-run
 * reconstructions.
 *
 * FR-DEMO-01: `outcome` no longer collapses a failed submit-response wait
 * into "submitted". The adapter reports whether the submit POST was
 * observed AND whether a response was received; the demo coordinator
 * combines these with server truth — a run whose response never arrived
 * can be INCONCLUSIVE, never silently BLOCKED.
 */
import { chromium } from "@playwright/test";
import { seedEvaluateShim } from "./evaluate-shim.js";
import type {
  AgentAdapter,
  AgentRunObserver,
  AgentRunResult,
  Scenario,
} from "../core/run-schema.js";
import { signupUrl } from "../core/urls.js";

export class FillEverythingAdapter implements AgentAdapter {
  readonly type = "fill-everything" as const;

  async run(scenario: Scenario, observer?: AgentRunObserver): Promise<AgentRunResult> {
    const browser = await chromium.launch();
    const start = Date.now();
    let canaryTriggered = false;
    let sessionCookie: string | undefined;
    let transcript = `fill-everything: omnivorous filler (non-LLM)\n`;
    let outcome: AgentRunResult["outcome"] = "error";
    let actionCount = 0;
    // FR-DEMO-01: the wire facts the ground-truth model needs. submitPosted
    // is true the moment the POST leaves the browser; submitResponded is
    // true only when the browser actually received the response.
    let submitPosted = false;
    let submitResponded = false;

    /** Failure-isolated observer dispatch — a broken stream never fails a run. */
    const safe = (
      fn?: ((arg?: string) => void) | ((status: "received" | "no-response", detail?: string) => void),
      arg?: string
    ): void => {
      try {
        (fn as (a?: string) => void)?.(arg);
      } catch { /* observer errors are not run errors */ }
    };

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

      // EVERY text-entry element — visible or not, decoy or not, ANY input
      // type that carries text (text/email/password/tel/url/search/number/
      // untyped) plus textareas. The only exclusions: hidden inputs and the
      // CSRF field (protocol, not a trap). The first cut only matched
      // type="text"/untyped — it silently skipped email/password and the
      // upstream rejected the registration for the missing email.
      const all = page.locator(
        'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"]):not([type="image"]):not([type="file"]), textarea'
      );
      const count = await all.count();
      const fixture = scenario.fixture as Record<string, string>;
      let filled = 0;
      for (let i = 0; i < count; i++) {
        const el = all.nth(i);
        const name = (await el.getAttribute("name")) ?? "";
        if (name === "csrf") continue;
        const value = fixture[name] ?? fixture["name"] ?? "synthetic-value";
        try {
          // fill() works on visually-hidden inputs (it does not require
          // visibility) — which is exactly the omnivore behavior.
          await el.fill(value, { timeout: 2000 });
          if (filled === 0) safe(observer?.onFillStarted);
          filled++;
          actionCount++;
        } catch {
          transcript += `[SKIP] ${name || `#${i}`} (fill rejected)\n`;
        }
      }
      transcript += `[FILL] ${filled}/${count} fields\n`;

      // Force-set ANYTHING still empty (strictly-invisible decoys that
      // Playwright fill() refuses) directly via DOM — the omnivore truly
      // covers every field.
      await page.evaluate((fixtureJson) => {
        const fx = JSON.parse(fixtureJson) as Record<string, string>;
        for (const el of Array.from(document.querySelectorAll("input, textarea"))) {
          const inp = el as HTMLInputElement;
          if (inp.type === "hidden" || inp.name === "csrf") continue;
          if (inp.value === "") {
            inp.value = fx[inp.name] ?? fx["name"] ?? "synthetic-value";
          }
        }
      }, JSON.stringify(fixture));
      actionCount++;

      // Submit via the visible submit button.
      await page.locator('#submit-btn, button[type="submit"]').first().click();
      // FR-DEMO-01: the wait no longer invents success. The response
      // listener above records what actually happened on the wire.
      await page
        .waitForResponse(
          (r) => /\/api\/(submit|register)$/.test(r.url()) && r.request().method() === "POST",
          { timeout: 10_000 }
        )
        .then(async (resp) => {
          const json = await resp.json().catch(() => ({}));
          transcript += `[SUBMIT RESPONSE] ${JSON.stringify(json)}\n`;
        })
        .catch(() => {
          transcript += `[SUBMIT RESPONSE] none received within timeout (posted=${submitPosted})\n`;
          safe(observer?.onSubmitResponse, "no-response");
        });
      // "submitted" now MEANS the POST was observed leaving the browser —
      // the outcome enum's contract. A dispatched-but-unanswered submit
      // still reports submitted (the POST is real); the coordinator uses
      // submitResponded for its ground-truth model.
      if (submitPosted) {
        outcome = "submitted";
      }
    } catch (err) {
      outcome = "error";
      transcript += `fill-everything error: ${err instanceof Error ? err.message : String(err)}\n`;
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
