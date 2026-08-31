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
 */
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { admit, makeCsrf, ReferenceSessionAdapter, referenceInject, ReferenceVerificationAdapter, ReferenceTelemetryAdapter, ReferenceCanaryStore, type MiddlewareDeps, type HostEnforcementAdapter } from "../../src/host-adapter/index.js";
import type { DefenseRecipe } from "../../src/core/recipe-schema.js";

// NOT 5060/5061 — those are on the fetch spec's bad-port blocklist
// (sip/sip-tls): undici rejects http://localhost:5061 with "bad port"
// regardless of what listens there.
const UPSTREAM_PORT = 5063;
const FACADE_PORT = 5064;

/** Per-trial enforcement recorder — did admit() forward? */
class LedgerEnforcement implements HostEnforcementAdapter {
  forwarded = false;
  lastForm: Record<string, string> | null = null;
  async allow(_url: string, form: Record<string, string>): Promise<boolean> {
    this.forwarded = true;
    this.lastForm = form;
    // Forward to the real upstream (the middleware contract's allow() IS the
    // forward). The reference adapter would POST itself; here the facade
    // calls the upstream directly so the form/cookies flow is explicit.
    return true;
  }
  deny(_sid: string, _reason: string): void {
    this.forwarded = false;
  }
}

export interface OriginLedgerRuntime {
  /** Base URL adapters drive (the worker-shaped facade). */
  facadeUrl: string;
  /** Read-only ledger probe base (e.g. http://localhost:5061). */
  ledgerUrl: string;
  /** Assign this trial's recipe; returns the signup deps used for it. */
  setTrialRecipe(recipe: DefenseRecipe | undefined): void;
  /** Read-only ledger truth for a synthetic email. null = probe failed. */
  ledgerHasAccount(email: string): Promise<boolean | null>;
  /** P1-AUDIT-2 Phase D: the middleware's verified canary-hit store. */
  canaryStore: ReferenceCanaryStore;
  shutdown(): Promise<void>;
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
  // 1. Ordinary upstream (own in-memory ledger, FireRaid-ignorant).
  const upstream = spawn(process.execPath, ["scripts/ledger-upstream.mjs", String(UPSTREAM_PORT)], {
    cwd: process.cwd(),
    stdio: ["ignore", "ignore", "inherit"],
  });
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://localhost:${UPSTREAM_PORT}/signup`);
      if (r.ok) break;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 100));
  }

  // Fetch the upstream's signup HTML once — the facade injects into it.
  const upstreamHtml = await (await fetch(`http://localhost:${UPSTREAM_PORT}/signup`)).text();

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
  const session = new ReferenceSessionAdapter(opts.secret);
  let trialRecipe: DefenseRecipe | undefined;
  let enforcement = new LedgerEnforcement();
  const canaryStore = new ReferenceCanaryStore();

  const deps = (): MiddlewareDeps => ({
    secret: opts.secret,
    version: opts.version,
    upstreamRegisterUrl: `http://localhost:${UPSTREAM_PORT}/api/register`,
    session,
    render: { inject: (h, p, c, l) => referenceInject(h, p, c, l) },
    verification: new ReferenceVerificationAdapter(),
    telemetry: new ReferenceTelemetryAdapter(),
    enforcement,
    canaryStore,
    labMode: opts.labMode,
    recipe: trialRecipe,
  });

  // 3. Worker-shaped facade: GET /signup → admit(); POST /api/submit → admit().
  //    The middleware's forwarding POSTs to the upstream from inside admit(),
  //    via the ReferenceEnforcementAdapter behavior — here LedgerEnforcement
  //    records the forward and performs it.
  const forwardToUpstream = async (form: Record<string, string>): Promise<boolean> => {
    try {
      const resp = await fetch(`http://localhost:${UPSTREAM_PORT}/api/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ form }),
      });
      return resp.ok;
    } catch {
      return false;
    }
  };

  const facade: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${FACADE_PORT}`);
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
    const fetchReq = new Request(`http://localhost:${FACADE_PORT}${url.pathname}`, {
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
    // Enforcement: the fake forwards and records, mirroring the reference.
    const result = await admit(fetchReq, deps(), async () => upstreamHtml);
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
    if (result.kind === "admit") {
      // Perform the forward the middleware authorized.
      const form = enforcement.lastForm ?? {};
      const created = await forwardToUpstream(form);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, forwarded: created }));
      return;
    }
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, disposition: result.disposition }));
  });
  await new Promise<void>((r) => facade.listen(FACADE_PORT, r));

  return {
    facadeUrl: `http://localhost:${FACADE_PORT}`,
    ledgerUrl: `http://localhost:${UPSTREAM_PORT}`,
    canaryStore,
    setTrialRecipe(recipe) {
      trialRecipe = recipe;
      enforcement = new LedgerEnforcement();
    },
    async ledgerHasAccount(email): Promise<boolean | null> {
      try {
        const resp = await fetch(
          `http://localhost:${UPSTREAM_PORT}/api/ledger?email=${encodeURIComponent(email)}`
        );
        if (!resp.ok) return null;
        const data = (await resp.json()) as { exists?: boolean };
        return data.exists === true;
      } catch {
        return null; // probe failure ≠ "not created" — caller records UNKNOWN
      }
    },
    async shutdown() {
      facade.close();
      upstream.kill("SIGTERM");
    },
  };
}

/** The synthetic per-trial email — unique, trial-identity-bound. */
export function trialEmail(experimentId: string, trialKey: string): string {
  return `${experimentId}.${trialKey.replace(/[^a-z0-9]+/gi, "-")}@ledger-probe.invalid`;
}

export { makeCsrf };
