/**
 * P1-AUDIT-2 Phase C (audit item 2) — origin-ledger experiment target.
 *
 * Joins the two previously-separate proof planes into ONE experiment:
 *
 *     real harness agent
 *       → host-neutral FireRaid admit() middleware
 *         → ordinary upstream signup app (knows NOTHING about FireRaid)
 *           → AUTHORITATIVE ACCOUNT LEDGER
 *
 * The middleware is mounted behind a worker-shaped HTTP facade (GET /signup,
 * POST /api/submit with {csrf, form} JSON) so the EXISTING adapters drive it
 * unmodified. Each trial submits a unique synthetic email; after the trial
 * the runner queries the origin's own ledger read-only — that answer, not
 * FireRaid's `submitted`, is the primary endpoint (origin_account_created).
 *
 * The upstream is spawned exactly as ledger-proof.mjs spawns it; the facade
 * derives each trial's assigned recipe from the caller (blocked-randomized
 * condition). Fail-closed: if the ledger probe is unreachable, the trial's
 * origin truth is recorded as UNKNOWN (never silently false).
 *
 * P1-AUDIT-2 response fixes (this rewrite):
 *   P0-1  the ReferenceTelemetryAdapter is instantiated ONCE per runtime —
 *         the prior per-request `deps()` minted a fresh store every call, so
 *         events drained through /api/events vanished before the submit
 *         scored an empty stream.
 *   P0-4  HOST TRIAL TRUTH: the facade records the middleware's OWN outcome
 *         per session (profile id/variant, families, disposition, score,
 *         canary-verified) — harness-only, never exposed to the browser.
 *         `server_reconciled` on a record now means FireRaid/middleware
 *         truth was actually observed; the ledger probe sets only
 *         origin_reconciled/origin_account_created. The two truths are
 *         independent again.
 *   P0-12 TREATMENT MATERIAL: the runtime derives the SAME recipe the
 *         middleware derives (same secret/version/sid), so the runner can
 *         read the exact issued field name / route token / semantic nonce
 *         per trial — the same exact-material reconciliation the Worker-lab
 *         mode gets from treatment_material.
 *   P1-7  LedgerEnforcement.allow() now performs the REAL upstream POST
 *         itself, so MiddlewareResult.upstreamCreated is authoritative for
 *         what the host adapter observed (no second facade-side forward).
 *   P1-8  EPHEMERAL PORTS: facade and upstream bind port 0; the runtime
 *         reports the actually-bound ports. shutdown() awaits both closes.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { admit, makeCsrf, ReferenceSessionAdapter, referenceInject, ReferenceVerificationAdapter, ReferenceTelemetryAdapter, ReferenceCanaryStore, type MiddlewareDeps, type HostEnforcementAdapter } from "../../src/host-adapter/index.js";
import { deriveProfilePure } from "../../src/core/profile.js";
import type { DefenseRecipe } from "../../src/core/recipe-schema.js";

/**
 * P1-AUDIT-2 (P0-4): the middleware-side trial truth the harness reconciles
 * INDEPENDENTLY of the origin ledger probe. Written by the facade for every
 * evaluated submit; read by the runner after the trial. Harness-only — the
 * browser never sees any of this.
 */
export interface HostTrialTruth {
  /** The FireRaid session id the middleware resolved. */
  sessionId: string;
  /** Issued profile identity (derived under the trial's recipe). */
  profileId: string;
  profileVariantId?: string;
  /** Families the issued profile actually carried. */
  defenseFamilies: string[];
  /** The profile's scoring policy name. */
  scoringPolicy: string;
  /** Did a submit reach the middleware for this session at all? */
  submitted: boolean;
  /** The middleware's decision (undefined when no submit was evaluated). */
  disposition?: "ACCEPT" | "REVIEW" | "QUARANTINE";
  score?: number;
  /** Verified canary-route hit recorded for this session (Class A). */
  canaryVerified: boolean;
  /** The exact treatment material issued for this session (P0-12). */
  treatmentMaterial: {
    fieldName?: string;
    routeToken?: string;
    semanticNonce?: string;
  };
}

export interface OriginLedgerRuntime {
  /** Base URL adapters drive (the worker-shaped facade). */
  facadeUrl: string;
  /** Read-only ledger probe base (e.g. http://localhost:<ephemeral>). */
  ledgerUrl: string;
  /** Assign this trial's condition; resets per-trial truth capture. */
  setTrialRecipe(recipe: DefenseRecipe | undefined): void;
  /** Read-only ledger truth for a synthetic email. null = probe failed. */
  ledgerHasAccount(email: string): Promise<boolean | null>;
  /**
   * P0-4: the middleware-side truth captured during THIS trial (since the
   * last setTrialRecipe). undefined when no submit was evaluated.
   */
  trialTruth(): HostTrialTruth | undefined;
  /** The actually-bound facade port (P1-8 ephemeral). */
  facadePort: number;
  /** The actually-bound upstream port (P1-8 ephemeral). */
  upstreamPort: number;
  /** P1-AUDIT-2 Phase D: the middleware's verified canary-hit store. */
  canaryStore: ReferenceCanaryStore;
  shutdown(): Promise<void>;
}

/**
 * P1-7: the enforcement adapter IS the forward. allow() POSTs the stripped
 * form to the real upstream and returns whether the upstream accepted it —
 * the contract's own definition — so MiddlewareResult.upstreamCreated is
 * authoritative for what the host adapter observed. The facade performs no
 * second forwarding implementation.
 */
class LedgerEnforcement implements HostEnforcementAdapter {
  upstreamCreated = false;
  constructor(private readonly upstreamRegisterUrl: string) {}
  async allow(_url: string, form: Record<string, string>, cookies: string): Promise<boolean> {
    try {
      const resp = await fetch(this.upstreamRegisterUrl, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: cookies },
        body: JSON.stringify({ form }),
      });
      this.upstreamCreated = resp.ok;
      return this.upstreamCreated;
    } catch {
      this.upstreamCreated = false;
      return false;
    }
  }
  deny(_sid: string, reason: string): void {
    if (process.env.FIRERAID_DEBUG_DENY) {
      console.error(`[deny] ${reason}`);
    }
    this.upstreamCreated = false;
  }
}

/** Allocate a free ephemeral port by binding once and releasing (P1-8). */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("no ephemeral port"))));
    });
    srv.on("error", reject);
  });
}

/**
 * Start the ordinary upstream + the middleware facade for one experiment.
 * Idempotent per process: one upstream serves the whole experiment run; the
 * ledger accumulates every trial's account (or doesn't).
 */
export async function startOriginLedgerRuntime(opts: {
  secret: string;
  version: number;
  labMode: boolean;
}): Promise<OriginLedgerRuntime> {
  // 1. Ordinary upstream (own in-memory ledger, FireRaid-ignorant), on an
  //    EPHEMERAL port (P1-8): pre-allocate a free port and pass it through.
  const upstreamPort = await freePort();
  const upstream: ChildProcess = spawn(
    process.execPath,
    ["scripts/ledger-upstream.mjs", String(upstreamPort)],
    { cwd: process.cwd(), stdio: ["ignore", "ignore", "inherit"] }
  );
  let upstreamUp = false;
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://localhost:${upstreamPort}/signup`);
      if (r.ok) { upstreamUp = true; break; }
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!upstreamUp) {
    upstream.kill("SIGTERM");
    throw new Error(`origin-ledger upstream failed to start on :${upstreamPort}`);
  }

  // Fetch the upstream's signup HTML once — the facade injects into it.
  const upstreamHtml = await (await fetch(`http://localhost:${upstreamPort}/signup`)).text();

  // P1-AUDIT-2 Phase F: the facade serves the REAL FireRaid telemetry
  // client (public/signup.js). The upstream serves a stub at the same path
  // ("ordinary upstream: no fireraid client script") — but then NO browser
  // session on the host plane ever produces telemetry, and the interaction
  // ablation cannot fire there at all. The client is part of FireRaid's
  // injected contract (like the artifacts), not the upstream's; the Worker
  // ships it as a static asset and the facade mirrors that. With it, a
  // browser on the host plane intercepts its own submit and POSTs the SAME
  // JSON contract the Worker path uses ({csrf, form, eventBatch}).
  const { readFileSync } = await import("node:fs");
  const signupJs = readFileSync(new URL("../../public/signup.js", import.meta.url)).toString();

  // 2. Middleware deps. The recipe is PER-TRIAL — set by setTrialRecipe().
  //    P0-1: the telemetry store is created ONCE for the whole runtime —
  //    the prior `deps()` factory minted a fresh store per request, so
  //    events drained through /api/events were discarded before the submit
  //    request's store saw an empty stream (the interaction plane measured
  //    nothing). Session and canary store were already per-runtime.
  const session = new ReferenceSessionAdapter(opts.secret);
  let trialRecipe: DefenseRecipe | undefined;
  let enforcement = new LedgerEnforcement(`http://localhost:${upstreamPort}/api/register`);
  const canaryStore = new ReferenceCanaryStore();
  const telemetry = new ReferenceTelemetryAdapter();

  // P0-4: per-trial middleware-side truth capture (harness-only).
  let truth: HostTrialTruth | undefined;

  const deps = (): MiddlewareDeps => ({
    secret: opts.secret,
    version: opts.version,
    upstreamRegisterUrl: `http://localhost:${upstreamPort}/api/register`,
    session,
    render: { inject: (h, p, c, l) => referenceInject(h, p, c, l) },
    verification: new ReferenceVerificationAdapter(),
    telemetry,
    enforcement,
    canaryStore,
    labMode: opts.labMode,
    recipe: trialRecipe,
  });

  // P0-4/P0-12: derive the profile a session was issued under the CURRENT
  // trial recipe — the exact same derivation the middleware performed — so
  // the harness can record issued treatment material + families without a
  // server round-trip. Throws only on a recipe the middleware would also
  // reject (fail-closed parity).
  const issuedProfile = async (sessionId: string) =>
    deriveProfilePure(
      { secret: opts.secret, version: opts.version, sessionId, mode: opts.labMode ? "lab" : "production" },
      trialRecipe
    );

  // 3. Worker-shaped facade: GET /signup → admit(); POST /api/submit → admit().
  //    P1-7: admit() itself forwards through LedgerEnforcement.allow() — the
  //    facade only serializes the middleware result. The handler reads the
  //    bound port through a mutable slot (it fires only after listen()).
  let boundPort = 0;
  const SCORING_DISPOSITIONS = new Set(["ACCEPT", "REVIEW", "QUARANTINE"]);
  const facade: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${boundPort}`);
    // P1-AUDIT-2 Phase F: static telemetry client, mirrored from the
    // Worker's asset serving (the injected page's <script src="/signup.js">).
    if (req.method === "GET" && url.pathname === "/signup.js") {
      res.writeHead(200, { "content-type": "application/javascript" });
      res.end(signupJs);
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const fetchReq = new Request(`http://localhost:${boundPort}${url.pathname}`, {
      method: req.method,
      headers: {
        cookie: req.headers.cookie ?? "",
        // Pass the caller's content-type VERBATIM — the middleware
        // distinguishes the urlencoded (raw form) vs JSON (client-script)
        // submit carriers by it.
        "content-type": req.headers["content-type"] ?? "application/json",
      },
      body: req.method === "GET" ? undefined : body,
    });
    // Route both paths through admit(); the middleware is method-driven
    // (GET → inject+session, POST → evaluate+forward).
    const result = await admit(fetchReq, deps(), async () => upstreamHtml);

    // P0-4: record the middleware-side trial truth whenever the request
    // resolved to a session (submit evaluation paths). Harness-only state.
    if (result.kind === "admit" || (result.kind === "deny" && result.sessionId)) {
      try {
        const profile = await issuedProfile(result.sessionId!);
        const canaryVerified = profile.decoyRoute
          ? await canaryStore.readVerified(result.sessionId!)
          : false;
        truth = {
          sessionId: result.sessionId!,
          profileId: profile.profileId,
          profileVariantId: profile.profileVariantId,
          defenseFamilies: [...profile.families],
          scoringPolicy: profile.scoringPolicy,
          submitted: true,
          disposition: SCORING_DISPOSITIONS.has(result.disposition ?? "")
            ? (result.disposition as HostTrialTruth["disposition"])
            : undefined,
          score: result.score,
          canaryVerified,
          treatmentMaterial: {
            ...(profile.decoyField ? { fieldName: profile.decoyField.fieldName } : {}),
            ...(profile.decoyRoute ? { routeToken: profile.decoyRoute.endpointToken } : {}),
            ...(profile.semantic ? { semanticNonce: profile.semantic.nonce } : {}),
          },
        };
      } catch {
        // Truth capture must never mask the actual response; a derivation
        // failure here leaves truth unset (the runner records it as such).
      }
    }

    if (result.kind === "get") {
      res.writeHead(200, { "content-type": "text/html", "set-cookie": result.setCookie ?? "" });
      res.end(result.html);
      return;
    }
    if (result.kind === "canary-verified") {
      // P1-AUDIT-2 Phase D: verified canary probe — 204, no side effects
      // (mirrors the Worker's noContent()).
      res.writeHead(204);
      res.end();
      return;
    }
    if (result.kind === "ingest") {
      // P1-AUDIT-2 (P1-14): telemetry drain — the Worker-shaped ACK the
      // client's tryAcknowledge() needs to trim its queue.
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ received: result.received, acceptedThrough: result.acceptedThrough }));
      return;
    }
    if (result.kind === "admit") {
      // P1-7: the forward already happened inside allow(); upstreamCreated
      // is the middleware's own observation of it.
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        forwarded: result.upstreamCreated === true,
        disposition: result.disposition,
        score: result.score,
      }));
      return;
    }
    res.writeHead(result.kind === "error" ? 500 : 403, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, disposition: result.disposition }));
  });
  // P1-8: bind the facade to an EPHEMERAL port and read back what the OS
  // actually gave us — no fixed 5063/5064 collisions with concurrent runs.
  await new Promise<void>((resolve, reject) => {
    facade.once("error", reject);
    facade.listen(0, "127.0.0.1", () => resolve());
  });
  const facadeAddr = facade.address();
  const facadePort = typeof facadeAddr === "object" && facadeAddr ? facadeAddr.port : 0;
  if (!facadePort) {
    facade.close();
    upstream.kill("SIGTERM");
    throw new Error("origin-ledger facade failed to bind an ephemeral port");
  }
  boundPort = facadePort;

  return {
    facadeUrl: `http://localhost:${facadePort}`,
    ledgerUrl: `http://localhost:${upstreamPort}`,
    facadePort,
    upstreamPort,
    canaryStore,
    setTrialRecipe(recipe) {
      trialRecipe = recipe;
      enforcement = new LedgerEnforcement(`http://localhost:${upstreamPort}/api/register`);
      truth = undefined;
    },
    async ledgerHasAccount(email): Promise<boolean | null> {
      try {
        const resp = await fetch(
          `http://localhost:${upstreamPort}/api/ledger?email=${encodeURIComponent(email)}`
        );
        if (!resp.ok) return null;
        const data = (await resp.json()) as { exists?: boolean };
        return data.exists === true;
      } catch {
        return null; // probe failure ≠ "not created" — caller records UNKNOWN
      }
    },
    trialTruth() {
      return truth;
    },
    async shutdown() {
      // P1-8: await BOTH closes — the prior fire-and-forget left sockets and
      // children alive across tests (stale listeners on fixed ports).
      await new Promise<void>((resolve) => facade.close(() => resolve()));
      if (upstream.exitCode === null) {
        upstream.kill("SIGTERM");
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => resolve(), 2000);
          upstream.once("exit", () => { clearTimeout(timer); resolve(); });
        });
      }
    },
  };
}

/** The synthetic per-trial email — unique, trial-identity-bound. */
export function trialEmail(experimentId: string, trialKey: string): string {
  return `${experimentId}.${trialKey.replace(/[^a-z0-9]+/gi, "-")}@ledger-probe.invalid`;
}

export { makeCsrf };
