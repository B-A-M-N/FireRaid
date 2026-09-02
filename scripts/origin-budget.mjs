#!/usr/bin/env node
/**
 * Origin budget harness — measures the PRODUCT (not the Worker).
 *
 * Drives the PRODUCTION admission seam (`admit()` over deps validated by
 * `createFireRaidMiddleware` — routes, canaryStore, real verifier, no lab
 * overrides) and verifies:
 *   (a) profile-generation: the production derivation is local crypto only
 *       (< 20ms, steady-state after one warm-up draw)
 *   (b) signup-inject: a GET through admit with form-bearing HTML (< 50ms)
 *   (c) submit-assessment: a POST with valid session+CSRF (< 50ms)
 *   (d) LLM call counter: ZERO network egress by stubbing global fetch
 *   (e) D1/DB imports: grep-level scan of the product runtime seam
 *       (host-adapter + runtime) for "cloudflare/" and "D1Database"
 *
 * Usage:
 *   npm run test:origin-budget
 *
 * Note: This script MUST be run via `node --import tsx scripts/origin-budget.mjs`
 * (or `npm run test:origin-budget`) so that the tsx loader resolves .ts files.
 */

import { readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// --- Imports via tsx loader ---
const {
  admit,
  ReferenceSessionAdapter,
  HostOwnedVerificationAdapter,
  ReferenceTelemetryAdapter,
  ReferenceEnforcementAdapter,
  ReferenceCanaryStore,
  referenceInject,
} = await import("../src/host-adapter/index.js");
const { createFireRaidMiddleware } = await import("../src/host-adapter/middleware.js");
const { deriveProductionProfile } = await import("../src/core/profile.js");

// --- Helpers ---

const SECRET = "s".repeat(64);
const VERSION = 1;
const SIGNUP_HTML = '<form id="signup-form" method="post"><input name="csrf"><input name="name"><input name="email"><button>Submit</button></form>';
const ROUTES = {
  applicationPage: "/signup",
  applicationSubmit: "/signup",
  telemetry: "/api/events",
  canaryPrefix: "/c/",
};

function buildDeps() {
  return createFireRaidMiddleware({
    profileKeys: { current: { id: "default", secret: SECRET } },
    version: VERSION,
    upstreamRegisterUrl: "http://localhost:5051/api/register",
    session: new ReferenceSessionAdapter(SECRET, { version: VERSION }),
    render: { inject: referenceInject },
    verification: new HostOwnedVerificationAdapter(() => true),
    telemetry: new ReferenceTelemetryAdapter(),
    enforcement: new ReferenceEnforcementAdapter(),
    canaryStore: new ReferenceCanaryStore(),
    enforcementMode: "advisory",
    routes: ROUTES,
  });
}

async function htmlLoader() {
  return SIGNUP_HTML;
}

// --- Timing robustness ---
// Timing assertions use the MEDIAN of several samples so a busy host
// (scheduler noise, other CI jobs) cannot flip the gate. p95/max are
// reported for visibility but are informational.

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function p95(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)];
}
function fmtStats(xs) {
  return `median=${median(xs).toFixed(1)}ms p95=${p95(xs).toFixed(1)}ms max=${Math.max(...xs).toFixed(1)}ms`;
}
const SAMPLES = 7;

// --- Scenario: profile-generation ---

async function scenario_profile_generation() {
  const s = new ReferenceSessionAdapter(SECRET);
  // Warm-up draw (module/class init), then sample steady state.
  await deriveProductionProfile({ secret: SECRET, version: VERSION, sessionId: await s.createSession() });
  const samples = [];
  let profile;
  for (let i = 0; i < SAMPLES; i++) {
    const sessionId = await s.createSession();
    const t0 = performance.now();
    profile = await deriveProductionProfile({ secret: SECRET, version: VERSION, sessionId });
    samples.push(performance.now() - t0);
  }
  return { samples, profile };
}

// --- Scenario: signup-inject ---

async function scenario_signup_inject() {
  const samples = [];
  let kind = "";
  let hasCsrf = false;
  for (let i = 0; i < SAMPLES; i++) {
    const d = buildDeps();
    const t0 = performance.now();
    const result = await admit(new Request("http://test/signup"), d, htmlLoader);
    samples.push(performance.now() - t0);
    kind = result.kind;
    hasCsrf = result.html?.includes('name="csrf"') ?? false;
  }
  return { samples, kind, hasCsrf };
}

// --- Scenario: submit-assessment ---

async function scenario_submit_assessment() {
  const samples = [];
  let kind = "";
  let disposition = "";
  for (let i = 0; i < SAMPLES; i++) {
    const d = buildDeps();
    // GET first — the middleware mints its own CSRF from resolveCsrfSecret;
    // the POST must consume the middleware's OWN issued token (the full
    // issue→verify roundtrip, not a host-replicated scheme).
    const get = await admit(new Request("http://test/signup"), d, htmlLoader);
    const cookie = get.setCookie ?? "";
    const csrf = (get.html?.match(/name="csrf" value="([^"]+)"/) ?? [])[1] ?? "";
    const t0 = performance.now();
    const result = await admit(
      new Request("http://test/signup", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          csrf,
          form: { name: "Test", email: "test@example.com" },
        }),
      }),
      d,
      htmlLoader
    );
    samples.push(performance.now() - t0);
    kind = result.kind;
    disposition = result.disposition;
  }
  return { samples, kind, disposition };
}

// --- Scenario: zero-llm (network egress stub) ---

async function scenario_zero_llm() {
  let fetchCalls = 0;
  let nonLocalhostFetch = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    fetchCalls++;
    const url = args[0];
    if (typeof url === "string" && !url.startsWith("http://localhost")) {
      nonLocalhostFetch++;
      throw new Error(`Network egress blocked: ${url}`);
    }
    return originalFetch(...args);
  };

  try {
    const d = buildDeps();
    // GET inject path doesn't call fetch.
    await admit(new Request("http://test/signup"), d, htmlLoader);
    // POST submit path: enforcement.allow would call the (localhost)
    // upstream URL under ACCEPT. Any NON-localhost egress throws.
    const get = await admit(new Request("http://test/signup"), d, htmlLoader);
    const cookie = get.setCookie ?? "";
    const csrf = (get.html?.match(/name="csrf" value="([^"]+)"/) ?? [])[1] ?? "";
    await admit(
      new Request("http://test/signup", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ csrf, form: { name: "A", email: "a@b.c" } }),
      }),
      d,
      htmlLoader
    );

    return { fetchCalls, nonLocalhostFetch };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// --- Scenario: zero-d1-import-scan ---

async function scenario_zero_d1_imports() {
  // Scan the product runtime seam (host-adapter + runtime) which is the
  // boundary that tsconfig.product.json targets — core may contain
  // cloudflare/ references used by the Worker route but the origin runtime
  // must not directly depend on them.
  const scanDirs = ["src/host-adapter", "src/runtime"];
  let cloudflareImportCount = 0;
  let d1ImportCount = 0;
  let violations = [];

  for (const dir of scanDirs) {
    const fullPath = join(ROOT, dir);
    try {
      const entries = await readdir(fullPath, { recursive: true });
      for (const entry of entries) {
        const filePath = join(fullPath, entry);
        if (!entry.endsWith(".ts")) continue;
        try {
          const content = await readFile(filePath, "utf-8");
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const codeOnly = line.replace(/\/\/.*/, "").replace(/\/\*.*\*\//, "").trim();
            if (!codeOnly) continue;
            if (codeOnly.includes("cloudflare/")) {
              cloudflareImportCount++;
              violations.push(`${dir}/${entry}:${i + 1}: cloudflare/ import`);
            }
            if (codeOnly.includes("D1Database")) {
              d1ImportCount++;
              violations.push(`${dir}/${entry}:${i + 1}: D1Database type`);
            }
          }
        } catch {
          // Skip unreadable files
        }
      }
    } catch {
      // Directory doesn't exist yet
    }
  }

  return { cloudflareImportCount, d1ImportCount, violations };
}

// --- Runner ---

async function run() {
  let allPassed = true;

  console.log("=== Origin Budget Harness ===\n");

  // 1. profile-generation
  process.stdout.write("  profile-generation        ");
  try {
    const { samples, profile } = await scenario_profile_generation();
    const passed = median(samples) < 20 && profile.families.length > 0;
    console.log(`${passed ? "PASS" : "FAIL"} — ${fmtStats(samples)} (budget: median <20ms)`);
    if (!passed) allPassed = false;
  } catch (err) {
    console.log(`FAIL — ${err.message}`);
    allPassed = false;
  }

  // 2. signup-inject
  process.stdout.write("  signup-inject             ");
  try {
    const { samples, kind, hasCsrf } = await scenario_signup_inject();
    const passed = median(samples) < 50 && kind === "get" && hasCsrf;
    console.log(`${passed ? "PASS" : "FAIL"} — ${fmtStats(samples)}, kind=${kind}, csrf=${hasCsrf} (budget: median <50ms)`);
    if (!passed) allPassed = false;
  } catch (err) {
    console.log(`FAIL — ${err.message}`);
    allPassed = false;
  }

  // 3. submit-assessment
  process.stdout.write("  submit-assessment         ");
  try {
    const { samples, kind, disposition } = await scenario_submit_assessment();
    const passed = median(samples) < 50 && kind === "admit";
    console.log(`${passed ? "PASS" : "FAIL"} — ${fmtStats(samples)}, kind=${kind}, disposition=${disposition} (budget: median <50ms)`);
    if (!passed) allPassed = false;
  } catch (err) {
    console.log(`FAIL — ${err.message}`);
    allPassed = false;
  }

  // 4. zero-llm
  process.stdout.write("  zero-network-egress       ");
  try {
    const { fetchCalls, nonLocalhostFetch } = await scenario_zero_llm();
    const passed = nonLocalhostFetch === 0;
    console.log(`${passed ? "PASS" : "FAIL"} — fetchCalls=${fetchCalls}, nonLocalhost=${nonLocalhostFetch}`);
    if (!passed) allPassed = false;
  } catch (err) {
    console.log(`FAIL — ${err.message}`);
    allPassed = false;
  }

  // 5. zero-d1-imports
  process.stdout.write("  zero-d1-imports           ");
  try {
    const { cloudflareImportCount, d1ImportCount, violations } = await scenario_zero_d1_imports();
    const passed = cloudflareImportCount === 0 && d1ImportCount === 0;
    console.log(`${passed ? "PASS" : "FAIL"} — cloudflare/=${cloudflareImportCount}, D1Database=${d1ImportCount}`);
    for (const v of violations) {
      console.log(`    WARN: ${v}`);
    }
    if (!passed) allPassed = false;
  } catch (err) {
    console.log(`FAIL — ${err.message}`);
    allPassed = false;
  }

  console.log("");
  console.log(allPassed ? "All scenarios PASS" : "Some scenarios FAILED");
  process.exit(allPassed ? 0 : 1);
}

run().catch((err) => {
  console.error("Budget harness failed:", err);
  process.exit(1);
});
