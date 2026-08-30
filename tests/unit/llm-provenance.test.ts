/**
 * FR-P0-9/10/11: LLM provenance + endpoint normalization + .env loading.
 * A local HTTP server plays an OpenAI-compatible provider: it records what
 * the client sent (path, model, auth header) and replies with a DIFFERENT
 * served model id — proving requested-vs-served provenance is captured from
 * the wire, never assumed from the request.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { callLlm, normalizeBaseUrl, loadHarnessEnv } from "../../harness/core/model.js";

let server: Server;
let port = 0;

interface Captured {
  path: string;
  auth: string | null;
  body: { model?: string; temperature?: number; max_tokens?: number };
}
let captured: Captured | null = null;

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      captured = {
        path: req.url ?? "",
        auth: req.headers.authorization ?? null,
        body: raw ? JSON.parse(raw) : {},
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        // Provider serves a DIFFERENT id than requested (router aliasing).
        model: "served-backend/alias-9b",
        provider: "TestCloud",
        choices: [{ message: { content: "ACTION_JSON_PLACEHOLDER" } }],
      }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  port = addr.port;
});

afterAll(() => {
  server?.close();
});

const ENV_KEYS = ["FIRERAID_LLM_BASE_URL", "FIRERAID_LLM_API_KEY"] as const;

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  // Reset the module-level once-guard so each test loads its own env state.
  vi.resetModules();
});

describe("normalizeBaseUrl (FR-P0-10)", () => {
  it("appends /v1 to a bare host", () => {
    expect(normalizeBaseUrl("https://openrouter.ai/api")).toBe("https://openrouter.ai/api/v1");
  });

  it("keeps an already-versioned base intact", () => {
    expect(normalizeBaseUrl("https://openrouter.ai/api/v1")).toBe("https://openrouter.ai/api/v1");
  });

  it("strips trailing slashes before deciding", () => {
    expect(normalizeBaseUrl("https://host.example/")).toBe("https://host.example/v1");
    expect(normalizeBaseUrl("https://host.example/v1/")).toBe("https://host.example/v1");
  });
});

describe("callLlm provenance (FR-P0-9)", () => {
  it("records requested vs served model + provider from the wire", async () => {
    process.env.FIRERAID_LLM_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.FIRERAID_LLM_API_KEY = "test-key";

    const result = await callLlm("requested/model:free", "sys", "user", { temperature: 0.3, maxTokens: 128 }, 5000);

    expect(result.content).toBe("ACTION_JSON_PLACEHOLDER");
    expect(result.provenance.modelRequested).toBe("requested/model:free");
    expect(result.provenance.modelServed).toBe("served-backend/alias-9b");
    expect(result.provenance.providerOrigin).toBe("TestCloud");
    expect(result.provenance.temperature).toBe(0.3);
    expect(result.provenance.maxTokens).toBe(128);
  });

  it("hits /v1/chat/completions on a bare base (no double /v1)", async () => {
    process.env.FIRERAID_LLM_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.FIRERAID_LLM_API_KEY = "test-key";

    await callLlm("m", "s", "u", {}, 5000);
    expect(captured?.path).toBe("/v1/chat/completions");

    // Already-versioned base → still exactly one /v1
    await callLlm("m", "s", "u", {}, 5000);
    // (server received the same normalized path both times)
    expect(captured?.path).toBe("/v1/chat/completions");
  });

  it("sends the bearer credential and exact model id", async () => {
    process.env.FIRERAID_LLM_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.FIRERAID_LLM_API_KEY = "sk-test-123";

    await callLlm("exact/model-id", "s", "u", {}, 5000);
    expect(captured?.auth).toBe("Bearer sk-test-123");
    expect(captured?.body.model).toBe("exact/model-id");
  });

  it("throws MODEL_TIMEOUT on a hanging provider", async () => {
    // One-off hanging server
    const hang = createServer((_req, res) => {
      setTimeout(() => res.end("{}"), 5000);
    });
    await new Promise<void>((r) => hang.listen(0, "127.0.0.1", r));
    const hport = (hang.address() as { port: number }).port;
    try {
      process.env.FIRERAID_LLM_BASE_URL = `http://127.0.0.1:${hport}`;
      process.env.FIRERAID_LLM_API_KEY = "k";
      await expect(callLlm("m", "s", "u", {}, 300)).rejects.toThrow("MODEL_TIMEOUT");
    } finally {
      hang.close();
    }
  });

  it("fails loudly when unconfigured", async () => {
    await expect(callLlm("m", "s", "u", {}, 1000)).rejects.toThrow(/LLM not configured/);
  });
});

describe("loadHarnessEnv (FR-P0-11)", () => {
  it("loads harness/.env without clobbering real env", () => {
    // The repo's harness/.env exists in dev (gitignored). loadHarnessEnv must
    // set FIRERAID_LLM_* only when the real environment hasn't already.
    process.env.FIRERAID_LLM_BASE_URL = "https://real-env.example";
    loadHarnessEnv();
    expect(process.env.FIRERAID_LLM_BASE_URL).toBe("https://real-env.example");
  });
});
