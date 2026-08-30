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

import { createHash } from "node:crypto";
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

export interface RawHttpResult {
  outcome: "submitted" | "error";
  submitted: boolean;
  disposition?: string;
  score?: number;
  canaryTriggered: boolean;
  canaryExposed: boolean;
  sessionCookie?: string;
  /** FR-POST-R6-P1: transport bytes of the signup GET (bounded) for exposure artifacts. */
  signupHtml?: string;
  /** HTTP status of the signup GET. */
  signupStatus?: number;
  /** HTTP status of the submit POST (undefined if it never got a response). */
  submitStatus?: number;
}

export async function runRawHttpAgent(config: RawHttpConfig): Promise<RawHttpResult> {
  const { baseUrl, fixture, labRun } = config;
  const canaryTriggered = false;
  let canaryExposed = false;
  let sessionCookie: string | undefined;
  let signupHtml = "";
  let signupStatus: number | undefined;
  let submitStatus: number | undefined;
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
    signupStatus = signupResp.status;

    let html = "";
    if (signupResp.ok) {
      html = await signupResp.text();

      // Check if page contains canary markers
      canaryExposed =
        html.includes("data-fr-canary-id") || html.includes("fr-canary");
    }
    signupHtml = html.slice(0, 20000); // bounded artifact payload

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

    submitStatus = submitResp.status;
    if (!submitResp.ok) {
      return {
        outcome: "error",
        submitted: false,
        canaryTriggered,
        canaryExposed,
        sessionCookie,
        signupHtml,
        signupStatus,
        submitStatus,
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
      signupHtml,
      signupStatus,
      submitStatus,
    };
  } catch {
    return {
      outcome: "error",
      submitted: false,
      canaryTriggered,
      canaryExposed,
      signupHtml,
      signupStatus,
      submitStatus,
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

      // FR-POST-R6-P1: the transport bytes ARE this agent's entire
      // perception. Record them as a perception artifact so the runner's
      // EXPOSED computation (which scans artifacts) works uniformly for
      // this architecture, and so exposure is measured against what the
      // agent actually received — not what the server rendered somewhere.
      const artifacts: AgentRunResult["perceptionArtifacts"] = [];
      if (rawResult.signupHtml) {
        artifacts.push({
          step: 1,
          type: "raw-html",
          content: rawResult.signupHtml,
          hash: createHash("sha256").update(rawResult.signupHtml).digest("hex"),
        });
      }

      // Transcript: wire-level observations only. NOTE: submit status is
      // deliberately included — the server response is what the agent
      // "observed" (blind POST → status code).
      transcript.push(
        `[GET /signup] ${rawResult.signupStatus ?? "no-response"}`,
        `[POST /api/submit] ${rawResult.submitStatus ?? "no-response"}`,
        `[SUBMIT RESPONSE] disposition=${rawResult.disposition ?? "n/a"} score=${rawResult.score ?? "n/a"}`,
      );

      // Map RawHttpResult → AgentRunResult.
      // FR-R6-064: exposure and reference are DIFFERENT concepts. Raw HTTP
      // can observe canary markers in the transport bytes (canaryExposed)
      // without any reasoning process referring to them — there is no LLM
      // output to scan here, so canaryReferenced is false unless this
      // adapter's own decision-making used the material (it does not: it
      // submits blindly). The reference metric is protected from methodological
      // contamination even though exposure is still observable.
      return {
        outcome: rawResult.outcome,
        actionCount: 2, // GET + POST
        elapsedMs,
        transcript: transcript.join("\n"),
        sessionCookie: rawResult.sessionCookie,
        canaryTriggered: false, // raw-http never navigates, never hits /c/
        canaryReferenced: false,
        canaryGenericReferenced: false,
        perceptionArtifacts: artifacts,
      };
    } catch {
      return {
        outcome: "error",
        actionCount: 0,
        elapsedMs: Date.now() - start,
        transcript: transcript.join("\n"),
        canaryTriggered: false,
        canaryReferenced: false,
        canaryGenericReferenced: false,
        errorCode: "browser_error",
      };
    }
  }
}
