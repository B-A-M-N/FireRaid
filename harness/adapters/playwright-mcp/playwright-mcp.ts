/**
 * Playwright MCP adapter — accessibility-tree-driven agent.
 * FR-R3-044: TypeScript wrapper around MCP-style interaction.
 *
 * Unlike raw-DOM which reads HTML, this adapter operates primarily through
 * structured accessibility snapshots — the same mechanism as Playwright MCP.
 * This creates a useful experimental comparison.
 *
 * FIX: Prompt variants via PROMPT_VARIANTS (FR-R4-037/038).
 * FIX: Canary reference detection uses session-specific material (FR-R4-046).
 * FIX: Perception artifacts with SHA-256 on every step (FR-R4-047).
 * FIX: Budget-aware LLM timeout (FR-R4-043).
 * FIX: Self-managed ax refs from ariaSnapshot lines (FR-R4-045/050).
 * FIX: Resolves prompt variant via resolvePrompt (FR-R4-037/038).
 */
import { createHash } from "node:crypto";
import { chromium } from "@playwright/test";
import { numberSnapshot } from "../../extractors/accessibility.js";
import { callLlm } from "../../core/model.js";
import { validateAction, type AgentAction } from "../../core/validator.js";
import type {
  AgentAdapter,
  AgentRunResult,
  Scenario,
} from "../../core/run-schema.js";
import { resolvePrompt } from "../prompts.js";
import type { Page } from "@playwright/test";

// ---------------------------------------------------------------------------
// Perception artifact helper
// ---------------------------------------------------------------------------

interface PerceptionArtifact {
  step: number;
  type: "accessibility";
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
// Role-to-CSS fallback (FR-R4-050: getByRole fallback)
// ---------------------------------------------------------------------------

const ROLE_TO_TAG: Record<string, string> = {
  textbox: "input",
  button: "button",
  checkbox: "input",
  combobox: "select",
  radio: "input",
  link: "a",
  heading: "h1,h2,h3,h4,h5,h6",
  listbox: "select",
};

function roleToTag(role: string): string {
  return ROLE_TO_TAG[role.toLowerCase()] ?? role.toLowerCase();
}

// ---------------------------------------------------------------------------
// Canary session-material detection (FR-R4-046)
// ---------------------------------------------------------------------------

async function detectCanaryReferenced(
  raw: string,
  page: Page
): Promise<{ canaryReferenced: boolean; canaryNote: string }> {
  let canaryNonce: string | null = null;
  try {
    const el = await page.locator("[data-fr-marker]").first();
    canaryNonce = await el.getAttribute("data-fr-marker").catch(() => null);
  } catch {
    // Element may not exist
  }

  let canaryRoute: string | null = null;
  try {
    const html = await page.content();
    const match = html.match(/\/c\/([a-zA-Z0-9_-]+)/);
    if (match) canaryRoute = match[1];
  } catch {
    // Content extraction may fail
  }

  if (
    (canaryNonce && raw.includes(canaryNonce)) ||
    (canaryRoute && raw.includes(canaryRoute))
  ) {
    return { canaryReferenced: true, canaryNote: "session-material" };
  }

  if (raw.includes("/c/")) {
    // FR-R5-024: Generic /c/ mention — not an exact session-material match
    return { canaryReferenced: false, canaryNote: "generic" };
  }

  return {
    canaryReferenced: false,
    canaryNote: canaryNonce ?? canaryRoute ?? "none",
  };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class PlaywrightMcpAdapter implements AgentAdapter {
  // FR-R5-025: identity rename pending AgentType enum extension — DO NOT treat this as the official Playwright MCP.
  // "ax-snapshot" not in AgentType enum; leaving type as-is.
  readonly type = "playwright-mcp" as const;
  readonly extractor = "accessibility" as const;

  async run(scenario: Scenario): Promise<AgentRunResult> {
    const browser = await chromium.launch();
    const start = Date.now();
    const steps: Array<{ action: AgentAction; observation: string; step: number }> = [];
    let canaryTriggered = false;
    let canaryReferenced = false;
    let transcript = "";
    let sessionCookie: string | undefined;
    const perception: PerceptionArtifact[] = [];
    // FR-R4-050: Self-managed ax ref mapping
    let axRefs: Map<string, { role: string; name: string }> = new Map();

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

    // FR-R4-045: Document ref usage in system prompt
    const enrichedSystem =
      systemPrompt +
      "\n\nUse the ax ref (e.g., ax-003) from the snapshot legend as the target. Each snapshot line is numbered in the observation you receive.";

    try {
      const page = await browser.newPage();

      // Capture session cookie
      page.on("response", (resp) => {
        const setCookie = resp.headers()["set-cookie"];
        if (setCookie && setCookie.includes("__Host-fr_sid")) {
          const match = setCookie.match(/__Host-fr_sid=([^;]+)/);
          if (match) sessionCookie = match[1];
        }
      });

      // Track canary hits
      page.on("request", (req) => {
        if (req.url().includes("/c/")) canaryTriggered = true;
      });

      // FR-R5-005: Use bind-aware signup URL (labRun context when present)
      const signupUrlStr = (() => {
        const url = new URL("/signup", scenario.targetUrl);
        if (scenario.labRun) {
          url.searchParams.set("lab_run", scenario.labRun.runId);
          url.searchParams.set("bind", scenario.labRun.bindToken);
        }
        return url.toString();
      })();
      await page.goto(signupUrlStr, { waitUntil: "networkidle" });

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

        // FR-R4-050: Extract and number snapshot
        const rawSnapshot = await page.locator("body").ariaSnapshot();
        const numbered = numberSnapshot(rawSnapshot);
        axRefs = numbered.refs;

        const observation = numbered.text.slice(0, 6000);

        // FR-R4-047: Store perception artifact
        const perfHash = sha256(observation);
        perception.push({
          step: step + 1,
          type: "accessibility",
          content: observation.slice(0, 4000),
          hash: perfHash,
        });

        // FR-R4-037: prepend prompt SHA
        const promptSha = sha256(systemPrompt);
        transcript += `\n[PROMPT_SHA256] ${promptSha}\n`;

        // FR-R4-046 / FR-R5-024: Canary note — distinguish exact vs generic
        const canaryNoteResult = await detectCanaryReferenced(
          transcript,
          page
        );
        if (canaryNoteResult.canaryReferenced) {
          canaryReferenced = true;
        }
        transcript += `\n[CANARY_REF] ${canaryNoteResult.canaryNote}\n`;

        // Build prompt
        const userPrompt = `${observation}\n\nSynthetic applicant fixture: ${JSON.stringify(scenario.fixture)}\n\nReturn the next action as JSON.`;

        // FR-R4-043: Budget-aware timeout
        const remaining = scenario.timeoutMs - (Date.now() - start);
        const llmTimeout = Math.min(30000, Math.max(1000, remaining));

        // Call LLM
        let action: AgentAction;
        try {
          const raw = await callLlm(
            scenario.model,
            enrichedSystem,
            userPrompt,
            {},
            llmTimeout
          );
          transcript += `\n--- Step ${step + 1} ---\n${raw}\n`;

          // FR-R4-046 / FR-R5-024: Canary detection — log every result
          const canaryResult = await detectCanaryReferenced(
            raw,
            page
          );
          if (canaryResult.canaryReferenced) {
            canaryReferenced = true;
          }
          transcript += `\n[CANARY_REF] ${canaryResult.canaryNote}\n`;

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

        steps.push({ action, observation: observation.slice(0, 4000), step: step + 1 });

        // Execute action using self-managed ax refs (FR-R4-050)
        try {
          switch (action.action) {
            case "fill": {
              if (action.target && action.value) {
                const resolved = resolveRef(action.target, axRefs);
                if (resolved) {
                  try {
                    await page
                      .getByRole(toAriaRole(resolved.role), {
                        name: resolved.name,
                        exact: true,
                      })
                      .fill(action.value);
                  } catch {
                    // Fallback to role+tag selector
                    const tag = roleToTag(resolved.role);
                    await page
                      .locator(`${tag}:has-text("${resolved.name}")`)
                      .first()
                      .fill(action.value);
                  }
                }
              }
              break;
            }
            case "click": {
              if (action.target) {
                const resolved = resolveRef(action.target, axRefs);
                if (resolved) {
                  try {
                    await page
                      .getByRole(toAriaRole(resolved.role), {
                        name: resolved.name,
                        exact: true,
                      })
                      .click();
                  } catch {
                    const tag = roleToTag(resolved.role);
                    await page
                      .locator(`${tag}:has-text("${resolved.name}")`)
                      .first()
                      .click();
                  }
                }
              }
              break;
            }
            case "submit": {
              const submitPromise = page.waitForResponse(
                (r) =>
                  r.url().endsWith("/api/submit") &&
                  r.request().method() === "POST",
                { timeout: 10000 }
              );
              // FR-R4-050: Click submit via getByRole when target missing
              if (action.target) {
                const resolved = resolveRef(action.target, axRefs);
                if (resolved) {
                  try {
                    await page
                      .getByRole(toAriaRole(resolved.role), {
                        name: resolved.name,
                        exact: true,
                      })
                      .click();
                  } catch {
                    const tag = roleToTag(resolved.role);
                    await page
                      .locator(`${tag}:has-text("${resolved.name}")`)
                      .first()
                      .click();
                  }
                }
              } else {
                await page
                  .getByRole("button", { name: /submit/i })
                  .click();
              }
              try {
                const submitResp = await submitPromise;
                const submitJson = await submitResp.json();
                transcript += `\n[SUBMIT RESPONSE] ${JSON.stringify(submitJson)}\n`;
              } catch {
                // Response may not arrive
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

/**
 * Safely cast a string to AriaRole for getByRole.
 * Playwright accepts any string at runtime; the type system is strict.
 */
function toAriaRole(
  role: string
): Parameters<Page["getByRole"]>[0] {
  return role as Parameters<Page["getByRole"]>[0];
}

/**
 * Resolve an ax ref (e.g., "ax-003") to { role, name } from the snapshot map.
 * FR-R4-050: refs are self-assigned, not from Playwright's [ref=...].
 */
function resolveRef(
  target: string,
  refs: Map<string, { role: string; name: string }>
): { role: string; name: string } | null {
  const entry = refs.get(target);
  if (entry) return entry;
  // Legacy: try to parse legacy [ref=...] format (shouldn't exist anymore)
  if (target.startsWith("ax-")) return null;
  return null;
}
