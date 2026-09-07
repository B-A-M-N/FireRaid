/**
 * FireRaid paired demo — the two origins and their ONE shared upstream.
 *
 * CONTROL arm: a plain reverse proxy in front of the ledger upstream. No
 * FireRaid imports, no middleware — submit goes straight to /api/register
 * (a tiny browser-side shim translates the page's FireRaid-client JSON
 * contract back to the upstream's native form POST; the CONTROL origin is
 * deliberately the "what every site does today" baseline).
 *
 * FIRERAID arm: createEvaluationOriginServer — the REAL middleware (host
 * adapter), the PRODUCTION random composition (no recipe anywhere in this
 * file), enforcement mode. Evidence stores are the reference in-memory
 * stores behind the sanctioned evaluation wiring (volatile, honestly
 * labeled); the demo is a live experiment, not a production deployment.
 *
 * The upstream (scripts/ledger-upstream.mjs) is started ONCE and serves
 * both arms; both origins point at the same registration endpoint and the
 * same read-only ledger probe. The 2×2 matrix joins on that ledger alone.
 *
 * FR-DEMO-07: ONE base application snapshot is fetched at startup and
 * served — byte-identical — to BOTH arms (Control passes it through,
 * FireRaid's htmlLoader injects into it). The trial record carries the
 * snapshot's sha256, so the pair is provably "same base application;
 * only the treatment differs". A mismatched fetch is a startup failure.
 */
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import { createHash } from "node:crypto";
import { createEvaluationOriginServer } from "../src/eval/evaluation-origin.js";
import { closeServer } from "../src/runtime/node.js";
import {
  ReferenceSessionAdapter,
  HostOwnedVerificationAdapter,
  ReferenceTelemetryAdapter,
  ReferenceEnforcementAdapter,
  ReferenceCanaryStore,
  ReferenceSubmissionStore,
  referenceInject,
  type MiddlewareDeps,
} from "../src/host-adapter/index.js";
import { readFileSync } from "node:fs";

const SECRET = process.env.FIRERAID_DEMO_SECRET ?? "fireraid-demo-secret-key-not-for-production!!";
const CSRF_SECRET = process.env.FIRERAID_DEMO_CSRF_SECRET ?? "fireraid-demo-csrf-secret-not-for-production!!!";

/** FR-DEMO-08: bound the operator-plane decision map. */
const MAX_RETAINED_DECISIONS = 64;

export interface DemoOrigins {
  /** CONTROL origin base URL (plain passthrough). */
  controlUrl: string;
  /** FireRaid origin base URL (real middleware). */
  fireraidUrl: string;
  /** The shared upstream base (registration + read-only ledger probe). */
  upstreamUrl: string;
  /** FR-DEMO-07: sha256 of the base application page both arms serve. */
  baseApplicationHash: string;
  /** Read-only ledger probe. null = probe FAILED (callers record INCONCLUSIVE). */
  ledgerHasAccount(email: string): Promise<boolean | null>;
  /**
   * OPERATOR-PLANE ONLY: FireRaid's own decision per submitted email,
   * captured through the runtime's onAssessment seam (the same hook a
   * production host persists to its review store). Never exposed to the
   * applicant plane; the dashboard's evidence card is the only consumer.
   */
  fireraidDecisionFor(email: string): {
    sessionId?: string;
    disposition?: string;
    score?: number;
    evidence: FireraidDecisionShape["evidence"];
  } | undefined;
  shutdown(): Promise<void>;
}

interface FireraidDecisionShape {
  evidence: Array<{
    class: "A" | "B" | "C";
    source: string;
    weight: number;
    verified: boolean;
    description: string;
  }>;
}

/**
 * FR-DEMO-11: freePort() is FORBIDDEN for in-process servers — the
 * probe-then-bind window is a TOCTOU race (another process can claim the
 * port between the probe's close and the real bind, and the demo would
 * then talk to — or fail against — the wrong listener). In-process servers
 * bind on port 0 DIRECTLY and read the kernel-assigned port from the
 * listen callback; freePort() remains ONLY for the one consumer that
 * genuinely needs a port NUMBER in advance (the spawned upstream child's
 * argv), where its residual risk is covered by that child's readiness
 * probe and the supervised-death watchdog.
 */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => (port ? resolve(port) : reject(new Error("no ephemeral port"))));
    });
    srv.on("error", reject);
  });
}

/** Bind an in-process server on an EPHEMERAL port and resolve with the
 * actual assigned port — no probe-then-bind window at all. */
function listenEphemeral(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve(addr.port);
    });
  });
}

export async function startDemoOrigins(): Promise<DemoOrigins> {
  // ── 1. The ONE shared upstream (FireRaid-ignorant, ledger-authoritative).
  const upstreamPort = await freePort();
  const upstream: ChildProcess = spawn(
    process.execPath,
    ["scripts/ledger-upstream.mjs", String(upstreamPort)],
    { cwd: process.cwd(), stdio: ["ignore", "ignore", "inherit"] }
  );
  let upstreamUp = false;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${upstreamPort}/signup`);
      if (r.ok) { upstreamUp = true; break; }
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!upstreamUp) {
    upstream.kill("SIGTERM");
    throw new Error(`demo upstream failed to start on :${upstreamPort}`);
  }
  const upstreamUrl = `http://127.0.0.1:${upstreamPort}`;
  // FR-DEMO-07: the ONE base snapshot — served to both arms unchanged
  // (Control) and as FireRaid's htmlLoader input (the treatment delta is
  // injection alone). Strip the stub script tag once, here, so the two
  // arms are byte-identical pre-injection.
  const baseApplicationHtml = (await (await fetch(`${upstreamUrl}/signup`)).text())
    .replace(/<script[^>]*\/signup\.js"[^>]*><\/script>/, "");
  const baseApplicationHash = createHash("sha256").update(baseApplicationHtml).digest("hex");

  // FR-DEMO-08: supervise the ledger upstream — an unexpected death is an
  // explicit demo infrastructure failure, not silent probe failures later.
  const upstreamDead = new Promise<void>((resolve) => {
    upstream.once("exit", () => resolve());
  });

  // ── 2. CONTROL origin: a plain proxy + a contract shim.
  // The page (injected by NOTHING here — it is the upstream's own HTML) is
  // driven by the harness adapters, which expect the FireRaid client's JSON
  // submit contract ({csrf, form} → POST /api/submit). CONTROL translates
  // that to the upstream's native {form} → POST /api/register. Same fields,
  // no defense — the honest "site without FireRaid" baseline.
  const controlShim = http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && (req.url === "/signup" || req.url?.startsWith("/signup?"))) {
        // FR-DEMO-07: the cached base snapshot — byte-identical to what
        // FireRaid's htmlLoader receives. Never refetched mid-demo.
        res.writeHead(200, { "content-type": "text/html" });
        res.end(baseApplicationHtml);
        return;
      }
      if (req.method === "GET" && req.url === "/signup.js") {
        res.writeHead(200, { "content-type": "application/javascript" });
        res.end("/* control origin: no client script */");
        return;
      }
      if (req.method === "POST" && req.url === "/api/submit") {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}") as {
          form?: Record<string, string>;
        };
        const reg = await fetch(`${upstreamUrl}/api/register`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ form: body.form ?? {} }),
        });
        const regJson = (await reg.json()) as { ok?: boolean; error?: string };
        // The contract the harness adapters read: neutral success receipt.
        if (reg.ok) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ status: "received" }));
        } else {
          res.writeHead(reg.status, { "content-type": "application/json" });
          res.end(JSON.stringify({ status: "rejected", error: regJson.error }));
        }
        return;
      }
      if (req.method === "POST" && req.url === "/api/register") {
        // The page's NATIVE form action: with no FireRaid client script on
        // CONTROL, a submit click posts the raw (urlencoded) form here.
        // Proxy it to the upstream verbatim — CONTROL is a passthrough.
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const contentType = req.headers["content-type"] ?? "application/x-www-form-urlencoded";
        let upstreamBody: string;
        if (contentType.includes("application/json")) {
          upstreamBody = Buffer.concat(chunks).toString("utf-8");
        } else {
          const params = new URLSearchParams(Buffer.concat(chunks).toString("utf-8"));
          const form: Record<string, string> = {};
          for (const [k, v] of params) if (k !== "csrf") form[k] = v;
          upstreamBody = JSON.stringify({ form });
        }
        const reg = await fetch(`${upstreamUrl}/api/register`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: upstreamBody,
        });
        res.writeHead(reg.status, { "content-type": "application/json" });
        res.end(await reg.text());
        return;
      }
      if (req.method === "POST" && req.url === "/api/events") {
        // No telemetry plane on CONTROL — accept and drop (the Worker-shaped
        // ACK keeps the shared client contract harmless if ever posted here).
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ received: 0, acceptedThrough: -1 }));
        return;
      }
      res.writeHead(404);
      res.end("not found");
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "control origin failure" }));
      console.error("[demo] control origin error:", err);
    }
  });
  // FR-DEMO-11: bind on port 0 directly — the kernel assigns the port in
  // the same atomic operation that opens the listener.
  const controlPort = await listenEphemeral(controlShim);

  // ── 3. FireRaid origin: the REAL middleware, production composition.
  // Operator-plane decision sink: onAssessment is the runtime's host-internal
  // annotation seam — the demo joins it to the trial by the submitted email
  // (the same join key the origin ledger uses). This is exactly where a
  // production host would persist its review annotation; the demo dashboard
  // merely displays it. The applicant plane stays fully opaque.
  const decisionsByEmail = new Map<
    string,
    {
      sessionId?: string;
      disposition?: string;
      score?: number;
      evidence: FireraidDecisionShape["evidence"];
    }
  >();

  const deps: MiddlewareDeps = {
    profileKeys: { current: { id: "default", secret: SECRET } },
    version: 1,
    upstreamRegisterUrl: `${upstreamUrl}/api/register`,
    session: new ReferenceSessionAdapter(SECRET, { version: 1 }),
    render: { inject: referenceInject },
    verification: new HostOwnedVerificationAdapter(async () => true),
    telemetry: new ReferenceTelemetryAdapter(),
    enforcement: new ReferenceEnforcementAdapter(),
    canaryStore: new ReferenceCanaryStore(),
    submissionStore: new ReferenceSubmissionStore(),
    csrfSecret: CSRF_SECRET,
    // THE DEMO'S POSTURE: enforcement. Non-ACCEPT decisions do not forward —
    // that is the property the demo demonstrates. (Advisory would forward
    // everything with an annotation and the ledger would always gain the
    // account.)
    enforcementMode: "enforcement",
    routes: {
      applicationPage: "/signup",
      applicationSubmit: "/api/submit",
      telemetry: "/api/events",
      canaryPrefix: "/c/",
    } as const,
  };
  const DEMO_ROUTES = deps.routes!;
  const fireraidServer = createEvaluationOriginServer({
    middlewareDeps: deps,
    htmlLoader: async () => baseApplicationHtml,
    routes: DEMO_ROUTES,
    clientScriptSource: () =>
      readFileSync(new URL("../public/signup.js", import.meta.url), "utf-8"),
    clientScriptPath: "/signup.js",
    onAssessment: (a) => {
      if (a.submittedEmail) {
        // FR-DEMO-08: bound the map — evict the OLDEST entry at capacity.
        if (decisionsByEmail.size >= MAX_RETAINED_DECISIONS) {
          const oldest = decisionsByEmail.keys().next().value;
          if (oldest !== undefined) decisionsByEmail.delete(oldest);
        }
        decisionsByEmail.set(a.submittedEmail.toLowerCase(), {
          sessionId: a.sessionId,
          disposition: a.disposition,
          score: a.score,
          evidence: (a.risk?.evidence ?? []).map((e) => ({
            class: e.class,
            source: e.source,
            weight: e.weight,
            verified: e.verified,
            description: e.description,
          })),
        });
      }
    },
  });
  // FR-DEMO-11: same — direct ephemeral bind, no TOCTOU window.
  const fireraidPort = await listenEphemeral(fireraidServer);

  return {
    controlUrl: `http://127.0.0.1:${controlPort}`,
    fireraidUrl: `http://127.0.0.1:${fireraidPort}`,
    upstreamUrl,
    baseApplicationHash,
    async ledgerHasAccount(email) {
      // FR-DEMO-08: if the upstream child already died, the probe cannot
      // possibly succeed — surface it immediately (the coordinator marks
      // the trial INCONCLUSIVE with the infrastructure detail).
      if (upstream.exitCode !== null || !upstream.pid) return null;
      try {
        const resp = await fetch(
          `${upstreamUrl}/api/ledger?email=${encodeURIComponent(email)}`
        );
        if (!resp.ok) return null;
        const data = (await resp.json()) as { exists?: boolean };
        return data.exists === true;
      } catch {
        return null; // probe failure ≠ "not created" — INCONCLUSIVE
      }
    },
    fireraidDecisionFor(email) {
      return decisionsByEmail.get(email.toLowerCase());
    },
    async shutdown() {
      await closeServer(fireraidServer);
      await new Promise<void>((resolve) => controlShim.close(() => resolve()));
      upstream.kill("SIGTERM");
      // FR-DEMO-08: strongly await the child's exit (with a grace kill).
      const exited = await Promise.race([
        upstreamDead.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_000)),
      ]);
      if (!exited) {
        upstream.kill("SIGKILL");
        await upstreamDead;
      }
    },
  };
}
