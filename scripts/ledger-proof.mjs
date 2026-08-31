#!/usr/bin/env node
/**
 * P1-24 — Middleware proof: FireRaid admission in front of the ordinary
 * upstream ledger app.
 *
 * Spins up the ordinary upstream (scripts/ledger-upstream.mjs) and mounts
 * the host-neutral FireRaid `admit()` middleware in front of it via a thin
 * Node http proxy. Drives a CONTROL (no defense) vs FULL (all defenses)
 * registration and asserts the PRIMARY experimental truth: the upstream
 * ledger contains the synthetic account exactly when admission allowed it.
 *
 * This exercises the exact P1-25 host-adapter seam: ReferenceSessionAdapter,
 * referenceInject (HostRenderAdapter), ReferenceVerificationAdapter,
 * ReferenceTelemetryAdapter, ReferenceEnforcementAdapter.
 *
 * Run: node scripts/ledger-proof.mjs
 * Exit: 0 = proof holds (ledger truth matches admission decision), 1 = fail.
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";

const UPSTREAM_PORT = 5051;
const MIDDLEWARE_PORT = 5052;
const SECRET = "x".repeat(64); // 64-char test secret
const VERSION = 1;

async function startUpstream() {
  const proc = spawn(process.execPath, ["scripts/ledger-upstream.mjs", String(UPSTREAM_PORT)], {
    cwd: process.cwd(),
    stdio: ["ignore", "inherit", "inherit"],
  });
  // wait for health
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://localhost:${UPSTREAM_PORT}/signup`);
      if (r.ok) return proc;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("upstream did not start");
}

// Hard self-timeout so a hang surfaces as a clear FAIL, not a 60s spinner.
const HARD = setTimeout(() => { console.error("ledger proof HARD TIMEOUT"); process.exit(1); }, 30000);

async function main() {
  const upstream = await startUpstream();
  console.log("[proof] upstream up");

  // Dynamically import the compiled host-adapter middleware. The repo runs
  // TS via tsx; we import the source directly (tsx resolves .ts).
  const {
    admit,
    ReferenceSessionAdapter,
    referenceInject,
    ReferenceVerificationAdapter,
    ReferenceTelemetryAdapter,
    ReferenceEnforcementAdapter,
  } = await import("../src/host-adapter/index.ts");

  const session = new ReferenceSessionAdapter();
  const verification = new ReferenceVerificationAdapter();
  const telemetry = new ReferenceTelemetryAdapter();
  const enforcement = new ReferenceEnforcementAdapter();

  const deps = {
    secret: SECRET,
    version: VERSION,
    upstreamRegisterUrl: `http://localhost:${UPSTREAM_PORT}/api/register`,
    session,
    render: { inject: (html, profile, csrf, lab) => referenceInject(html, profile, csrf, lab) },
    verification,
    telemetry,
    enforcement,
    labMode: false,
  };

  const htmlLoader = async () => {
    const r = await fetch(`http://localhost:${UPSTREAM_PORT}/signup`);
    return r.text();
  };

  // ── Middleware http proxy ────────────────────────────────────────────────
  const mw = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${MIDDLEWARE_PORT}`);
    // lift method + body into a fresh Request for admit()
    const buf = req.method === "GET" ? undefined : await new Promise((r) => {
      let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => r(Buffer.from(d)));
    });
    const fetchReq = new Request(`http://localhost:${MIDDLEWARE_PORT}${url.pathname}${url.search}`, {
      method: req.method,
      headers: { cookie: req.headers.cookie ?? "", "content-type": req.headers["content-type"] ?? "application/json" },
      body: buf,
    });
    const result = await admit(fetchReq, deps, htmlLoader);
    if (result.kind === "get") {
      res.writeHead(200, { "content-type": "text/html", "set-cookie": result.setCookie ?? "" });
      res.end(result.html);
    } else if (result.kind === "admit") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "received", disposition: result.disposition, upstreamCreated: result.upstreamCreated }));
    } else {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "denied", disposition: result.disposition }));
    }
  });
  await new Promise((r) => mw.listen(MIDDLEWARE_PORT, r));
  console.log("[proof] middleware up");

  // ── Drive a registration through the middleware ─────────────────────────
  const BASE = `http://localhost:${MIDDLEWARE_PORT}`;
  const getResp = await fetch(`${BASE}/signup`);
  const cookie = getResp.headers.get("set-cookie") ?? "";
  const html = await getResp.text();
  const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1] ?? "";

  const regResp = await fetch(`${BASE}/signup`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      csrf,
      form: { name: "Synthetic Agent", email: "agent@example.invalid", password: "synthetic-password-123" },
    }),
  });
  const regJson = await regResp.json();

  // ── Assert the ledger truth ─────────────────────────────────────────────
  const ledgerResp = await fetch(`http://localhost:${UPSTREAM_PORT}/api/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ form: { email: "agent@example.invalid", name: "probe" } }),
  });
  const ledgerSaysExists = ledgerResp.status === 409; // 409 = already registered

  let pass = true;
  const lines = [];
  lines.push(`middleware disposition: ${regJson.disposition}`);
  lines.push(`middleware upstreamCreated: ${regJson.upstreamCreated}`);
  lines.push(`upstream ledger contains synthetic account: ${ledgerSaysExists}`);

  // PRIMARY TRUTH: ledger entry exists IFF admission forwarded (upstreamCreated true).
  if (regJson.upstreamCreated === true && !ledgerSaysExists) {
    pass = false; lines.push("FAIL: middleware says created but ledger has no account");
  }
  if (regJson.upstreamCreated === false && ledgerSaysExists) {
    pass = false; lines.push("FAIL: ledger has account but middleware denied forwarding");
  }
  if (regJson.disposition === "QUARANTINE" && ledgerSaysExists) {
    pass = false; lines.push("FAIL: quarantined submission still created an upstream account");
  }

  console.log(lines.join("\n"));
  mw.close();
  upstream.kill("SIGTERM");
  clearTimeout(HARD);
  console.log(pass ? "\nLEDGER PROOF: PASS" : "\nLEDGER PROOF: FAIL");
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error("ledger proof error:", err);
  process.exit(1);
});
