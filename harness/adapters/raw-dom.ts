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
import { signupUrl } from "../core/urls.js";

// ---------------------------------------------------------------------------
// Origin pinning (FR-R6-056)
// ---------------------------------------------------------------------------

/**
 * Default navigation policy: same-origin only. The harness studies admission
 * defenses on the target origin; an agent that talks the LLM into navigating
 * to attacker.example must not turn a defense experiment into an outbound
 * traffic experiment. A manifest may explicitly allow cross-origin testing.
 */
function isNavigationAllowed(actionTarget: string, scenario: Scenario): boolean {
  let parsed: URL;
  try {
    parsed = new URL(actionTarget, `${scenario.targetUrl}/`);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  // Scenario-level escape hatch (wire through manifest later if ever needed).
  const allowCrossOrigin = (scenario as Scenario & { allowCrossOrigin?: boolean }).allowCrossOrigin === true;
  if (allowCrossOrigin) return true;
  return parsed.origin === new URL(scenario.targetUrl).origin;
}

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
    llmProvenance?: AgentRunResult["llmProvenance"];
  },
  perception: PerceptionArtifact[]
): AgentRunResult {
  return {
    ...result,
    perceptionArtifacts: perception,
  };
}

/**
 * FR-P0-9: every exit path from run() funnels through this wrapper so the
 * last LLM call's requested-vs-served provenance reaches the record even on
 * error/timeout paths (the call that produced the failure is itself
 * provenance).
 */
function withProvenance(
  provenance: AgentRunResult["llmProvenance"],
  result: AgentRunResult
): AgentRunResult {
  return { ...result, llmProvenance: provenance };
}

// ---------------------------------------------------------------------------
// Canary session-material detection (FR-R4-046)
// FR-R6-055: EXACT vs GENERIC reference are distinct outcomes. Only exact
// session material (the issued nonce or the issued route token) sets
// canaryReferenced — a generic "/c/" mention is canaryGenericReferenced and
// never feeds the exact-reference metric.
// ---------------------------------------------------------------------------

interface CanaryReferenceResult {
  canaryReferenced: boolean;
  canaryGenericReferenced: boolean;
  canaryNote: string;
}

async function detectCanaryReferenced(
  raw: string,
  page: Page
): Promise<CanaryReferenceResult> {
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

  // Exact check: session-specific material referenced in output
  if ((canaryNonce && raw.includes(canaryNonce)) || (canaryRoute && raw.includes(canaryRoute))) {
    return { canaryReferenced: true, canaryGenericReferenced: false, canaryNote: "session-material" };
  }

  // FR-R6-055: generic "/c/" shape WITHOUT exact material — a distinct,
  // weaker signal that must not be conflated with an exact reference.
  if (raw.includes("/c/")) {
    return { canaryReferenced: false, canaryGenericReferenced: true, canaryNote: "generic" };
  }

  return {
    canaryReferenced: false,
    canaryGenericReferenced: false,
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
    let canaryGenericReferenced = false;
    let transcript = "";
    let sessionCookie: string | undefined;
    const perception: PerceptionArtifact[] = [];
    // FR-P0-9: last-call LLM provenance (requested vs served), attached to
    // the result so the runner can record it in the run record.
    let llmProvenance: AgentRunResult["llmProvenance"];

    // FR-R4-037/038: Resolve prompt variant
    let systemPrompt: string;
    try {
      systemPrompt = resolvePrompt(scenario.promptVariant);
    } catch {
      return withProvenance(llmProvenance, finish(
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
      ));
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

      // FR-R6-005: every adapter resolves its entry URL through signupUrl() —
      // the lab-run bind params (?lab_run=&bind=) reach the LLM attacker too,
      // so raw-dom trials actually test their assigned treatment.
      await page.goto(signupUrl(scenario), { waitUntil: "networkidle" });

      for (let step = 0; step < scenario.maxSteps; step++) {
        if (Date.now() - start > scenario.timeoutMs) {
          return withProvenance(llmProvenance, finish(
            {
              outcome: "timeout",
              actionCount: steps.length,
              elapsedMs: Date.now() - start,
              transcript,
              sessionCookie,
              canaryTriggered,
              canaryReferenced,
            canaryGenericReferenced,
            },
            perception
          ));
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

        // FR-R4-047: Store perception artifact with SHA-256 hash.
        // FR-P0-13: the hash covers EXACTLY the persisted bytes — an
        // artifact hash must be reproducible from the stored evidence, so
        // truncate FIRST, then hash the bounded content (the old order
        // hashed the full observation and stored a truncated prefix, making
        // the hash unverifiable from the record).
        const perfType = this.extractor === "raw-html" ? "raw-html" : "simplified-dom";
        const artifactContent = observationWithRefs.slice(0, 4000); // bound payload
        const perfHash = sha256(artifactContent);
        perception.push({
          step: step + 1,
          type: perfType,
          content: artifactContent,
          hash: perfHash,
        });

        // FR-R4-037: prepend prompt SHA to transcript for provenance
        const promptSha = sha256(systemPrompt);
        transcript += `\n[PROMPT_SHA256] ${promptSha}\n`;
        // FR-R4-046: record canary detection note (FR-R6-055: exact vs
        // generic tracked separately).
        const canaryNote = await detectCanaryReferenced(transcript, page);
        transcript += `\n[CANARY_REF] session-material:${canaryNote.canaryNote}\n`;
        if (canaryNote.canaryReferenced) {
          canaryReferenced = true;
        }
        if (canaryNote.canaryGenericReferenced) {
          canaryGenericReferenced = true;
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
          const llm = await callLlm(
            scenario.model,
            enrichedSystem,
            userPrompt,
            scenario.modelConfig ?? {},
            llmTimeout
          );
          const raw = llm.content;
          // FR-P0-9: requested-vs-served provenance from the wire.
          llmProvenance = {
            providerOrigin: llm.provenance.providerOrigin,
            modelRequested: llm.provenance.modelRequested,
            modelServed: llm.provenance.modelServed,
            temperature: llm.provenance.temperature,
            maxTokens: llm.provenance.maxTokens,
          };
          transcript += `\n--- Step ${step + 1} ---\n${raw}\n`;

          // FR-R4-046: Canary detection uses session-specific material
          // (FR-R6-055: generic mentions tracked separately from exact).
          const canaryResult = await detectCanaryReferenced(raw, page);
          if (canaryResult.canaryReferenced) {
            canaryReferenced = true;
            transcript += `\n[CANARY_REF] session-material:${canaryResult.canaryNote}\n`;
          }
          if (canaryResult.canaryGenericReferenced) {
            canaryGenericReferenced = true;
            transcript += `\n[CANARY_REF_GENERIC] ${canaryResult.canaryNote}\n`;
          }

          action = validateAction(raw);
        } catch {
          return withProvenance(llmProvenance, finish(
            {
              outcome: "error",
              actionCount: steps.length,
              elapsedMs: Date.now() - start,
              transcript,
              sessionCookie,
              canaryTriggered,
              canaryReferenced,
            canaryGenericReferenced,
              errorCode: "llm_error",
            },
            perception
          ));
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
              // FR-R6-056: http(s) AND same-origin (unless the scenario
              // explicitly allows cross-origin testing).
              if (action.target && isNavigationAllowed(action.target, scenario)) {
                const parsed = new URL(action.target, `${scenario.targetUrl}/`);
                await page.goto(parsed.href);
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
              return withProvenance(llmProvenance, finish(
                {
                  outcome: "submitted",
                  actionCount: steps.length,
                  elapsedMs: Date.now() - start,
                  transcript,
                  sessionCookie,
                  canaryTriggered,
                  canaryReferenced,
            canaryGenericReferenced,
                },
                perception
              ));
            }
            case "stop":
              return withProvenance(llmProvenance, finish(
                {
                  outcome: "stopped",
                  actionCount: steps.length,
                  elapsedMs: Date.now() - start,
                  transcript,
                  sessionCookie,
                  canaryTriggered,
                  canaryReferenced,
            canaryGenericReferenced,
                },
                perception
              ));
            case "handoff":
              return withProvenance(llmProvenance, finish(
                {
                  outcome: "handoff",
                  actionCount: steps.length,
                  elapsedMs: Date.now() - start,
                  transcript,
                  sessionCookie,
                  canaryTriggered,
                  canaryReferenced,
            canaryGenericReferenced,
                },
                perception
              ));
          }
        } catch {
          // Action failed — continue
        }

        await page.waitForTimeout(500);
      }

      return withProvenance(llmProvenance, finish(
        {
          outcome: "timeout",
          actionCount: steps.length,
          elapsedMs: Date.now() - start,
          transcript,
          sessionCookie,
          canaryTriggered,
          canaryReferenced,
            canaryGenericReferenced,
        },
        perception
      ));
    } catch {
      return withProvenance(llmProvenance, finish(
        {
          outcome: "error",
          actionCount: steps.length,
          elapsedMs: Date.now() - start,
          transcript,
          sessionCookie,
          canaryTriggered,
          canaryReferenced,
            canaryGenericReferenced,
          errorCode: "browser_error",
        },
        perception
      ));
    } finally {
      await browser.close();
    }
  }
}

// Legacy: keep for backward compatibility
export const DEFAULT_SYSTEM = PROMPT_VARIANTS.baseline.system;
