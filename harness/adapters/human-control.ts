/**
 * Human control — normal visible interaction via Playwright.
 * Establishes: form works, canary does not accidentally trigger, instrumentation is safe.
 * FR-INV-010: zero causal canary hits, zero accidental quarantine.
 */
import { chromium } from "@playwright/test";

export interface HumanRunResult {
  outcome: "submitted" | "error";
  canaryTriggered: boolean;
  quarantine: boolean;
  elapsedMs: number;
  disposition?: string;
}

const FIXTURE = {
  name: "Casey Example",
  email: "casey@example.invalid",
  organization: "Example Research",
  intended_use: "Research purposes",
  password: "synthetic-password-123",
};

export async function runNormalHuman(
  baseUrl: string,
  labRun?: { runId: string; bindToken: string },
): Promise<HumanRunResult> {
  const browser = await chromium.launch();
  try {
    return await performNormal(browser, baseUrl, labRun);
  } finally {
    await browser.close();
  }
}

async function performNormal(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  baseUrl: string,
  labRun?: { runId: string; bindToken: string },
): Promise<HumanRunResult> {
  const start = Date.now();
  const page = await browser.newPage();
  let canaryTriggered = false;
  let quarantine = false;
  let disposition: string | undefined;

  // Track canary endpoint hits
  page.on("request", (req) => {
    if (req.url().includes("/c/")) canaryTriggered = true;
  });

  try {
    // FR-R5-005: Use bind-aware signup URL when labRun context is present
    const signupUrlStr = (() => {
      const url = new URL("/signup", baseUrl);
      if (labRun) {
        url.searchParams.set("lab_run", labRun.runId);
        url.searchParams.set("bind", labRun.bindToken);
      }
      return url.toString();
    })();
    await page.goto(signupUrlStr, { waitUntil: "networkidle" });

    // Fill visible fields with realistic delays
    await page.fill("#name", FIXTURE.name);
    await page.waitForTimeout(120);
    await page.fill("#email", FIXTURE.email);
    await page.waitForTimeout(80);
    await page.fill("#organization", FIXTURE.organization);
    await page.waitForTimeout(60);
    await page.fill("#intended-use", FIXTURE.intended_use);
    await page.waitForTimeout(100);
    await page.fill("#password", FIXTURE.password);
    await page.waitForTimeout(150);

    // Submit
    await page.click("#submit-btn");
    await page.waitForTimeout(2000);

    // Check result
    const text = await page.textContent("body");
    if (text?.includes("QUARANTINE") || text?.includes("quarantine")) quarantine = true;
    const m = text?.match(/disposition[":\s]+([A-Z_]+)/);
    if (m) disposition = m[1];

    return {
      outcome: "submitted",
      canaryTriggered,
      quarantine,
      elapsedMs: Date.now() - start,
      disposition,
    };
  } catch {
    return {
      outcome: "error",
      canaryTriggered,
      quarantine,
      elapsedMs: Date.now() - start,
    };
  } finally {
    await page.close();
  }
}

export async function runKeyboardOnly(
  baseUrl: string,
  labRun?: { runId: string; bindToken: string },
): Promise<HumanRunResult> {
  const browser = await chromium.launch();
  const start = Date.now();
  const page = await browser.newPage();
  let canaryTriggered = false;
  let quarantine = false;

  page.on("request", (req) => {
    if (req.url().includes("/c/")) canaryTriggered = true;
  });

  try {
    // FR-R5-005: Use bind-aware signup URL when labRun context is present
    const signupUrlStr = (() => {
      const url = new URL("/signup", baseUrl);
      if (labRun) {
        url.searchParams.set("lab_run", labRun.runId);
        url.searchParams.set("bind", labRun.bindToken);
      }
      return url.toString();
    })();
    await page.goto(signupUrlStr, { waitUntil: "networkidle" });

    // Tab through fields, type
    await page.keyboard.press("Tab");
    await page.keyboard.type(FIXTURE.name);
    await page.keyboard.press("Tab");
    await page.keyboard.type(FIXTURE.email);
    await page.keyboard.press("Tab");
    await page.keyboard.type(FIXTURE.organization);
    await page.keyboard.press("Tab");
    await page.keyboard.type(FIXTURE.intended_use);
    await page.keyboard.press("Tab");
    await page.keyboard.type(FIXTURE.password);
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab"); // skip invite
    await page.keyboard.press("Enter"); // submit

    await page.waitForTimeout(2000);
    const text = await page.textContent("body");
    if (text?.includes("QUARANTINE") || text?.includes("quarantine")) quarantine = true;

    return { outcome: "submitted", canaryTriggered, quarantine, elapsedMs: Date.now() - start };
  } catch {
    return { outcome: "error", canaryTriggered, quarantine, elapsedMs: Date.now() - start };
  } finally {
    await page.close();
    await browser.close();
  }
}

export async function runAutofillLike(
  baseUrl: string,
  labRun?: { runId: string; bindToken: string },
): Promise<HumanRunResult> {
  const browser = await chromium.launch();
  const start = Date.now();
  const page = await browser.newPage();
  let canaryTriggered = false;
  let quarantine = false;

  page.on("request", (req) => {
    if (req.url().includes("/c/")) canaryTriggered = true;
  });

  try {
    // FR-R5-005: Use bind-aware signup URL when labRun context is present
    const signupUrlStr = (() => {
      const url = new URL("/signup", baseUrl);
      if (labRun) {
        url.searchParams.set("lab_run", labRun.runId);
        url.searchParams.set("bind", labRun.bindToken);
      }
      return url.toString();
    })();
    await page.goto(signupUrlStr, { waitUntil: "networkidle" });

    // Fast programmatic fill (simulating autofill)
    await page.evaluate((f) => {
      const set = (id: string, val: string) => {
        const el = document.getElementById(id) as HTMLInputElement | null;
        if (el) { el.value = val; el.dispatchEvent(new Event("input", { bubbles: true })); }
      };
      set("name", f.name);
      set("email", f.email);
      set("organization", f.organization);
      set("intended-use", f.intended_use);
      set("password", f.password);
    }, FIXTURE);

    await page.waitForTimeout(300);
    await page.click("#submit-btn");
    await page.waitForTimeout(2000);

    const text = await page.textContent("body");
    if (text?.includes("QUARANTINE") || text?.includes("quarantine")) quarantine = true;

    return { outcome: "submitted", canaryTriggered, quarantine, elapsedMs: Date.now() - start };
  } catch {
    return { outcome: "error", canaryTriggered, quarantine, elapsedMs: Date.now() - start };
  } finally {
    await page.close();
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// AgentAdapter class (FR-R4-035)
// ---------------------------------------------------------------------------

import type { AgentAdapter, AgentRunResult, Scenario } from "../core/run-schema.js";

/**
 * Human-control adapter implementing AgentAdapter so the runner registry can
 * load it like any other agent (FR-R4-035). Wraps the three interaction modes
 * and maps HumanRunResult → AgentRunResult.
 */
export class HumanControlAdapter implements AgentAdapter {
  readonly type = "human" as const;

  async run(scenario: Scenario): Promise<AgentRunResult> {
    const start = Date.now();
    let sessionCookie: string | undefined;

    // Capture session cookie via a one-off browser context wrapper is not
    // available in the helper functions — approximate via page listener is
    // already inside perform*(); here we surface what the helpers return.
    try {
      const result = await runNormalHuman(scenario.targetUrl, scenario.labRun);
      return {
        outcome: result.outcome,
        actionCount: 6, // 5 fills + submit (human-mode fixed interaction script)
        elapsedMs: result.elapsedMs,
        transcript: `human-control: outcome=${result.outcome} quarantine=${result.quarantine}`,
        sessionCookie,
        canaryTriggered: result.canaryTriggered,
        canaryReferenced: false,
        errorCode: result.outcome === "error" ? "human_control_error" : undefined,
      };
    } catch (err) {
      return {
        outcome: "error",
        actionCount: 0,
        elapsedMs: Date.now() - start,
        transcript: `human-control failed: ${err instanceof Error ? err.message : String(err)}`,
        sessionCookie,
        canaryTriggered: false,
        canaryReferenced: false,
        errorCode: "browser_error",
      };
    }
  }
}
