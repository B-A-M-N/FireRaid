#!/usr/bin/env node
/**
 * FireRaid origin server — runnable reference host (LOCAL DEV).
 *
 * A minimal Node.js server that wires the middleware behind a node:http
 * handler. No Cloudflare Worker required.
 *
 * Posture (closure 6 — honesty about durability): this example's evidence
 * stores are the in-memory reference adapters labeled TRUTHFULLY as
 * `durability: "volatile"`, so it runs through createEvaluationOriginServer
 * — the sanctioned non-durable wiring path. A PRODUCTION deployment uses
 * createOriginServer (strict createFireRaidMiddleware), which REQUIRES
 * stores asserting `durability === "durable"` exactly, wired over real
 * durable backends (D1/R2/Postgres/…). Relabeling an in-memory store
 * "durable" to satisfy the factory is the failure mode the exact-match
 * check exists to catch — do not do it.
 *
 * What stays production-shaped even here:
 *   - no labMode / recipe overrides are set (the derivation is the
 *     production random composition);
 *   - verification: a HOST-OWNED verifier (the disabled-test no-op is
 *     refused in every production-shaped wiring);
 *   - canaryStore + submissionStore stay REQUIRED (route evidence and the
 *     one-submission claim).
 *
 * The runtime serves the REAL browser client (public/signup.js) and injects
 * its <script src> on the application page, so what runs in a browser
 * against this server is the shipped client — form submission, telemetry
 * outbox, neutral receipt rendering — not a test double.
 *
 * The applicant-facing response is the SAME neutral receipt for every
 * accepted-or-decision-denied submission; the full FireRaid assessment
 * (score, tier, evidence) reaches the host through onAssessment only.
 *
 * Usage:
 *   npx tsx examples/origin-server.mjs
 *
 * Or after adding to package.json:
 *   npm run dev:origin
 */

// --- Dev secret (padded to >= 32 bytes for middleware validation) ---
// PRODUCTION: load from a real secret store; never a default.
const DEV_SECRET = process.env.FIRERAID_DEV_SECRET ?? "fireraid-dev-secret-key-for-testing-only-padded";

// --- CSRF signing secret (P0: INDEPENDENT of the profile key ring) ---
// Rotating profile keys must never change CSRF behavior, and a CSRF
// compromise must never expose profile derivation material.
const CSRF_SECRET = process.env.FIRERAID_CSRF_SECRET ?? "fireraid-csrf-secret-key-for-testing-only-padded!";

import { readFileSync } from "node:fs";
import http from "node:http";

// --- In-memory reference adapters ---
import {
  ReferenceSessionAdapter,
  HostOwnedVerificationAdapter,
  ReferenceTelemetryAdapter,
  ReferenceEnforcementAdapter,
  ReferenceCanaryStore,
  ReferenceSubmissionStore,
} from "../src/host-adapter/index.js";

// Import compiled TS via tsx at runtime
import { referenceInject } from "../src/host-adapter/reference-render.js";
import { createEvaluationOriginServer, closeServer } from "../src/eval/evaluation-origin.js";

// --- Application HTML (minimal signup form) ---
const SIGNUP_HTML = `<!DOCTYPE html>
<html lang="en">
<head><title>Sign Up</title></head>
<body>
<form id="signup-form" method="post" action="/signup">
  <label for="name">Name</label>
  <input id="name" name="name" type="text" required>
  <label for="email">Email</label>
  <input id="email" name="email" type="email" required>
  <button type="submit">Create Account</button>
</form>
</body>
</html>`;

async function htmlLoader() {
  return SIGNUP_HTML;
}

// --- Route configuration (the ONE canonical table) ---
const ROUTES = {
  applicationPage: "/signup",
  applicationSubmit: "/signup",
  telemetry: "/api/events",
  canaryPrefix: "/c/",
  client: {
    formSelector: "#signup-form",
    submit: "/signup",
    telemetry: "/api/events",
  },
};

// --- Synthetic FI-like application backend (rereview item 9) ---
// A REAL, working upstream for the demo: an ordinary in-process application
// service with its own record store. The FireRaid behavior is NOT fake —
// only the business backend is synthetic. Admitted applications create an
// application record HERE (the "protected host action"); denied ones never
// reach this code. A production deployment points upstreamRegisterUrl at
// the FI system's own registration endpoint instead.
const applications = [];
const upstream = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/applications") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const { form } = JSON.parse(body);
        if (!form?.email) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "email required" }));
          return;
        }
        if (applications.some((a) => a.email === form.email)) {
          res.writeHead(409, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "already applied" }));
          return;
        }
        applications.push({
          ...form,
          createdAt: new Date().toISOString(),
          // The FireRaid annotation joins by email (see onAssessment log).
          status: "received",
        });
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, created: true }));
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "bad json" }));
      }
    });
    return;
  }
  res.writeHead(404);
  res.end("not found");
});
await new Promise((resolve) => upstream.listen(5051, "127.0.0.1", resolve));

// --- Wire up middleware dependencies (HONEST local-dev posture) ---
// FR-P1-03 (closure 6): the PRODUCTION contract demands durability ===
// "durable", EXACTLY — evidence stores that lose state on restart must say
// so. These reference stores ARE in-memory, so they keep their true
// "volatile" label and this example runs through createEvaluationMiddleware
// (the sanctioned non-durable wiring path — see examples/node-local.ts).
// A PRODUCTION deployment keeps createOriginServer as-is and wires REAL
// durable adapters (D1/R2/Postgres/…) over the same interfaces; it must
// never relabel an in-memory store to satisfy the factory — that lie is
// exactly what the exact-match durability check exists to catch.
const telemetryStore = new ReferenceTelemetryAdapter(); // durability: "volatile"
const canaryStore = new ReferenceCanaryStore(); // durability: "volatile"
const submissionStore = new ReferenceSubmissionStore(); // durability: "volatile"

const middlewareDeps = {
  // Item 18: profileKeys is the production contract — the ring keys profile
  // derivation, CSRF fallback, and session-envelope verification.
  profileKeys: { current: { id: "default", secret: DEV_SECRET } },
  version: 1,
  upstreamRegisterUrl: "http://127.0.0.1:5051/applications",
  session: new ReferenceSessionAdapter(DEV_SECRET, { version: 1 }),
  render: { inject: referenceInject },
  // Host-owned verification: this origin answers its own verification
  // challenges. (The reference disabled-test adapter is REFUSED here.)
  verification: new HostOwnedVerificationAdapter(async () => true),
  telemetry: telemetryStore,
  enforcement: new ReferenceEnforcementAdapter(),
  // P0 route-evidence capability: REQUIRED for the production strategy
  // pool (P02/P04 verify route probes server-side).
  canaryStore,
  // FR-P0-02 one-submission capability: REQUIRED. The reference store is
  // in-memory; a production host implements HostSubmissionStore over a
  // durable store (unique-constraint claim per session).
  submissionStore,
  // P0 CSRF separation: issuance AND verification resolve through this
  // single secret — never the (rotating) profile keys.
  csrfSecret: CSRF_SECRET,
  // Posture: advisory (annotate, never block) by default. Set
  // FIRERAID_ENFORCEMENT=enforcement for a blocking target — the harness's
  // primary attack surface (denied applications never reach the upstream).
  enforcementMode:
    process.env.FIRERAID_ENFORCEMENT === "enforcement" ? "enforcement" : "advisory",
  routes: ROUTES,
};

async function main() {
  // P1-1: the factory CONSTRUCTS the server; the host owns binding (the
  // removed `port` option was dead configuration). The EVALUATION factory
  // is used because these stores are honestly labeled volatile (above).
  const PORT = 3456;
  const server = createEvaluationOriginServer({
    middlewareDeps,
    htmlLoader,
    routes: ROUTES,
    // The REAL shipped client is served and injected on the application
    // page — the browser executes the same code production serves.
    clientScriptSource: () =>
      readFileSync(new URL("../public/signup.js", import.meta.url), "utf-8"),
    clientScriptPath: "/fireraid-client.js",
    // Host-internal assessment sink (ledger / review workflow join). The
    // applicant NEVER sees any of this — writeResult emits the neutral
    // receipt regardless of disposition.
    onAssessment: (a) => {
      // Reference host: log. Production: persist to the review store.
      console.log(
        `[fireraid] session=${a.sessionId} disposition=${a.disposition} ` +
        `score=${a.score} tier=${a.risk?.tier ?? "?"} ` +
        `evidence=${(a.risk?.evidence ?? []).map((e) => e.source).join(",") || "none"}`
      );
    },
  });

  server.listen(PORT, () => {
    console.log(`FireRaid origin server listening on http://127.0.0.1:${PORT}`);
    console.log("Serving routes:");
    console.log(`  GET  ${ROUTES.applicationPage}        — application page (injects artifacts + client)`);
    if (ROUTES.telemetry) {
      console.log(`  POST ${ROUTES.telemetry}          — telemetry ingest`);
    }
    console.log(`  POST ${ROUTES.applicationSubmit}   — application submission (evaluates)`);
    if (ROUTES.canaryPrefix) {
      console.log(`  GET  ${ROUTES.canaryPrefix}<token> — canary probe verification`);
    }
    console.log(`  GET  /fireraid-client.js           — shipped browser client`);
    console.log("");
    console.log("Synthetic FI upstream on http://127.0.0.1:5051/applications");
    console.log("(admitted applications create records there; denied ones never arrive)");
  });

  // Graceful shutdown on SIGTERM / SIGINT
  const shutdown = () => {
    console.log("\nShutting down origin server...");
    closeServer(server).then(() => {
      console.log("Origin server closed.");
      process.exit(0);
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("Failed to start origin server:", err.message);
  process.exit(1);
});
