/**
 * Human control — normal visible interaction via Playwright.
 * Establishes: form works, canary does not accidentally trigger, instrumentation is safe.
 * FR-INV-010: zero causal canary hits, zero accidental quarantine.
 * FR-R6-060: fixture is a function argument, never module state — trial
 * isolation comes from the runner's per-trial fixture, not a shared constant.
 * FR-R6-061: submission truth comes from the actual /api/submit response
 * (attempted? server HTTP status? disposition?) — never from scraping page
 * text, which the defense plane renders and can decoy.
 */
import { chromium } from "@playwright/test";

/** The five signup fields a human-control trial fills (FR-R6-060). */
export interface HumanFixture {
  name: string;
  email: string;
  organization: string;
  intended_use: string;
  password: string;
}

export interface HumanRunResult {
  outcome: "submitted" | "error";
  canaryTriggered: boolean;
  quarantine: boolean;
  elapsedMs: number;
  disposition?: string;
  /** FR-R6-061: what actually happened on the wire for /api/submit. */
  submit: {
    attempted: boolean;
    httpStatus?: number;
    serverDisposition?: string;
    serverScore?: number;
  };
  sessionCookie?: string;
}

function defaultFixture(): HumanFixture {
  return {
    name: "Casey Example",
    email: "casey@example.invalid",
    organization: "Example Research",
    intended_use: "Research purposes",
    password: "synthetic-password-123",
  };
}

/**
 * FR-R6-061: resolve the /api/submit response next to a submit trigger.
 * Returns null when no matching POST arrived within the window (submit
 * blocked client-side, navigation interrupted, etc.) — that absence is
 * itself recorded (attempted: true, no status), not inferred from page text.
 */
async function captureSubmitResponse(
  trigger: Promise<unknown>,
  page: import("@playwright/test").Page,
  timeoutMs = 10000
): Promise<{ httpStatus?: number; serverDisposition?: string; serverScore?: number }> {
  const respPromise = page.waitForResponse(
    (r) => r.url().endsWith("/api/submit") && r.request().method() === "POST",
    { timeout: timeoutMs }
  );
  await trigger;
  try {
    const resp = await respPromise;
    let serverDisposition: string | undefined;
    let serverScore: number | undefined;
    try {
      const body = (await resp.json()) as { disposition?: string; score?: number };
      serverDisposition = body.disposition;
      serverScore = body.score;
    } catch {
      // Non-JSON body — status is still the truth.
    }
    return { httpStatus: resp.status(), serverDisposition, serverScore };
  } catch {
    return {};
  }
}

async function bindSignupUrl(
  baseUrl: string,
  labRun?: { runId: string; bindToken: string }
): Promise<string> {
  // FR-R5-005: bind-aware signup URL when labRun context is present
  const url = new URL("/signup", baseUrl);
  if (labRun) {
    url.searchParams.set("lab_run", labRun.runId);
    url.searchParams.set("bind", labRun.bindToken);
  }
  return url.toString();
}

/** FR-R6-061: session cookie capture identical to the LLM adapters. */
function watchSessionCookie(page: import("@playwright/test").Page, sink: { value?: string }): void {
  page.on("response", (resp) => {
    const setCookie = resp.headers()["set-cookie"];
    if (setCookie && setCookie.includes("__Host-fr_sid")) {
      const match = setCookie.match(/__Host-fr_sid=([^;]+)/);
      if (match) sink.value = match[1];
    }
  });
}

function pageSaysQuarantine(text: string | null): boolean {
  return !!text && (text.includes("QUARANTINE") || text.includes("quarantine"));
}

export async function runNormalHuman(
  baseUrl: string,
  fixture: HumanFixture = defaultFixture(),
  labRun?: { runId: string; bindToken: string }
): Promise<HumanRunResult> {
  const browser = await chromium.launch();
  try {
    return await performNormal(browser, baseUrl, fixture, labRun);
  } finally {
    await browser.close();
  }
}

async function performNormal(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  baseUrl: string,
  fixture: HumanFixture,
  labRun?: { runId: string; bindToken: string }
): Promise<HumanRunResult> {
  const start = Date.now();
  const page = await browser.newPage();
  let canaryTriggered = false;
  const cookieSink: { value?: string } = {};
  watchSessionCookie(page, cookieSink);

  page.on("request", (req) => {
    if (req.url().includes("/c/")) canaryTriggered = true;
  });

  try {
    await page.goto(await bindSignupUrl(baseUrl, labRun), { waitUntil: "networkidle" });

    // Fill visible fields with realistic delays
    await page.fill("#name", fixture.name);
    await page.waitForTimeout(120);
    await page.fill("#email", fixture.email);
    await page.waitForTimeout(80);
    await page.fill("#organization", fixture.organization);
    await page.waitForTimeout(60);
    await page.fill("#intended-use", fixture.intended_use);
    await page.waitForTimeout(100);
    await page.fill("#password", fixture.password);
    await page.waitForTimeout(150);

    // FR-R6-061: observe the actual POST, not the rendered outcome
    const submit = await captureSubmitResponse(page.click("#submit-btn"), page);
    await page.waitForTimeout(2000);

    const text = await page.textContent("body");
    return {
      outcome: "submitted",
      canaryTriggered,
      quarantine: pageSaysQuarantine(text),
      elapsedMs: Date.now() - start,
      disposition: submit.serverDisposition,
      submit: { attempted: true, ...submit },
      sessionCookie: cookieSink.value,
    };
  } catch {
    return {
      outcome: "error",
      canaryTriggered,
      quarantine: false,
      elapsedMs: Date.now() - start,
      submit: { attempted: false },
      sessionCookie: cookieSink.value,
    };
  } finally {
    await page.close();
  }
}

export async function runKeyboardOnly(
  baseUrl: string,
  fixture: HumanFixture = defaultFixture(),
  labRun?: { runId: string; bindToken: string }
): Promise<HumanRunResult> {
  const browser = await chromium.launch();
  const start = Date.now();
  const page = await browser.newPage();
  let canaryTriggered = false;
  const cookieSink: { value?: string } = {};
  watchSessionCookie(page, cookieSink);

  page.on("request", (req) => {
    if (req.url().includes("/c/")) canaryTriggered = true;
  });

  try {
    await page.goto(await bindSignupUrl(baseUrl, labRun), { waitUntil: "networkidle" });

    // Tab through fields, type
    await page.keyboard.press("Tab");
    await page.keyboard.type(fixture.name);
    await page.keyboard.press("Tab");
    await page.keyboard.type(fixture.email);
    await page.keyboard.press("Tab");
    await page.keyboard.type(fixture.organization);
    await page.keyboard.press("Tab");
    await page.keyboard.type(fixture.intended_use);
    await page.keyboard.press("Tab");
    await page.keyboard.type(fixture.password);
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab"); // skip invite
    // FR-R6-061: observe the actual POST triggered by the Enter keypress
    const submit = await captureSubmitResponse(page.keyboard.press("Enter"), page);

    await page.waitForTimeout(2000);
    const text = await page.textContent("body");
    return {
      outcome: "submitted",
      canaryTriggered,
      quarantine: pageSaysQuarantine(text),
      elapsedMs: Date.now() - start,
      disposition: submit.serverDisposition,
      submit: { attempted: true, ...submit },
      sessionCookie: cookieSink.value,
    };
  } catch {
    return {
      outcome: "error",
      canaryTriggered,
      quarantine: false,
      elapsedMs: Date.now() - start,
      submit: { attempted: false },
      sessionCookie: cookieSink.value,
    };
  } finally {
    await page.close();
    await browser.close();
  }
}

export async function runAutofillLike(
  baseUrl: string,
  fixture: HumanFixture = defaultFixture(),
  labRun?: { runId: string; bindToken: string }
): Promise<HumanRunResult> {
  const browser = await chromium.launch();
  const start = Date.now();
  const page = await browser.newPage();
  let canaryTriggered = false;
  const cookieSink: { value?: string } = {};
  watchSessionCookie(page, cookieSink);

  page.on("request", (req) => {
    if (req.url().includes("/c/")) canaryTriggered = true;
  });

  try {
    await page.goto(await bindSignupUrl(baseUrl, labRun), { waitUntil: "networkidle" });

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
    }, fixture);

    await page.waitForTimeout(300);
    // FR-R6-061: observe the actual POST, not the rendered outcome
    const submit = await captureSubmitResponse(page.click("#submit-btn"), page);
    await page.waitForTimeout(2000);

    const text = await page.textContent("body");
    return {
      outcome: "submitted",
      canaryTriggered,
      quarantine: pageSaysQuarantine(text),
      elapsedMs: Date.now() - start,
      disposition: submit.serverDisposition,
      submit: { attempted: true, ...submit },
      sessionCookie: cookieSink.value,
    };
  } catch {
    return {
      outcome: "error",
      canaryTriggered,
      quarantine: false,
      elapsedMs: Date.now() - start,
      submit: { attempted: false },
      sessionCookie: cookieSink.value,
    };
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
    // FR-P0-8: the control variant selects the interaction mode — normal,
    // keyboard-only, or autofill-like. These are the FR-R7-006 legitimate-
    // browser simulation variants; dispatching on them here is what makes
    // them real treatments instead of three labels over identical runs.
    const fixture = {
      name: scenario.fixture.name ?? "Casey Example",
      email: scenario.fixture.email ?? "casey@example.invalid",
      organization: scenario.fixture.organization ?? "Example Research",
      intended_use: scenario.fixture.intended_use ?? "Research purposes",
      password: scenario.fixture.password ?? "synthetic-password-123",
    };
    const variant = scenario.controlVariant ?? "normal";
    const runner =
      variant === "keyboard"
        ? runKeyboardOnly
        : variant === "autofill"
          ? runAutofillLike
          : runNormalHuman;
    try {
      const result = await runner(scenario.targetUrl, fixture, scenario.labRun);

      // FR-R6-061: transcript carries the wire truth for the record.
      const transcript = [
        `human-control: outcome=${result.outcome} quarantine=${result.quarantine}`,
        `[SUBMIT_RESPONSE] attempted=${result.submit.attempted}` +
          (result.submit.httpStatus !== undefined ? ` http=${result.submit.httpStatus}` : " (no POST observed)") +
          (result.submit.serverDisposition !== undefined ? ` disposition=${result.submit.serverDisposition}` : "") +
          (result.submit.serverScore !== undefined ? ` score=${result.submit.serverScore}` : ""),
      ].join("\n");

      return {
        outcome: result.outcome,
        actionCount: 6, // 5 fills + submit (human-mode fixed interaction script)
        elapsedMs: result.elapsedMs,
        transcript,
        sessionCookie: result.sessionCookie,
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
        canaryTriggered: false,
        canaryReferenced: false,
        errorCode: "browser_error",
      };
    }
  }
}
