/**
 * Node.js origin runtime — a minimal fetch-Request/Response-native adapter.
 *
 * No express or extra dependency — uses only `node:http` plus global fetch
 * primitives (Node 22.5+, the package `engines` floor).  Type-checked
 * against tsconfig.product.json.
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
import { SECURITY_HEADERS } from "../security/headers.js";
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
  /** Core evidence/policy disposition before deployment remapping. */
  coreDisposition: string;
  /** Disposition actually enforced at the host boundary. */
  runtimeDisposition: string;
  /** @deprecated Use coreDisposition/runtimeDisposition. */
  disposition: string;
  decisionDenied: boolean;
  upstreamCreated?: boolean;
  score?: number;
  submittedEmail?: string;
  risk?: MiddlewareResult["risk"];
  /**
   * FR-RR-14: TRUE when this assessment is a REPLAY of the durably-stored
   * snapshot (a retried request after this session's forward already
   * finalized) rather than a fresh evaluation. The core/runtime disposition
   * pair, score, and risk are then the ORIGINAL ones — a host persisting
   * assessments should upsert keyed on sessionId, so the replayed hook is an
   * idempotent re-write of the same review row, never a duplicate.
   */
  replayed?: boolean;
  /**
   * P0-8: the discriminated enforcement detail when the host adapter
   * returned one. `queued-for-retry` carries the host's own retryId here so
   * the review pipeline can join this assessment to its pending-queue
   * entry; `business-rejected` carries the upstream's status/body.
   */
  enforcementDetail?: MiddlewareResult["enforcementDetail"];
}

export interface OriginServerOptions {
  /** Middleware dependencies — the wired seam between adapters + config. */
  middlewareDeps: MiddlewareDeps;
  /** Async loader for the upstream application HTML. */
  htmlLoader: () => Promise<string>;
  /**
   * P1-1: REMOVED — this factory CONSTRUCTS the server; the host owns the
   * binding lifecycle (server.listen). A `port` option here was dead
   * configuration: accepted, validated nowhere, never used.
   */
  port?: never;
  /** Explicit route configuration for the middleware admit() dispatcher. */
  routes: MiddlewareRouteConfig;
  /**
   * P1-9 / P0-6: explicit public ORIGIN (scheme + host + optional port),
   * e.g. "https://signup.example.org". Parsed and validated once at server
   * creation (http/https scheme only; no path/query/hash/userinfo — a
   * malformed value throws). When set, request URLs are built from it and
   * the Host header is ignored, so a spoofed Host cannot influence origin
   * handling behind a reverse proxy.
   */
  publicOrigin?: string;
  /**
   * P1-9: timeout for receiving the complete request headers (ms).
   * Default 60000 (matches the Node 22+ default).
   */
  headersTimeoutMs?: number;
  /**
   * P1-9: timeout for receiving the entire request body (ms).
   * Default 30000.
   */
  requestTimeoutMs?: number;
  /**
   * P1-9 / P0-7: maximum header size in bytes, enforced at server
   * construction (http.createServer's own option — the parser rejects
   * oversized header blocks). Default 16384 (16 KiB).
   */
  maxHeaderSize?: number;
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
   *
   * P0-5: this is a DURABILITY seam — the runtime AWAITS the returned
   * Promise BEFORE writing the success receipt, so an application is only
   * acked once its annotation is durable. A rejection is host-infrastructure
   * failure: the applicant gets a generic 500, never a success receipt.
   *
   * FR-RR-16: REQUIRED on the production origin — the Node host's durable
   * decision channel. A production server without it evaluates submissions
   * and discards every assessment (and with an advisory posture never
   * blocks either): the middleware is technically running while delivering
   * no admission-defense outcome. Omitting it is a construction-time error.
   */
  onAssessment: (assessment: OriginAssessment) => void | Promise<void>;
}

// ─── Request / Response bridge ──────────────────────────────────────────────

/**
 * P1-13: typed bridge failures. The node→Request bridge can reject for
 * reasons the CLIENT caused (oversized body, malformed Host) — those are
 * 4xx transport facts, not server errors. The old bridge threw bare
 * Errors that collapsed into the generic 500, telling a legitimate client
 * its recoverable mistake was "our fault, retry forever".
 */
class RequestBridgeError extends Error {
  constructor(
    readonly status: 400 | 413,
    readonly wireCode: string
  ) {
    super(wireCode);
    this.name = "RequestBridgeError";
  }
}

/**
 * P0-6: validate and parse the publicOrigin option ONCE at server creation.
 *
 * The contract is scheme + host + optional port — a full ORIGIN, never a
 * host string spliced into a template (the old `http://${trustedHost}`
 * build produced `http://https://example.org/...` for a documented
 * `https://` option, losing HTTPS origin semantics entirely).
 */
function parsePublicOrigin(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`publicOrigin: not a valid URL: ${raw}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`publicOrigin: scheme must be http: or https: (${u.protocol})`);
  }
  if (u.pathname !== "/" || u.search || u.hash || u.username || u.password) {
    throw new Error(
      `publicOrigin: must be scheme + host + optional port only ` +
      `(got path="${u.pathname}" search="${u.search}" hash="${u.hash}"` +
      `${u.username ? " userinfo" : ""})`
    );
  }
  return u;
}

/**
 * Convert a Node `IncomingMessage` + `ServerResponse` pair to a standard
 * `Request` and a handler that writes back to the `ServerResponse`.
 */
function nodeToRequest(
  req: IncomingMessage,
  maxBytes: number = 64 * 1024,
  publicOrigin?: URL,
  /** Response the bridge marks `Connection: close` on when rejecting a body. */
  resFor413?: ServerResponse
): Promise<Request> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    const contentLength = Number(req.headers["content-length"] || 0);
    if (contentLength > maxBytes) {
      // Undrained body on a kept-alive connection would poison the NEXT
      // request on that socket (response-smuggling class). Connection:
      // close tells the client this socket is done; the socket is destroyed
      // after the 413 response flushes (the handler writes it), not before.
      resFor413?.setHeader("Connection", "close");
      reject(new RequestBridgeError(413, "PAYLOAD_TOO_LARGE"));
      return;
    }
    req.on("data", (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > maxBytes) {
        reject(new RequestBridgeError(413, "PAYLOAD_TOO_LARGE"));
        // Mid-stream overrun: the parser state is unusable — pause further
        // consumption and let the handler write the 413; Node closes this
        // connection per the Connection: close header set by the writer.
        resFor413?.setHeader("Connection", "close");
        req.pause();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
      // P0-6: when a public origin is configured, the request URL is built
      // from IT — the Host header is attacker-controlled input behind any
      // proxy and never contributes to the URL. Otherwise validate the Host
      // header against a safe pattern (no user-controlled URL).
      let fullUrl: string;
      if (publicOrigin) {
        const resolved = new URL(req.url ?? "/", publicOrigin);
        // WHATWG URL resolution gives an EXPLICIT form priority over the
        // base: a protocol-relative target ("GET //evil.com/x HTTP/1.1") or
        // proxy-style absolute-form target ("GET http://evil.com/x HTTP/1.1")
        // resolves to the attacker's origin, not the pinned one. The pinned
        // origin is the whole point of publicOrigin (Host-header control
        // behind a reverse proxy) — a request that would escape it is a
        // client error, not something to silently re-home.
        if (resolved.origin !== publicOrigin.origin) {
          reject(new RequestBridgeError(400, "INVALID_TARGET"));
          return;
        }
        fullUrl = resolved.toString();
      } else {
        const rawHost = req.headers.host ?? "localhost";
        // Reject malformed Host headers (header injection guard)
        if (!/^[a-zA-Z0-9._:-]+$/.test(rawHost)) {
          reject(new RequestBridgeError(400, "INVALID_HOST_HEADER"));
          return;
        }
        fullUrl = `http://${rawHost}${req.url ?? "/"}`;
      }
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
 *
 * P0-5: onAssessment is a DURABILITY seam. The response is not written
 * until the host's persistence completes: acking an application before the
 * review annotation is durable means a crash after the receipt silently
 * loses it. A rejected hook is host-infrastructure failure — the generic
 * 5xx goes out and the success receipt is NEVER sent (the applicant's
 * client treats it as retryable; whether a retry duplicates the upstream
 * registration is the host's idempotency problem, not something this
 * layer may paper over with a fake success).
 */
async function writeResult(
  res: ServerResponse,
  result: MiddlewareResult,
  onAssessment: (a: OriginAssessment) => void | Promise<void> | undefined
): Promise<void> {
  // Host-internal hook FIRST — the annotation path, never the wire.
  if (onAssessment && (result.kind === "admit" || (result.kind === "deny" && result.decisionDenied === true))) {
    try {
      await onAssessment({
        sessionId: result.sessionId ?? "",
        coreDisposition: result.coreDisposition ?? result.disposition ?? "UNKNOWN",
        runtimeDisposition: result.runtimeDisposition ?? result.disposition ?? "UNKNOWN",
        disposition: result.disposition ?? "UNKNOWN",
        decisionDenied: result.decisionDenied === true,
        upstreamCreated: result.upstreamCreated,
        score: result.score,
        submittedEmail: result.submittedEmail,
        risk: result.risk,
        replayed: result.replayed,
        enforcementDetail: result.enforcementDetail,
      });
    } catch {
      // Durability failure: do not pretend the application was received.
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json", ...SECURITY_HEADERS });
        res.end(JSON.stringify({ error: "Internal Server Error" }));
      }
      return;
    }
  }

  switch (result.kind) {
    case "get":
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Set-Cookie": result.setCookie ?? "",
        // P1-11: every Node response branch carries the same security
        // headers the Worker plane applies — the origin is the same attack
        // surface regardless of which runtime served the request.
        ...SECURITY_HEADERS,
      });
      res.end(result.html ?? "");
      break;

    case "admit":
      // AUDIT (P0): neutral receipt — no disposition/score/sessionId/risk.
      // P0-8: reached ONLY when the application is durably somewhere
      // (upstream created, or captured in the host's retry queue).
      res.writeHead(200, { "Content-Type": "application/json", ...SECURITY_HEADERS });
      res.end(RECEIVED_RECEIPT);
      break;

    case "forward-failed":
      // P0-8: the upstream rejected the forward at the transport level and
      // nothing was durably captured — a success receipt here would be a
      // lie. 502 (bad gateway to the upstream) tells the client this is
      // transient and retryable; the generic body keeps applicant opacity.
      res.writeHead(502, { "Content-Type": "application/json", ...SECURITY_HEADERS });
      res.end(JSON.stringify({ error: "Upstream unavailable, try again later" }));
      break;

    case "deny":
      if (result.decisionDenied === true) {
        // A DECISION denial is indistinguishable from an admit on the wire:
        // same receipt, same status. The upstream never saw it; the host's
        // review workflow sees the annotation through onAssessment.
        res.writeHead(200, { "Content-Type": "application/json", ...SECURITY_HEADERS });
        res.end(RECEIVED_PENDING);
      } else if (result.disposition === "METHOD_NOT_ALLOWED") {
        // P1-12: a method problem is a 405 with Allow, not a bare 403 —
        // the one 4xx where the standards-mandated header carries real
        // routing information for legitimate clients.
        res.writeHead(405, {
          "Content-Type": "application/json",
          Allow: "GET, POST",
          ...SECURITY_HEADERS,
        });
        res.end(JSON.stringify({ error: "METHOD_NOT_ALLOWED" }));
      } else {
        // Precondition failures (NO_SESSION / CSRF_FAILED / INVALID_FORM /
        // BAD_JSON / VERIFICATION_FAILED / etc.) — transport facts a
        // legitimate client needs. FR-RR-09: when the middleware pinned an
        // explicit status (413 oversize, 400 malformed/absent body), it is
        // honored instead of the blanket 403 — a body-level protocol problem
        // is a client error, not an admission denial.
        res.writeHead(result.httpStatus ?? 403, {
          "Content-Type": "application/json",
          ...SECURITY_HEADERS,
        });
        res.end(JSON.stringify({ error: result.disposition ?? "FORBIDDEN" }));
      }
      break;

    case "ingest":
      res.writeHead(200, { "Content-Type": "application/json", ...SECURITY_HEADERS });
      res.end(
        JSON.stringify({
          received: result.received,
          acceptedThrough: result.acceptedThrough,
        })
      );
      break;

    case "canary-verified":
      res.writeHead(204, { ...SECURITY_HEADERS });
      res.end();
      break;

    case "not-handled":
      res.writeHead(404, { ...SECURITY_HEADERS });
      res.end("Not Found");
      break;

    case "error":
      res.writeHead(500, { "Content-Type": "application/json", ...SECURITY_HEADERS });
      res.end(JSON.stringify({ error: "Internal Server Error" }));
      break;

    default:
      // Exhaustive check — should never happen but TypeScript needs it.
      res.writeHead(500, { "Content-Type": "application/json", ...SECURITY_HEADERS });
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
  return buildOriginServer(options, (deps) =>
    createFireRaidMiddleware({ ...deps, routes: options.routes })
  );
}

/** Shared server construction; `validate` selects the posture's factory. */
function buildOriginServer(
  options: OriginServerOptions,
  validate: (deps: MiddlewareDeps) => MiddlewareDeps,
  /** "production" requires the onAssessment seam; "evaluation" warns. */
  posture: "production" | "evaluation" = "production"
): http.Server {
  // FR-RR-16: the durable decision channel is not optional in production.
  // The type makes it required; the runtime check is the JS-host backstop
  // (a hand-written options object can still omit it).
  if (typeof options.onAssessment !== "function") {
    const message =
      "createOriginServer: onAssessment is REQUIRED — the Node host's durable " +
      "decision channel (an application is only acked once its annotation is " +
      "durable). A server without it discards every assessment; wire the hook " +
      "or use createEvaluationOriginServer for throwaway experiment wiring.";
    if (posture === "production") {
      throw new Error(message);
    }
    console.warn(`[evaluation] ${message}`);
  }
  const deps = validate(options.middlewareDeps);

  const htmlLoader = options.htmlLoader;
  const clientScriptPath = options.clientScriptPath ?? "/fireraid-client.js";
  const clientSource = options.clientScriptSource;

  // The middleware injects the client loader via deps.clientScriptSrc; the
  // runtime additionally serves the script at clientScriptPath.
  const renderDeps: MiddlewareDeps = {
    ...deps,
    clientScriptSrc: clientSource ? clientScriptPath : deps.clientScriptSrc,
  };

  // P1-9: server timeout configuration (defaults match hardened defaults)
  const headersTimeout = options.headersTimeoutMs ?? 60_000;
  const requestTimeout = options.requestTimeoutMs ?? 30_000;
  const maxHeaderSize = options.maxHeaderSize ?? 16_384;

  // P0-6: parse the public origin ONCE, at construction — fail fast on a
  // malformed option instead of per-request. (Undefined = legacy behavior:
  // validate-and-use the Host header.)
  const publicOrigin = options.publicOrigin ? parsePublicOrigin(options.publicOrigin) : undefined;

  const server = http.createServer(
    // P0-7: maxHeaderSize is an http.createServer OPTION — it configures the
    // HTTP parser's header buffer at construction. The previous property
    // assignment onto the finished server object configured nothing (the
    // parser had already been built), so the documented protection was never
    // enforced.
    { maxHeaderSize },
    async (nodeReq: IncomingMessage, nodeRes: ServerResponse) => {
      try {
        const url = nodeReq.url ?? "/";
        // AUDIT (P0 client): serve the REAL browser client — the actual
        // interaction system the page loads.
        if (clientSource && url.split("?")[0] === clientScriptPath) {
          nodeRes.writeHead(200, {
            "Content-Type": "text/javascript; charset=utf-8",
            "Cache-Control": "no-store",
            // P1-9: security headers on client script responses
            ...SECURITY_HEADERS,
          });
          nodeRes.end(clientSource());
          return;
        }
        const req = await nodeToRequest(nodeReq, 64 * 1024, publicOrigin, nodeRes);
        const result = await admit(req, renderDeps, htmlLoader);
        await writeResult(nodeRes, result, options.onAssessment);
      } catch (err) {
        // P1-13: client-caused bridge failures are 4xx transport facts.
        if (err instanceof RequestBridgeError && !nodeRes.headersSent) {
          nodeRes.writeHead(err.status, { "Content-Type": "application/json", ...SECURITY_HEADERS });
          nodeRes.end(JSON.stringify({ error: err.wireCode }));
          // 413 with an undrained/paused body: the response is written and
          // Connection: close is set — end the socket so the poisoned
          // stream cannot be reused for a following request.
          if (err.status === 413) nodeReq.destroy();
          return;
        }
        // Fail-closed: serve a 500 if the bridge itself errors.
        if (!nodeRes.headersSent) {
          nodeRes.writeHead(500, { "Content-Type": "application/json", ...SECURITY_HEADERS });
          nodeRes.end(JSON.stringify({ error: "Internal Server Error" }));
        } else {
          nodeRes.destroy();
        }
      }
    }
  );

  // P1-9: hardened timeout settings
  server.headersTimeout = headersTimeout;
  server.requestTimeout = requestTimeout;
  server.maxHeadersCount = 50;

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

/**
 * Shared server construction. Exported for the EVALUATION plane only
 * (src/eval/evaluation-origin.ts) — the product boundary forbids this
 * module importing src/eval, so the sanctioned volatile-wiring server is
 * built THERE over this seam. Production hosts use createOriginServer and
 * never see this function.
 */
export function __buildOriginServerWithValidator(
  options: OriginServerOptions,
  validate: (deps: MiddlewareDeps) => MiddlewareDeps,
  posture: "production" | "evaluation" = "production"
): http.Server {
  return buildOriginServer(options, validate, posture);
}
