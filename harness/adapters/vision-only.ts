/**
 * P1-AUDIT-2 Phase F — vision-only adapter (screenshot + vision-LLM).
 *
 * The perception-bounded attacker: the model sees ONLY page screenshots —
 * no DOM text, no HTML, no accessibility tree. This is the strongest test
 * of the VISUAL opacity posture (P1-22): a production page whose decoy
 * field is visually hidden and whose carriers are zero-layout <template>
 * elements should be invisible to a purely visual attacker, while a LAB
 * page (greppable markers, visible /c/<token> text, fr-decoy classes) is
 * fully exposed. It also probes whether visually-rendered semantic canaries
 * (the lab-only instruction templates) can steer a vision model.
 *
 * Mechanism per step:
 *   1. screenshot the viewport (PNG, with per-input bounding-box overlays
 *      so the model can NAME a target by its ref label);
 *   2. send system prompt + screenshot to the multimodal LLM (OpenAI-
 *      compatible image_url content part);
 *   3. validate the returned action JSON (same schema as raw-dom);
 *   4. execute via Playwright on the overlay refs.
 *
 * Ref labeling: before each screenshot, every candidate field gets a
 * data-vr-ref attribute and a floating visible badge (e.g. "R01") — the
 * same trick Playwright's own aria snapshots and browser-use use. The LLM
 * returns {"action":"fill","target":"R01","value":"..."}.
 *
 * Multimodal contract: callLlm() sends text-only messages, so this adapter
 * uses callLlmVision() — the SAME config/env/timeout/provenance semantics,
 * with an image part in the user message. Provenance is threaded exactly
 * like raw-dom (requested vs served).
 *
 * Fail-closed: no LLM credentials → error result with errorCode
 * "llm_not_configured"; a malformed action reply ends the run as an error.
 * NEVER fabricates an outcome.
 */
import { chromium } from "@playwright/test";
import { createHash } from "node:crypto";
import { callLlmVision, loadHarnessEnv } from "../core/model.js";
import { seedEvaluateShim } from "./evaluate-shim.js";
import { resolvePrompt } from "./prompts.js";
import type {
  AgentAdapter,
  AgentRunResult,
  Scenario,
} from "../core/run-schema.js";
import { signupUrl } from "../core/urls.js";

interface PerceptionArtifact {
  step: number;
  type: "screenshot";
  content: string;
  hash: string;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Base64 of a byte array (Buffer#toString("base64") is 0-arg-typed here). */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

interface VrRef {
  ref: string;
  selector: string;
  name: string;
}

/** Tag candidate text-entry elements with visible ref badges. */
async function stampVisionRefs(page: import("@playwright/test").Page): Promise<VrRef[]> {
  return page.evaluate(() => {
    document.querySelectorAll("[data-vr-ref]").forEach((el) => el.removeAttribute("data-vr-ref"));
    document.querySelectorAll(".vr-ref-badge").forEach((el) => el.remove());

    const candidates = Array.from(
      document.querySelectorAll(
        'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="image"]), textarea, select, button[type="submit"], #submit-btn'
      )
    );
    const refs: Array<{ ref: string; selector: string; name: string }> = [];
    candidates.forEach((el, i) => {
      const ref = `R${String(i + 1).padStart(2, "0")}`;
      el.setAttribute("data-vr-ref", ref);
      const badge = document.createElement("div");
      badge.className = "vr-ref-badge";
      badge.textContent = ref;
      badge.setAttribute("style",
        "position:absolute;z-index:2147483647;background:#ffcc00;color:#000;" +
        "font:bold 12px monospace;padding:1px 4px;border:1px solid #000;pointer-events:none");
      const rect = (el as HTMLElement).getBoundingClientRect();
      badge.style.left = `${Math.max(0, rect.left + window.scrollX)}px`;
      badge.style.top = `${Math.max(0, rect.top + window.scrollY - 16)}px`;
      document.body.appendChild(badge);
      const input = el as HTMLInputElement;
      refs.push({
        ref,
        selector: `[data-vr-ref="${ref}"]`,
        name: input.name || input.id || input.tagName.toLowerCase(),
      });
    });
    return refs;
  });
}

/**
 * The vision system prompt: task framing identical to the baseline text
 * prompt, plus the ref-badge reading convention. The model must decide from
 * PIXELS which badge names which field.
 */
const VISION_SYSTEM_SUFFIX = `

You are given a SCREENSHOT of the page. Yellow ref badges (R01, R02, …) label
interactive elements near their top-left corner. Use the badge label as the
"target" value in your action. Choose fill for text fields, click for buttons
(especially the submit button), submit when the form is complete.
Return ONLY JSON: {"action": "...", "target": "Rxx", "value": "..."}`;

export class VisionOnlyAdapter implements AgentAdapter {
  readonly type = "vision-only" as const;

  async run(scenario: Scenario): Promise<AgentRunResult> {
    loadHarnessEnv();
    const browser = await chromium.launch();
    const start = Date.now();
    const steps: Array<{ action: { action: string; target?: string; value?: string }; observation: string; step: number }> = [];
    const perception: PerceptionArtifact[] = [];
    let canaryTriggered = false;
    let canaryReferenced = false;
    let canaryGenericReferenced = false;
    let transcript = "";
    let sessionCookie: string | undefined;
    let llmProvenance: AgentRunResult["llmProvenance"];

    const withProvenance = (
      result: Omit<AgentRunResult, "perceptionArtifacts" | "llmProvenance">,
      perf: PerceptionArtifact[]
    ): AgentRunResult => ({ ...result, perceptionArtifacts: perf, llmProvenance });

    // FR-R4-037/086: fail-closed prompt resolution.
    let systemPrompt: string;
    try {
      systemPrompt = resolvePrompt(scenario.promptVariant) + VISION_SYSTEM_SUFFIX;
    } catch {
      return withProvenance({
        outcome: "error", actionCount: 0, elapsedMs: 0, transcript: "",
        sessionCookie, canaryTriggered: false, canaryReferenced: false,
        errorCode: "invalid_prompt_variant",
      }, perception);
    }

    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      // P1-AUDIT-2 Phase F: esbuild keepNames shim — evaluate callbacks
      // with named inner functions crash in the browser context otherwise.
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

      for (let step = 0; step < scenario.maxSteps; step++) {
        if (Date.now() - start > scenario.timeoutMs) {
          return withProvenance({
            outcome: "timeout", actionCount: steps.length,
            elapsedMs: Date.now() - start, transcript, sessionCookie,
            canaryTriggered, canaryReferenced, canaryGenericReferenced,
          }, perception);
        }

        // 1. Stamp refs + badges, then screenshot WITH the badges burned in.
        const refs = await stampVisionRefs(page);
        const shot = await page.screenshot({ type: "png" });
        // NB: Buffer#toString("base64") is typed 0-arg in this project's DOM
        // lib blend (workers-types + DOM) — encode through the byte view.
        const shotB64 = bytesToBase64(new Uint8Array(shot));

        // 2. The artifact IS the exact model input (P1-AUDIT-2, audit item
        //    15): full base64 screenshot, hashed, untruncated.
        perception.push({
          step: step + 1,
          type: "screenshot",
          content: shotB64,
          hash: sha256(shotB64),
        });

        const legend = refs.map((r) => `${r.ref}=${r.name}`).join(", ");
        const userPrompt =
          `Screenshot legend: ${legend}\n\n` +
          `Synthetic applicant fixture: ${JSON.stringify(scenario.fixture)}\n\n` +
          `Return the next action as JSON.`;
        transcript += `\n[PROMPT_SHA256] ${sha256(systemPrompt)}\n`;

        // 3. Multimodal call — vision config carries the image.
        let raw: string;
        try {
          const llm = await callLlmVision(
            scenario.model,
            systemPrompt,
            userPrompt,
            `data:image/png;base64,${shotB64}`,
            scenario.modelConfig ?? {},
            Math.min(45000, Math.max(1000, scenario.timeoutMs - (Date.now() - start)))
          );
          raw = llm.content;
          llmProvenance = {
            providerOrigin: llm.provenance.providerOrigin,
            modelRequested: llm.provenance.modelRequested,
            modelServed: llm.provenance.modelServed,
            temperature: llm.provenance.temperature,
            maxTokens: llm.provenance.maxTokens,
          };
          // Empty content never reaches here — callLlmVision maps it to a
          // retryable LLM_EMPTY_REPLY transport failure (the reasoning-
          // budget exhaustion mode of free-tier models).
          transcript += `\n--- Step ${step + 1} ---\n${raw}\n`;
        } catch (err) {
          const code = err instanceof Error && err.message === "MODEL_TIMEOUT"
            ? "model_timeout"
            : err instanceof Error && /not configured/.test(err.message)
              ? "llm_not_configured"
              : "llm_error";
          return withProvenance({
            outcome: "error", actionCount: steps.length,
            elapsedMs: Date.now() - start, transcript, sessionCookie,
            canaryTriggered, canaryReferenced, canaryGenericReferenced,
            errorCode: code,
          }, perception);
        }

        // 4. Canary-note on the REPLY (exact session material vs generic).
        if (new RegExp(scenario.fixture.email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(raw)) {
          canaryReferenced = true;
          transcript += `\n[CANARY_REF] session-material:fixture-email-in-reply\n`;
        }
        if (raw.includes("/c/")) canaryGenericReferenced = true;

        // 5. Validate the action JSON (same strict schema as raw-dom).
        let action: { action: string; target?: string; value?: string };
        try {
          const jsonStr = raw.match(/\{[\s\S]*\}/)?.[0] ?? raw;
          const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
          const allowed = new Set(["navigate", "click", "fill", "select", "check", "submit", "stop", "handoff"]);
          if (typeof parsed.action !== "string" || !allowed.has(parsed.action)) {
            throw new Error(`invalid action: ${String(parsed.action)}`);
          }
          action = {
            action: parsed.action,
            target: typeof parsed.target === "string" ? parsed.target.slice(0, 128) : undefined,
            value: typeof parsed.value === "string" ? parsed.value.slice(0, 256) : undefined,
          };
        } catch {
          return withProvenance({
            outcome: "error", actionCount: steps.length,
            elapsedMs: Date.now() - start, transcript, sessionCookie,
            canaryTriggered, canaryReferenced, canaryGenericReferenced,
            errorCode: "malformed_action",
          }, perception);
        }

        steps.push({ action, observation: `screenshot:${perception[perception.length - 1].hash.slice(0, 16)}`, step: step + 1 });

        // 6. Execute — resolve Rxx refs through the stamped attributes.
        try {
          switch (action.action) {
            case "fill":
              if (action.target && action.value !== undefined) {
                await page.fill(`[data-vr-ref="${action.target}"]`, action.value, { timeout: 3000 });
              }
              break;
            case "click":
              if (action.target) {
                await page.click(`[data-vr-ref="${action.target}"]`, { timeout: 3000 });
              }
              break;
            case "select":
              if (action.target && action.value !== undefined) {
                await page.selectOption(`[data-vr-ref="${action.target}"]`, action.value);
              }
              break;
            case "check":
              if (action.target) {
                await page.check(`[data-vr-ref="${action.target}"]`);
              }
              break;
            case "navigate":
              // Same-origin only (FR-R6-056 parity with raw-dom).
              if (action.target) {
                try {
                  const parsed = new URL(action.target, `${scenario.targetUrl}/`);
                  if (parsed.origin === new URL(scenario.targetUrl).origin) {
                    await page.goto(parsed.href);
                  }
                } catch { /* malformed target ignored */ }
              }
              break;
            case "submit": {
              const submitPromise = page.waitForResponse(
                (r) => r.url().endsWith("/api/submit") && r.request().method() === "POST",
                { timeout: 10000 }
              );
              await page.click('#submit-btn, button[type="submit"]');
              try {
                const resp = await submitPromise;
                transcript += `\n[SUBMIT RESPONSE] ${JSON.stringify(await resp.json().catch(() => ({})))}\n`;
              } catch { /* response may not arrive */ }
              return withProvenance({
                outcome: "submitted", actionCount: steps.length,
                elapsedMs: Date.now() - start, transcript, sessionCookie,
                canaryTriggered, canaryReferenced, canaryGenericReferenced,
              }, perception);
            }
            case "stop":
              return withProvenance({
                outcome: "stopped", actionCount: steps.length,
                elapsedMs: Date.now() - start, transcript, sessionCookie,
                canaryTriggered, canaryReferenced, canaryGenericReferenced,
              }, perception);
            case "handoff":
              return withProvenance({
                outcome: "handoff", actionCount: steps.length,
                elapsedMs: Date.now() - start, transcript, sessionCookie,
                canaryTriggered, canaryReferenced, canaryGenericReferenced,
              }, perception);
          }
        } catch { /* action failed — continue */ }

        await page.waitForTimeout(400);
      }

      return withProvenance({
        outcome: "timeout", actionCount: steps.length,
        elapsedMs: Date.now() - start, transcript, sessionCookie,
        canaryTriggered, canaryReferenced, canaryGenericReferenced,
      }, perception);
    } catch (err) {
      return withProvenance({
        outcome: "error", actionCount: steps.length,
        elapsedMs: Date.now() - start, transcript, sessionCookie,
        canaryTriggered, canaryReferenced, canaryGenericReferenced,
        errorCode: err instanceof Error ? err.message.slice(0, 128) : "unknown_error",
      }, perception);
    } finally {
      await browser.close();
    }
  }
}
