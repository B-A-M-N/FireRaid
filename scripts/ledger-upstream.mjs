#!/usr/bin/env node
/**
 * P1-24 — ORDINARY upstream signup app with its own account ledger.
 *
 * This app knows NOTHING about FireRaid. It exposes:
 *   GET  /signup        → serves a plain signup HTML page
 *   POST /api/register  → creates an account in its own in-memory ledger
 *
 * The ledger is the PRIMARY experimental truth for the middleware proof:
 * a synthetic account "exists" IFF this app's register endpoint accepted it.
 * FireRaid sits in front and may or may not forward; the ledger is the
 * authority. No shared secret, no FireRaid import — deliberately ordinary.
 *
 * Run: node scripts/ledger-upstream.mjs [port]
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const PORT = Number(process.argv[2] ?? 5051);

// In-memory ledger: email → { name, created_at }. The experiment's truth.
/** @type {Map<string, {name: string, created_at: number}>} */
const LEDGER = new Map();

const SIGNUP_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Acme Research — Sign Up</title></head>
<body><main>
<h1>Create your Acme account</h1>
<form id="signup-form" method="POST" action="/api/register">
<fieldset class="fr-form-fields"><legend>Account</legend>
<label for="name">Full Name</label>
<input type="text" id="name" name="name" required autocomplete="name">
<label for="email">Email</label>
<input type="email" id="email" name="email" required autocomplete="email">
<label for="organization">Organization</label>
<input type="text" id="organization" name="organization" autocomplete="organization">
<label for="intended-use">Intended Use</label>
<textarea id="intended-use" name="intended_use" rows="3"></textarea>
<label for="password">Password</label>
<input type="password" id="password" name="password" required minlength="8" autocomplete="new-password">
</fieldset>
<button type="submit" id="submit-btn">Create Account</button>
</form>
<p class="fr-disclaimer">Acme Research access — synthetic data only.</p>
</main><script src="/signup.js"></script></body></html>`;

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try { resolve(JSON.parse(data || "{}")); } catch { resolve({}); }
    });
  });
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/signup") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(SIGNUP_HTML);
      return;
    }
    if (req.method === "GET" && req.url === "/signup.js") {
      res.writeHead(200, { "content-type": "application/javascript" });
      res.end("/* ordinary upstream: no fireraid client script */");
      return;
    }
    if (req.method === "POST" && req.url === "/api/register") {
      const body = await readBody(req);
      const form = body.form ?? {};
      const email = String(form.email ?? "").trim().toLowerCase();
      const name = String(form.name ?? "").trim();
      if (!email || !name) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "name and email required" }));
        return;
      }
      if (LEDGER.has(email)) {
        res.writeHead(409, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "account exists" }));
        return;
      }
      LEDGER.set(email, { name, created_at: Date.now() });
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, email }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "not found" }));
  } catch (err) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: String(err) }));
  }
});

server.listen(PORT, () => {
  console.log(`[ledger-upstream] ordinary upstream listening on :${PORT} (ledger is the truth)`);
});

// Expose the ledger for assertions by the proof harness (same process).
export { LEDGER, server };
