/**
 * Raw-DOM autonomous agent — first attacker.
 * Architecture: Playwright → DOM extraction → LLM → structured action → validator → Playwright → repeat
 * FR-INV-001: LLM is only in harness, never in defense path.
 * FIX: Baseline prompt does not teach agent about FireRaid (FR-R2-028).
 * FIX: Implements constrained request action for canary routes (FR-R3-032).
 * FIX: Observes actual /api/submit response (FR-R3-031).
 * FIX: Resolves prompt variants via PROMPT_VARIANTS (FR-R4-037/038).
 * FIX: Implements navigate/select/check actions (FR-R4-044).
 * FIX: Stable element refs via buildElementRefs + data-fr-ref stamps (FR-R4-045).
 * FIX: Canary reference detection uses session-specific material (FR-R4-046).
 * FIX: Perception artifacts with SHA-256 hashes on every step (FR-R4-047).
 * FIX: Budget-aware LLM timeout (FR-R4-043).
 */
import { createHash } from "node:crypto";
import { chromium } from "@playwright/test";
import { extractRawHtml } from "../extractors/raw-html.js";
import { extractSimplifiedDom } from "../extractors/simplified-dom.js";
import { callLlm } from "../core/model.js";
import { validateAction, type AgentAction } from "../core/validator.js";
import type {
  AgentAdapter,
  AgentRunResult,
  Scenario,
  ExtractorType,
} from "../core/run-schema.js";
import type { Page } from "@playwright/test";
import { PROMPT_VARIANTS, resolvePrompt } from "./prompts.js";
import { buildElementRefs, selectorFor } from "./raw-dom-refs.js";

// ---------------------------------------------------------------------------
// Perception artifact helper
// ---------------------------------------------------------------------------

interface PerceptionArtifact {
  step: number;
  type: "raw-html" | "simplified-dom" | "accessibility";
  content: string;
  hash: string;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function finish(
  result: Omit<AgentRunResult, "perceptionArtifacts"> & {
    perceptionArtifacts?: PerceptionArtifact[];
  },
  perception: PerceptionArtifact[]
): AgentRunResult {
  return {
    ...result,
    perceptionArtifacts: perception,
  };
}

// ---------------------------------------------------------------------------
// Canary session-material detection (FR-R4-046)
// ---------------------------------------------------------------------------

async function detectCanaryReferenced(
  raw: string,
  page: Page
): Promise<{ canaryReferenced: boolean; canaryNote: string }> {
  // After goto, extract canary nonce from page
  let canaryNonce: string | null = null;
  try {
    const el = await page.locator("[data-fr-marker]").first();
    canaryNonce = await el.getAttribute("data-fr-marker").catch(() => null);
  } catch {
    // Element may not exist
  }

  // Scan /c/ route tokens from page URL links
  let canaryRoute: string | null = null;
  try {
    const html = await page.content();
    const match = html.match(/\/c\/([a-zA-Z0-9_-]+)/);
    if (match) canaryRoute = match[1];
  } catch {
    // Content extraction may fail
  }

  // Primary check: session-specific material referenced in output
  if ((canaryNonce && raw.includes(canaryNonce)) || (canaryRoute && raw.includes(canaryRoute))) {
    return { canaryReferenced: true, canaryNote: "session-material" };
  }

  // Raw-HTML fallback: if neither was found, check for /c/ URL-shaped path
  if (raw.includes("/c/")) {
    return { canaryReferenced: true, canaryNote: "generic" };
  }

  return {
    canaryReferenced: false,
    canaryNote: canaryNonce ?? canaryRoute ?? "none",
  };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class RawDomAdapter implements AgentAdapter {
  readonly type = "raw-dom" as const;
  readonly extractor: ExtractorType;

  constructor(extractor: ExtractorType = "raw-html") {
    this.extractor = extractor;
  }

  async run(scenario: Scenario): Promise<AgentRunResult> {
    const browser = await chromium.launch();
    const start = Date.now();
    const steps: Array<{ action: AgentAction; observation: string; step: number }> = [];
    let canaryTriggered = false;
    let canaryReferenced = false;
    let transcript = "";
    let sessionCookie: string | undefined;
    const perception: PerceptionArtifact[] = [];

    // FR-R4-037/038: Resolve prompt variant
    let systemPrompt: string;
    try {
      systemPrompt = resolvePrompt(scenario.promptVariant);
    } catch {
      return finish(
        {
          outcome: "error",
          actionCount: 0,
          elapsedMs: 0,
          transcript: "",
          sessionCookie,
          canaryTriggered: false,
          canaryReferenced: false,
          errorCode: "invalid_prompt_variant",
        },
        perception
      );
    }

    try {
      const page = await browser.newPage();

      // Capture session cookie from response
      page.on("response", (resp) => {
        const setCookie = resp.headers()["set-cookie"];
        if (setCookie && setCookie.includes("__Host-fr_sid")) {
          const match = setCookie.match(/__Host-fr_sid=([^;]+)/);
          if (match) sessionCookie = match[1];
        }
      });

      // Track canary endpoint hits
      page.on("request", (req) => {
        if (req.url().includes("/c/")) canaryTriggered = true;
      });

      await page.goto(`${scenario.targetUrl}/signup`, { waitUntil: "networkidle" });

      for (let step = 0; step < scenario.maxSteps; step++) {
        if (Date.now() - start > scenario.timeoutMs) {
          return finish(
            {
              outcome: "timeout",
              actionCount: steps.length,
              elapsedMs: Date.now() - start,
              transcript,
              sessionCookie,
              canaryTriggered,
              canaryReferenced,
            },
            perception
          );
        }

        // FR-R4-045: Stamp stable refs BEFORE extraction
        const refs = await buildElementRefs(page);

        // Extract DOM (refs are now stamped in DOM)
        const observation =
          this.extractor === "raw-html"
            ? await extractRawHtml(page)
            : await extractSimplifiedDom(page);

        // FR-R4-045: Build refs legend for simplified-dom
        let observationWithRefs = observation;
        if (this.extractor === "simplified-dom" && refs.size > 0) {
          const legendLines = Array.from(refs.values()).map(
            (r) => `${r.ref}: ${r.role} "${r.name}"`
          );
          observationWithRefs = observation + "\n\n--- Element References ---\n" + legendLines.join("\n");
        }

        // FR-R4-047: Store perception artifact with SHA-256 hash
        const perfType = this.extractor === "raw-html" ? "raw-html" : "simplified-dom";
        const perfHash = sha256(observationWithRefs);
        perception.push({
          step: step + 1,
          type: perfType,
          content: observationWithRefs.slice(0, 4000), // bound payload
          hash: perfHash,
        });

        // FR-R4-037: prepend prompt SHA to transcript for provenance
        const promptSha = sha256(systemPrompt);
        transcript += `\n[PROMPT_SHA256] ${promptSha}\n`;
        // FR-R4-046: record canary detection note
        const canaryNote = await detectCanaryReferenced(transcript, page);
        transcript += `\n[CANARY_REF] session-material:${canaryNote.canaryNote}\n`;
        if (canaryNote.canaryReferenced) {
          canaryReferenced = true;
        }

        // FR-R4-045: Update system prompt to document ref usage
        const enrichedSystem = systemPrompt +
          "\n\nUse the node ref from the observation when targeting elements (e.g., node-001).";

        // Build prompt
        const userPrompt = `${observationWithRefs}\n\nSynthetic applicant fixture: ${JSON.stringify(scenario.fixture)}\n\nReturn the next action as JSON.`;

        // FR-R4-043: Budget-aware timeout
        const remaining = scenario.timeoutMs - (Date.now() - start);
        const llmTimeout = Math.min(30000, Math.max(1000, remaining));

        // Call LLM
        let action: AgentAction;
        try {
          const raw = await callLlm(scenario.model, enrichedSystem, userPrompt, {}, llmTimeout);
          transcript += `\n--- Step ${step + 1} ---\n${raw}\n`;

          // FR-R4-046: Canary detection uses session-specific material
          const canaryResult = await detectCanaryReferenced(raw, page);
          if (canaryResult.canaryReferenced) {
            canaryReferenced = true;
            transcript += `\n[CANARY_REF] session-material:${canaryResult.canaryNote}\n`;
          }

          action = validateAction(raw);
        } catch {
          return finish(
            {
              outcome: "error",
              actionCount: steps.length,
              elapsedMs: Date.now() - start,
              transcript,
              sessionCookie,
              canaryTriggered,
              canaryReferenced,
              errorCode: "llm_error",
            },
            perception
          );
        }

        steps.push({ action, observation: observationWithRefs.slice(0, 4000), step: step + 1 });

        // Execute action
        try {
          switch (action.action) {
            case "fill":
              if (action.target && action.value) {
                await page.fill(selectorFor(action.target), action.value);
              }
              break;
            case "click":
              if (action.target) await page.click(selectorFor(action.target));
              break;
            // FR-R4-044: Implemented navigate/select/check actions
            case "navigate": {
              // Only allow http(s) URLs (FR-R4-044)
              if (action.target) {
                let parsed: URL;
                try {
                  parsed = new URL(action.target);
                } catch {
                  // Not a valid absolute URL — try as relative to targetUrl
                  try {
                    parsed = new URL(action.target, `${scenario.targetUrl}/`);
                  } catch {
                    // Invalid URL — skip
                    break;
                  }
                }
                if (parsed.protocol === "http:" || parsed.protocol === "https:") {
                  await page.goto(parsed.href);
                }
              }
              break;
            }
            case "select": {
              if (action.target && action.value !== undefined) {
                await page.selectOption(selectorFor(action.target), action.value);
              }
              break;
            }
            case "check": {
              if (action.target) {
                await page.check(selectorFor(action.target));
              }
              break;
            }
            case "request": {
              // Constrained: same-origin /c/ path only (FR-R3-032)
              if (action.target && action.target.match(/^\/c\/[a-zA-Z0-9_-]+$/)) {
                await page.evaluate((url) => fetch(url, { method: "GET" }), action.target);
              }
              break;
            }
            case "submit": {
              // Observe actual /api/submit response (FR-R3-031)
              const submitPromise = page.waitForResponse(
                (r) => r.url().endsWith("/api/submit") && r.request().method() === "POST",
                { timeout: 10000 }
              );
              await page.click("#submit-btn");
              try {
                const submitResp = await submitPromise;
                const submitJson = await submitResp.json();
                transcript += `\n[SUBMIT RESPONSE] ${JSON.stringify(submitJson)}\n`;
              } catch {
                // Response may not arrive if submit fails
              }
              return finish(
                {
                  outcome: "submitted",
                  actionCount: steps.length,
                  elapsedMs: Date.now() - start,
                  transcript,
                  sessionCookie,
                  canaryTriggered,
                  canaryReferenced,
                },
                perception
              );
            }
            case "stop":
              return finish(
                {
                  outcome: "stopped",
                  actionCount: steps.length,
                  elapsedMs: Date.now() - start,
                  transcript,
                  sessionCookie,
                  canaryTriggered,
                  canaryReferenced,
                },
                perception
              );
            case "handoff":
              return finish(
                {
                  outcome: "handoff",
                  actionCount: steps.length,
                  elapsedMs: Date.now() - start,
                  transcript,
                  sessionCookie,
                  canaryTriggered,
                  canaryReferenced,
                },
                perception
              );
          }
        } catch {
          // Action failed — continue
        }

        await page.waitForTimeout(500);
      }

      return finish(
        {
          outcome: "timeout",
          actionCount: steps.length,
          elapsedMs: Date.now() - start,
          transcript,
          sessionCookie,
          canaryTriggered,
          canaryReferenced,
        },
        perception
      );
    } catch {
      return finish(
        {
          outcome: "error",
          actionCount: steps.length,
          elapsedMs: Date.now() - start,
          transcript,
          sessionCookie,
          canaryTriggered,
          canaryReferenced,
          errorCode: "browser_error",
        },
        perception
      );
    } finally {
      await browser.close();
    }
  }
}

// Legacy: keep for backward compatibility
export const DEFAULT_SYSTEM = PROMPT_VARIANTS.baseline.system;
