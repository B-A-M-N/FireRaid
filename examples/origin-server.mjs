#!/usr/bin/env node
/**
 * FireRaid origin server — runnable reference host.
 *
 * A minimal Node.js server that wires the PRODUCT middleware
 * (createFireRaidMiddleware + admit) behind a node:http handler. No
 * Cloudflare Worker required — and no evaluation machinery either:
 *
 *   - createFireRaidMiddleware: the production factory. It REFUSES the
 *     evaluation controls (labMode / recipe) by construction, so this
 *     example cannot drift into a lab condition.
 *   - admit: the production entry. Derivation goes through
 *     deriveProductionProfile only — the random production composition
 *     (a causal semantic strategy P02/P03/P04 + at least one independent
 *     layer) with no override path.
 *   - canaryStore: REQUIRED (P0 route-evidence capability). The production
 *     strategy pool contains route-dependent strategies, so the factory
 *     refuses to start without a store that can observe that channel.
 *   - verification: a HOST-OWNED verifier (the reference disabled-test
 *     adapter is refused in production posture).
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
} from "../src/host-adapter/index.js";

// Import compiled TS via tsx at runtime
import { referenceInject } from "../src/host-adapter/reference-render.js";
import { createOriginServer, closeServer } from "../src/runtime/node.js";

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

// --- Wire up middleware dependencies (PRODUCTION posture) ---
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
  verification: new HostOwnedVerificationAdapter(() => true),
  telemetry: new ReferenceTelemetryAdapter(),
  enforcement: new ReferenceEnforcementAdapter(),
  // P0 route-evidence capability: REQUIRED for the production strategy
  // pool (P02/P04 verify route probes server-side).
  canaryStore: new ReferenceCanaryStore(),
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
  const PORT = 3456;
  const server = createOriginServer({
    middlewareDeps,
    htmlLoader,
    port: PORT,
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
