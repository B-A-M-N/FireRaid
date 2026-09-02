/**
 * Node.js origin runtime — a minimal fetch-Request/Response-native adapter.
 *
 * No express or extra dependency — uses only `node:http` plus global fetch
 * primitives (Node 18+).  Type-checked against tsconfig.product.json.
 *
 * This is NOT the product's middleware — it wraps `createFireRaidMiddleware` +
 * `admit()` so a host can stand up a real origin server that serves the
 * application page, evaluates submissions, and forwards allowed registrations
 * to an upstream.
 *
 * AUDIT (P0 response opacity): the applicant-facing HTTP layer NEVER
 * serializes the internal MiddlewareResult. Every validly-submitted
 * application receives the SAME neutral receipt whether FireRaid internally
 * classified it LOW / ELEVATED / HIGH / CAUSAL — the decision delta is
 * itself the oracle an autonomous agent iterates on. The rich annotation
 * reaches the host through `onAssessment`, never through the wire.
 *
 * AUDIT (P0 client routing): the runtime serves the real browser client
 * (clientScriptSource) and injects it on the application page
 * (clientScriptSrc), so origin tests exercise the actual browser-facing
 * interaction system, not just server-side injection.
 */
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  MiddlewareDeps,
  MiddlewareResult,
} from "../host-adapter/middleware.js";
import { admit, createFireRaidMiddleware } from "../host-adapter/middleware.js";
import type { MiddlewareRouteConfig } from "../host-adapter/interface.js";

// ─── Types ──────────────────────────────────────────────────────────────────

/** The host-internal assessment FireRaid hands the host (never serialized). */
export interface OriginAssessment {
  sessionId: string;
  disposition: string;
  decisionDenied: boolean;
  upstreamCreated?: boolean;
  score?: number;
  submittedEmail?: string;
  risk?: MiddlewareResult["risk"];
}

export interface OriginServerOptions {
  /** Middleware dependencies — the wired seam between adapters + config. */
  middlewareDeps: MiddlewareDeps;
  /** Async loader for the upstream application HTML. */
  htmlLoader: () => Promise<string>;
  /** Port to listen on (0 = ephemeral). */
  port: number;
  /** Explicit route configuration for the middleware admit() dispatcher. */
  routes: MiddlewareRouteConfig;
  /**
   * Source of the browser client script served to applicants. The runtime
   * serves it at `clientScriptPath` (default "/fireraid-client.js") and
   * injects `<script src>` on the application page, so the shipped client
   * — not a test double — drives form submission + telemetry.
   */
  clientScriptSource?: () => string;
  /** Path the browser client is served under. Default "/fireraid-client.js". */
  clientScriptPath?: string;
  /**
   * Host-internal hook: the full FireRaid assessment for every evaluated
   * submission (admit AND decision-deny). This is how the host persists the
   * risk annotation / joins to its own review workflow. NEVER serialized to
   * the applicant.
   */
  onAssessment?: (assessment: OriginAssessment) => void;
}

// ─── Request / Response bridge ──────────────────────────────────────────────

/**
 * Convert a Node `IncomingMessage` + `ServerResponse` pair to a standard
 * `Request` and a handler that writes back to the `ServerResponse`.
 */
function nodeToRequest(
  req: IncomingMessage
): Promise<Request> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
      const fullUrl = `http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`;
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") {
          headers[k] = v;
        }
      }
      const init: RequestInit = {
        method: req.method ?? "GET",
        headers,
      };
      if (body && body.length > 0) {
        init.body = body;
      }
      resolve(new Request(fullUrl, init));
    });
    req.on("error", reject);
  });
}

// ─── Applicant-facing projection (the ONLY response shapes on the wire) ────

/** The neutral receipt every valid submission gets — no decision material. */
const RECEIVED_RECEIPT = JSON.stringify({
  status: "received",
  message: "Application received.",
});
/** Same receipt, different transport state — indistinguishable content. */
const RECEIVED_PENDING = JSON.stringify({
  status: "received",
  message: "Application received.",
});

/**
 * Project a MiddlewareResult into the applicant-facing HTTP response.
 *
 * AUDIT (P0 origin opacity): admit AND decision-deny return the SAME
 * receipt with the SAME status code. Precondition failures (bad CSRF, no
 * session, malformed input) stay 4xx — those are transport-layer facts a
 * legitimate client needs to function, and they carry no evidence weight.
 */
function writeResult(
  res: ServerResponse,
  result: MiddlewareResult,
  onAssessment?: (a: OriginAssessment) => void
): void {
  // Host-internal hook FIRST — the annotation path, never the wire.
  if (onAssessment && (result.kind === "admit" || (result.kind === "deny" && result.decisionDenied === true))) {
    onAssessment({
      sessionId: result.sessionId ?? "",
      disposition: result.disposition ?? "UNKNOWN",
      decisionDenied: result.decisionDenied === true,
      upstreamCreated: result.upstreamCreated,
      score: result.score,
      submittedEmail: result.submittedEmail,
      risk: result.risk,
    });
  }

  switch (result.kind) {
    case "get":
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Set-Cookie": result.setCookie ?? "",
      });
      res.end(result.html ?? "");
      break;

    case "admit":
      // AUDIT (P0): neutral receipt — no disposition/score/sessionId/risk.
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(RECEIVED_RECEIPT);
      break;

    case "deny":
      if (result.decisionDenied === true) {
        // A DECISION denial is indistinguishable from an admit on the wire:
        // same receipt, same status. The upstream never saw it; the host's
        // review workflow sees the annotation through onAssessment.
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(RECEIVED_PENDING);
      } else {
        // Precondition failures (NO_SESSION / CSRF_FAILED / INVALID_FORM /
        // BAD_JSON / VERIFICATION_FAILED / METHOD_NOT_ALLOWED / etc.) —
        // transport facts a legitimate client needs.
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: result.disposition ?? "FORBIDDEN" }));
      }
      break;

    case "ingest":
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          received: result.received,
          acceptedThrough: result.acceptedThrough,
        })
      );
      break;

    case "canary-verified":
      res.writeHead(204);
      res.end();
      break;

    case "not-handled":
      res.writeHead(404);
      res.end("Not Found");
      break;

    case "error":
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal Server Error" }));
      break;

    default:
      // Exhaustive check — should never happen but TypeScript needs it.
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal Server Error" }));
  }
}

// ─── Server factory ─────────────────────────────────────────────────────────

/**
 * Create an origin HTTP server that wraps the FireRaid middleware.
 *
 * On each request:
 *   1. Convert node req → standard Request
 *   2. Call createFireRaidMiddleware(deps) for startup validation
 *   3. Call admit(req, validatedDeps, htmlLoader)
 *   4. Project MiddlewareResult → the neutral applicant-facing response
 */
export function createOriginServer(
  options: OriginServerOptions
): http.Server {
  const deps = createFireRaidMiddleware({
    ...options.middlewareDeps,
    routes: options.routes,
  });

  const htmlLoader = options.htmlLoader;
  const clientScriptPath = options.clientScriptPath ?? "/fireraid-client.js";
  const clientSource = options.clientScriptSource;

  // The middleware injects the client loader via deps.clientScriptSrc; the
  // runtime additionally serves the script at clientScriptPath.
  const renderDeps: MiddlewareDeps = {
    ...deps,
    clientScriptSrc: clientSource ? clientScriptPath : deps.clientScriptSrc,
  };

  const server = http.createServer(
    async (nodeReq: IncomingMessage, nodeRes: ServerResponse) => {
      try {
        const url = nodeReq.url ?? "/";
        // AUDIT (P0 client): serve the REAL browser client — the actual
        // interaction system the page loads.
        if (clientSource && url.split("?")[0] === clientScriptPath) {
          nodeRes.writeHead(200, {
            "Content-Type": "text/javascript; charset=utf-8",
            "Cache-Control": "no-store",
          });
          nodeRes.end(clientSource());
          return;
        }
        const req = await nodeToRequest(nodeReq);
        const result = await admit(req, renderDeps, htmlLoader);
        writeResult(nodeRes, result, options.onAssessment);
      } catch {
        // Fail-closed: serve a 500 if the bridge itself errors.
        nodeRes.writeHead(500, { "Content-Type": "application/json" });
        nodeRes.end(JSON.stringify({ error: "Internal Server Error" }));
      }
    }
  );

  return server;
}

/**
 * Gracefully shut down the origin server.
 * Returns a promise that resolves when all connections are drained.
 */
export function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}
