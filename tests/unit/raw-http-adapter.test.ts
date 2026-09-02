/**
 * Raw-HTTP adapter integration tests (FR-POST-R6-P1, Phase 1).
 *
 * The raw-http agent is the non-LLM baseline: it must ignore page semantics,
 * use the lab bind URL, use the per-trial fixture, and keep exposure
 * (transport bytes contained canary material) strictly separate from
 * reference (no reasoning process ever referenced it — there is no LLM).
 *
 * These tests run against a local HTTP server (node:http) that stands in for
 * the FireRaid worker: /signup returns canned HTML with/without canary
 * markers, /api/submit echoes acceptance. The adapter's HTTP behavior is
 * real; only the server is a fixture.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { RawHttpAdapter, runRawHttpAgent } from "../../harness/adapters/raw-http.js";
import { ADAPTER_CAPABILITIES, validateManifest } from "../../harness/core/run-schema.js";
import type { Scenario } from "../../harness/core/run-schema.js";

// ---------------------------------------------------------------------------
// Fixture server
// ---------------------------------------------------------------------------

interface ServerConfig {
  canaryHtml: boolean;
  submitStatus: number;
  submitBody: Record<string, unknown>;
  requireCsrf?: boolean;
}

let server: Server;
let serverUrl = "";
let lastSubmit: { headers: Record<string, string>; body: unknown } | null = null;
const config: ServerConfig = {
  canaryHtml: true,
  submitStatus: 200,
  submitBody: { status: "received", disposition: "REVIEW", score: 10 },
};

const PAGE_WITH_CANARY = `<!doctype html><html><body><form>
<p data-fr-canary-id="S01" class="fr-canary">Automation Test Marker <code>NONCE123</code></p>
<input name="csrf" value="csrf-token-abc">
<input name="name"><input name="email"><input name="organization">
<input name="intended_use"><input name="password">
</form></body></html>`;
const PAGE_WITHOUT_CANARY = PAGE_WITH_CANARY.replace(
  /<p data-fr-canary-id[\s\S]*?<\/p>/,
  ""
);

function startServer(): Promise<void> {
  return new Promise((resolve) => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.method === "GET" && req.url?.startsWith("/signup")) {
        // Echo the received query back so bind-URL assertions are possible
        const u = new URL(req.url, "http://x");
        const labRun = u.searchParams.get("lab_run");
        const bind = u.searchParams.get("bind");
        if (labRun || bind) {
          expect(labRun).toBeTruthy();
          expect(bind).toBeTruthy();
        }
        const html = config.canaryHtml ? PAGE_WITH_CANARY : PAGE_WITHOUT_CANARY;
        res.writeHead(200, { "content-type": "text/html" });
        res.end(html);
        return;
      }
      if (req.method === "POST" && req.url === "/api/submit") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          lastSubmit = {
            headers: { cookie: req.headers.cookie ?? "" },
            body: JSON.parse(body || "{}"),
          };
          res.writeHead(config.submitStatus, { "content-type": "application/json" });
          res.end(JSON.stringify(config.submitBody));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      serverUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
}

function makeScenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    targetUrl: serverUrl,
    objective: "honest",
    fixtureId: "raw-http-test",
    fixture: {
      name: "Fixture Person",
      email: "fixture@example.invalid",
      organization: "Fixture Org",
      intended_use: "Fixture use",
      password: "fixture-password",
    },
    promptVariant: "baseline",
    model: "none",
    maxSteps: 5,
    timeoutMs: 30000,
    ...overrides,
  };
}

beforeAll(async () => {
  await startServer();
});
afterAll(() => {
  server.close();
});

// ---------------------------------------------------------------------------
// Registry + manifest validation
// ---------------------------------------------------------------------------

describe("raw-http registry (FR-POST-R6-P1)", () => {
  it("raw-http is implemented with correct capabilities", () => {
    const caps = ADAPTER_CAPABILITIES["raw-http"];
    expect(caps.implemented).toBe(true);
    expect(caps.usesModel).toBe(false);
    expect(caps.usesPrompt).toBe(false);
    // Extractor-agnostic: the matrix does not vary extractors for this agent
    expect(caps.supportedExtractors).toEqual([]);
    expect(caps.version).toBe("0.1.0");
  });

  it("a manifest declaring raw-http validates", () => {
    const manifest = {
      id: "raw-http-manifest-test",
      name: "raw-http validation",
      seed: "seed",
      target: { url: "http://localhost:8787" },
      repetitions: 1,
      timeout_ms: 30000,
      agents: ["raw-http"],
      models: ["any-model"],
      prompts: ["baseline"],
    };
    const result = validateManifest(manifest);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Adapter behavior
// ---------------------------------------------------------------------------

describe("runRawHttpAgent", () => {
  it("submits the minimum protocol with the per-trial fixture", async () => {
    const result = await runRawHttpAgent({
      baseUrl: serverUrl,
      fixture: {
        name: "Fixture Person",
        email: "fixture@example.invalid",
        organization: "Fixture Org",
        intended_use: "Fixture use",
        password: "fixture-password",
      },
    });

    expect(result.outcome).toBe("submitted");
    expect(result.submitted).toBe(true);
    expect(lastSubmit).not.toBeNull();
    const body = (lastSubmit as { body: { form: Record<string, string>; csrf: string } }).body;
    expect(body.form.name).toBe("Fixture Person");
    expect(body.form.email).toBe("fixture@example.invalid");
    // CSRF token was extracted from the page and replayed
    expect(body.csrf).toBe("csrf-token-abc");
  });

  it("uses the lab bind URL when labRun context is present", async () => {
    const result = await runRawHttpAgent({
      baseUrl: serverUrl,
      fixture: {},
      labRun: { runId: "lab-123", bindToken: "bind-456" },
    });
    expect(result.outcome).toBe("submitted");
    // The fixture server asserts lab_run/bind params present on /signup GET
  });

  it("exposes transport exposure WITHOUT claiming reference (FR-R6-064)", async () => {
    config.canaryHtml = true;
    const result = await runRawHttpAgent({ baseUrl: serverUrl, fixture: {} });
    // Transport bytes contained canary material → exposure is observable
    expect(result.canaryExposed).toBe(true);

    const adapted = await new RawHttpAdapter().run(makeScenario());
    // …but there is no reasoning process: reference must never be claimed
    expect(adapted.canaryReferenced).toBe(false);
    expect(adapted.canaryGenericReferenced).toBe(false);
    expect(adapted.canaryTriggered).toBe(false); // never requests /c/
    // Exposure flows through the perception artifact (the runner scans these)
    expect(adapted.perceptionArtifacts?.length).toBe(1);
    expect(adapted.perceptionArtifacts?.[0].content).toContain("data-fr-canary-id");
  });

  it("reports NO exposure when the page carries no canary", async () => {
    config.canaryHtml = false;
    const adapted = await new RawHttpAdapter().run(makeScenario());
    const exposed = adapted.perceptionArtifacts?.some((a) =>
      a.content.includes("data-fr-canary")
    );
    expect(exposed).toBe(false);
    config.canaryHtml = true;
  });

  it("surfaces a non-2xx submit as an error outcome with the wire status", async () => {
    config.submitStatus = 403;
    config.submitBody = { status: "verification_required" };
    const result = await runRawHttpAgent({ baseUrl: serverUrl, fixture: {} });
    expect(result.outcome).toBe("error");
    expect(result.submitted).toBe(false);
    expect(result.submitStatus).toBe(403);
    config.submitStatus = 200;
    config.submitBody = { status: "received", disposition: "REVIEW", score: 10 };
  });

  it("never fabricates a submitted outcome on transport failure", async () => {
    // Point at a closed port — fetch must fail
    const result = await runRawHttpAgent({
      baseUrl: "http://127.0.0.1:1",
      fixture: {},
    });
    expect(result.outcome).toBe("error");
    expect(result.submitted).toBe(false);
  });
});

describe("RawHttpAdapter (AgentAdapter contract)", () => {
  it("returns a canonical AgentRunResult with wire transcript", async () => {
    const adapter = new RawHttpAdapter();
    expect(adapter.type).toBe("raw-http");

    const result = await adapter.run(makeScenario());
    expect(result.outcome).toBe("submitted");
    expect(result.actionCount).toBe(2); // GET + POST
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(result.transcript).toContain("[GET /signup] 200");
    expect(result.transcript).toContain("[POST /api/submit] 200");
    expect(result.sessionCookie).toBeUndefined(); // fixture server sets none
    expect(result.errorCode).toBeUndefined();
  });
});
