/**
 * Raw-HTTP automation baseline (FR-R3-046).
 * This attacker ignores semantic page content and attempts the minimum valid
 * registration protocol using only HTTP requests. It establishes an important
 * baseline: what does FireRaid do when automation never gives an LLM the DOM?
 *
 * FIX: Converted to AgentAdapter class (FR-R4-035). Wraps existing runRawHttpAgent.
 * FIX: Canaries: raw-http never navigates or fetches /c/, so canaryTriggered is always false.
 * canaryReferenced is set from the canaryExposed flag (page contains canary markers).
 */

import type { AgentAdapter, AgentRunResult, Scenario } from "../core/run-schema.js";

export interface RawHttpConfig {
  baseUrl: string;
  fixture: Record<string, string>;
  // FR-R5-005/028: labRun context for bind-aware signup
  labRun?: { runId: string; bindToken: string };
}

export interface RawHttpResult {
  outcome: "submitted" | "error";
  submitted: boolean;
  disposition?: string;
  score?: number;
  canaryTriggered: boolean;
  canaryExposed: boolean;
  sessionCookie?: string;
}

export async function runRawHttpAgent(config: RawHttpConfig): Promise<RawHttpResult> {
  const { baseUrl, fixture, labRun } = config;
  const canaryTriggered = false;
  let canaryExposed = false;
  let sessionCookie: string | undefined;
  let csrfToken = "";

  try {
    // FR-R5-005/028: Build bind-aware signup URL (labRun context when present)
    const signupUrlStr = (() => {
      const url = new URL("/signup", baseUrl);
      if (labRun) {
        url.searchParams.set("lab_run", labRun.runId);
        url.searchParams.set("bind", labRun.bindToken);
      }
      return url.toString();
    })();
    // Step 1: GET /signup to create session and get CSRF token
    const signupResp = await fetch(signupUrlStr);

    let html = "";
    if (signupResp.ok) {
      html = await signupResp.text();

      // Check if page contains canary markers
      canaryExposed =
        html.includes("data-fr-canary-id") || html.includes("fr-canary");
    }

    // Extract session cookie
    const setCookie = signupResp.headers.get("set-cookie") || "";
    const sessionMatch = setCookie.match(/__Host-fr_sid=([^;]+)/);
    sessionCookie = sessionMatch ? sessionMatch[1] : undefined;

    // Extract CSRF token from HTML
    const csrfMatch = html.match(/name="csrf" value="([^"]+)"/);
    csrfToken = csrfMatch ? csrfMatch[1] : "";

    // Step 2: POST /api/submit with minimum valid form
    // This agent does NOT look at the DOM — it just submits the form blindly
    const formData: Record<string, string> = {
      name: fixture.name || "Casey Example",
      email: fixture.email || "casey@example.invalid",
      organization: fixture.organization || "Example Research",
      intended_use: fixture.intended_use || "Research purposes",
      password: fixture.password || "synthetic-password-123",
    };

    const submitResp = await fetch(`${baseUrl}/api/submit`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(sessionCookie
          ? { cookie: `__Host-fr_sid=${sessionCookie}` }
          : {}),
      },
      body: JSON.stringify({
        csrf: csrfToken,
        turnstileToken: "XXXX.DUMMY.TOKEN.XXXX", // Will fail if Turnstile is enforced
        form: formData,
      }),
    });

    if (!submitResp.ok) {
      return {
        outcome: "error",
        submitted: false,
        canaryTriggered,
        canaryExposed,
        sessionCookie,
      };
    }

    const result = (await submitResp.json()) as {
      status: string;
      disposition?: string;
      score?: number;
    };

    return {
      outcome: "submitted",
      submitted: true,
      disposition: result.disposition,
      score: result.score,
      canaryTriggered,
      canaryExposed,
      sessionCookie,
    };
  } catch {
    return {
      outcome: "error",
      submitted: false,
      canaryTriggered,
      canaryExposed,
    };
  }
}

// ---------------------------------------------------------------------------
// AgentAdapter class (FR-R4-035)
// ---------------------------------------------------------------------------

/**
 * Raw-HTTP adapter implementing AgentAdapter.
 * FR-R4-035: class-based adapter so harness wiring is trivial.
 *
 * The underlying ADAPTER_CAPABILITIES marks raw-http as implemented:false.
 * This is intentional — the TS runner isn't wiring this adapter yet.
 * The class is provided here so wiring later is just a registry update.
 */
export class RawHttpAdapter implements AgentAdapter {
  readonly type = "raw-http" as const;

  async run(scenario: Scenario): Promise<AgentRunResult> {
    const start = Date.now();
    const transcript: string[] = [];

    try {
      // Run the original logic
      const rawResult = await runRawHttpAgent({
        baseUrl: scenario.targetUrl,
        fixture: scenario.fixture,
        labRun: scenario.labRun,
      });

      const elapsedMs = Date.now() - start;

      // Map RawHttpResult → AgentRunResult
      return {
        outcome: rawResult.outcome,
        actionCount: 2, // GET + POST
        elapsedMs,
        transcript: transcript.join("\n"),
        sessionCookie: rawResult.sessionCookie,
        canaryTriggered: false, // raw-http never navigates, never hits /c/
        canaryReferenced: rawResult.canaryExposed,
      };
    } catch {
      return {
        outcome: "error",
        actionCount: 0,
        elapsedMs: Date.now() - start,
        transcript: transcript.join("\n"),
        canaryTriggered: false,
        canaryReferenced: false,
        errorCode: "browser_error",
      };
    }
  }
}
