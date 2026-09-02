#!/usr/bin/env node
/**
 * P0-AUDIT-3 (P0-4): regression tests for test-worker.mjs process/port
 * identity — the harness that every evidence-producing suite boots through,
 * and that previously could (a) attach to a STALE listener on the requested
 * port (false red and false green both observed) and (b) exit 0 after
 * teardown with the port still leaked.
 *
 * Scenarios:
 *   1. occupied port  → bootstrap refuses (TEST_PORT_ALREADY_IN_USE), never
 *                       spawns wrangler, exit nonzero.
 *   2. normal run     → suite exits its own code AND the port is released
 *                       after teardown (verified from OUTSIDE the supervisor).
 *   3. SIGKILLed supervisor → the independent group reaper kills the wrangler
 *                       group (workerd included) and the port is freed.
 *
 * Usage: node scripts/test-worker-isolation.spec.mjs
 * Exit: 0 = all scenarios hold; 1 = a regression.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, openSync, closeSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = new URL("..", import.meta.url).pathname;
const PORT = 8791; // dedicated — must not collide with suite ports

function portOpen(port) {
  const s = spawnSync(
    "bash",
    ["-c", `(exec 3<>/dev/tcp/127.0.0.1/${port}) 2>/dev/null && echo OPEN || echo CLOSED`],
    { encoding: "utf8", timeout: 2000 }
  );
  return (s.stdout || "").trim() === "OPEN";
}

async function waitUntil(fn, want, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await fn()) === want) return true;
    await sleep(300);
  }
  return false;
}

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) {
    console.log(`  PASS ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── Scenario 1: occupied port → refuse to start ─────────────────────────────
async function scenarioOccupiedPort() {
  console.log("scenario 1: occupied port is refused");
  // Squat the port with a plain TCP server (NOT a Worker — proves the
  // refusal does not depend on what kind of process holds the port).
  const squatter = spawn("node", ["-e", `require("node:net").createServer().listen(${PORT}, "127.0.0.1")`], {
    stdio: "ignore",
    detached: true,
  });
  squatter.unref?.();
  const squatterPid = squatter.pid;
  try {
    check("squatter is listening", await waitUntil(() => portOpen(PORT), true, 5000));
    // Ensure the squatter survives until the assertion lands: poll the pid.
    const persist = spawn("node", ["-e", `setInterval(()=>{},1<<30)`], {
      stdio: "ignore",
      detached: true,
    });
    persist.unref?.();

    const res = spawnSync(
      "node",
      ["scripts/test-worker.mjs", "--suite", "isolation-occ-" + Date.now(), "--port", String(PORT), "--", "true"],
      { cwd: ROOT, encoding: "utf8", timeout: 60_000 }
    );
    check("bootstrap exits nonzero", res.status !== 0, `status=${res.status}`);
    check(
      "names TEST_PORT_ALREADY_IN_USE",
      /TEST_PORT_ALREADY_IN_USE/.test(res.stderr || ""),
      (res.stderr || "").slice(-300)
    );
    check(
      "does NOT claim readiness",
      !/healthy at/.test(res.stdout || ""),
    );
    process.kill(persistPid(persist), "SIGKILL");
  } finally {
    try { process.kill(squatterPid, "SIGKILL"); } catch { /* gone */ }
    await waitUntil(() => portOpen(PORT), false, 5000);
  }
}
function persistPid(p) { return p.pid; }

// ── Scenario 2: normal run → suite exit code propagates, port released ──────
async function scenarioCleanRun() {
  console.log("scenario 2: clean run releases the port");
  check("port free before run", !portOpen(PORT));
  const persistDir = mkdtempSync(join(tmpdir(), "fr-isolation-"));
  const res = spawnSync(
    "node",
    [
      "scripts/test-worker.mjs",
      "--suite", "isolation-clean-" + Date.now(),
      "--port", String(PORT),
      "--persist", persistDir,
      "--", "node", "-e", "process.exit(7)", // distinctive suite code
    ],
    { cwd: ROOT, encoding: "utf8", timeout: 180_000 }
  );
  rmSync(persistDir, { recursive: true, force: true });
  check("suite exit code propagates (7)", res.status === 7, `status=${res.status}`);
  check("teardown verifies port release", /teardown verified: port \d+ released/.test(res.stderr || ""));
  check("port released (outside view)", await waitUntil(() => portOpen(PORT), false, 8000));
  check("no leak warning/failure", !/STILL LISTENING/.test(res.stdout + res.stderr));
}

// ── Scenario 3: SIGKILLed supervisor → reaper frees the port ────────────────
async function scenarioKilledSupervisor() {
  console.log("scenario 3: SIGKILLed supervisor — group reaper frees the port");
  check("port free before run", !portOpen(PORT));
  const persistDir = mkdtempSync(join(tmpdir(), "fr-isolation-"));
  const logPath = join(persistDir, "..", `isolation-kill-${Date.now()}.log`);
  const logFd = openSync(logPath, "w");
  const sup = spawn(
    "node",
    [
      "scripts/test-worker.mjs",
      "--suite", "isolation-kill-" + Date.now(),
      "--port", String(PORT),
      "--persist", persistDir,
      // A long-idling suite keeps everything up while we SIGKILL the supervisor.
      "--", "node", "-e", "setTimeout(()=>{}, 120000)",
    ],
    // Supervisor output → a file (the log carries the readiness + reaper
    // lines; unread pipes would wedge wrangler).
    { cwd: ROOT, stdio: ["ignore", logFd, logFd] }
  );
  try {
    // Wait for the supervisor to pass ITS OWN readiness gate (health +
    // ready-line + Turnstile probe + suite handoff) — a SIGKILL before
    // that point is a different (earlier) failure window, and since the
    // P0-4 fix the reapers are armed from wrangler-spawn time anyway.
    const handoff = await waitUntil(
      () => readFileSync(logPath, "utf8").includes("suite pid="),
      true,
      120_000
    );
    check("supervisor reached suite handoff", handoff);
    // SIGKILL: no handlers run — only the independent group reaper can clean up.
    sup.kill("SIGKILL");
    const freed = await waitUntil(() => portOpen(PORT), false, 30_000);
    check("reaper freed the port after supervisor SIGKILL", freed);
    if (!freed) {
      // Diagnostic: who holds it, and is the reaper still alive?
      const ss = spawnSync("bash", ["-c", `ss -ltnp 2>/dev/null | grep ':${PORT} ' || true`], { encoding: "utf8" });
      console.error("  [diag] holder:", (ss.stdout || "(none)").trim().slice(0, 200));
      const ps = spawnSync("bash", ["-c", "ps -eo pid,ppid,stat,args | grep -F 'node -e' | grep -v grep | head -5 || true"], { encoding: "utf8" });
      console.error("  [diag] node -e procs (reaper candidates):", (ps.stdout || "(none)").trim());
    }
  } finally {
    try { closeSync(logFd); } catch { /* already closed */ }
    rmSync(persistDir, { recursive: true, force: true });
    try { rmSync(logPath, { force: true }); } catch { /* best effort */ }
    try { sup.kill("SIGKILL"); } catch { /* gone */ }
    await waitUntil(() => portOpen(PORT), false, 10_000);
  }
}

const scenarios = { occupied: scenarioOccupiedPort, clean: scenarioCleanRun, kill: scenarioKilledSupervisor };
const only = process.argv[2];
for (const [name, fn] of Object.entries(scenarios)) {
  if (only && name !== only) continue;
  await fn();
}
if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nall isolation checks PASS");
