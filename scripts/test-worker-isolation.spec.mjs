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
import { createServer } from "node:net";

const ROOT = new URL("..", import.meta.url).pathname;

async function allocatePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  if (!port) throw new Error("could not allocate an ephemeral isolation-test port");
  return port;
}

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
  const port = await allocatePort();
  // Squat the port with a plain TCP server (NOT a Worker — proves the
  // refusal does not depend on what kind of process holds the port).
  const squatter = spawn("node", ["-e", `require("node:net").createServer().listen(${port}, "127.0.0.1")`], {
    stdio: "ignore",
    detached: true,
  });
  squatter.unref?.();
  const squatterPid = squatter.pid;
  try {
    check("squatter is listening", await waitUntil(() => portOpen(port), true, 5000));
    // Ensure the squatter survives until the assertion lands: poll the pid.
    const persist = spawn("node", ["-e", `setInterval(()=>{},1<<30)`], {
      stdio: "ignore",
      detached: true,
    });
    persist.unref?.();

    const res = spawnSync(
      "node",
      ["scripts/test-worker.mjs", "--suite", "isolation-occ-" + Date.now(), "--port", String(port), "--", "true"],
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
    await waitUntil(() => portOpen(port), false, 5000);
  }
}
function persistPid(p) { return p.pid; }

// ── Scenario 2: normal run → suite exit code propagates, port released ──────
async function scenarioCleanRun() {
  console.log("scenario 2: clean run releases the port");
  const port = await allocatePort();
  check("port free before run", !portOpen(port));
  const persistDir = mkdtempSync(join(tmpdir(), "fr-isolation-"));
  const res = spawnSync(
    "node",
    [
      "scripts/test-worker.mjs",
      "--suite", "isolation-clean-" + Date.now(),
      "--port", String(port),
      "--persist", persistDir,
      "--", "node", "-e", "process.exit(7)", // distinctive suite code
    ],
    { cwd: ROOT, encoding: "utf8", timeout: 180_000 }
  );
  rmSync(persistDir, { recursive: true, force: true });
  check("suite exit code propagates (7)", res.status === 7, `status=${res.status}`);
  check("teardown verifies port release", /teardown verified: port \d+ released/.test(res.stderr || ""));
  check("port released (outside view)", await waitUntil(() => portOpen(port), false, 8000));
  check("no leak warning/failure", !/STILL LISTENING/.test(res.stdout + res.stderr));
}

// ── Scenario 3: SIGKILLed supervisor → reaper frees the port ────────────────
async function scenarioKilledSupervisor() {
  console.log("scenario 3: SIGKILLed supervisor — group reaper frees the port");
  const port = await allocatePort();
  check("port free before run", !portOpen(port));
  const persistDir = mkdtempSync(join(tmpdir(), "fr-isolation-"));
  const logPath = join(persistDir, "..", `isolation-kill-${Date.now()}.log`);
  const logFd = openSync(logPath, "w");
  const sup = spawn(
    "node",
    [
      "scripts/test-worker.mjs",
      "--suite", "isolation-kill-" + Date.now(),
      "--port", String(port),
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
    const freed = await waitUntil(() => portOpen(port), false, 30_000);
    check("reaper freed the port after supervisor SIGKILL", freed);
    if (!freed) {
      // Diagnostic: who holds it, and is the reaper still alive?
      const ss = spawnSync("bash", ["-c", `ss -ltnp 2>/dev/null | grep ':${port} ' || true`], { encoding: "utf8" });
      console.error("  [diag] holder:", (ss.stdout || "(none)").trim().slice(0, 200));
      const ps = spawnSync("bash", ["-c", "ps -eo pid,ppid,stat,args | grep -F 'node -e' | grep -v grep | head -5 || true"], { encoding: "utf8" });
      console.error("  [diag] node -e procs (reaper candidates):", (ps.stdout || "(none)").trim());
    }
  } finally {
    try { closeSync(logFd); } catch { /* already closed */ }
    rmSync(persistDir, { recursive: true, force: true });
    try { rmSync(logPath, { force: true }); } catch { /* best effort */ }
    try { sup.kill("SIGKILL"); } catch { /* gone */ }
    await waitUntil(() => portOpen(port), false, 10_000);
  }
}

// ── Scenario 4: a healthy run OUTLIVES the old 60s reaper bomb ───────────────
// FR-RR-58 regression: the old workerd reaper bounded its supervisor WATCH
// at 60s and then fell into the kill loop UNCONDITIONALLY — any healthy run
// past 60s got its own workerd SIGKILLed mid-suite (the deterministic
// "wrangler died by SIGKILL" flake). The reaper must watch INDEFINITELY
// while the supervisor lives; only supervisor DEATH arms cleanup.
async function scenarioLongRunSurvives() {
  console.log("scenario 4: healthy run past 60s is NOT self-killed");
  const port = await allocatePort();
  check("port free before run", !portOpen(port));
  const persistDir = mkdtempSync(join(tmpdir(), "fr-isolation-"));
  const logPath = join(persistDir, "..", `isolation-long-${Date.now()}.log`);
  const logFd = openSync(logPath, "w");
  const sup = spawn(
    "node",
    [
      "scripts/test-worker.mjs",
      "--suite", "isolation-long-" + Date.now(),
      "--port", String(port),
      "--persist", persistDir,
      // A suite that idles ~75s — past the old 60s bomb's fuse.
      "--", "node", "-e", "setTimeout(()=>{}, 75000)",
    ],
    { cwd: ROOT, stdio: ["ignore", logFd, logFd] }
  );
  try {
    const handoff = await waitUntil(
      () => readFileSync(logPath, "utf8").includes("suite pid="),
      true,
      120_000
    );
    check("supervisor reached suite handoff", handoff);
    if (!handoff) return;

    const workerdPid = () => {
      const ss = spawnSync(
        "bash", ["-c", `ss -ltnp 2>/dev/null | grep ':${port} ' || true`], { encoding: "utf8" }
      );
      const m = [...(ss.stdout || "").matchAll(/pid=(\d+)/g)].map((x) => Number(x[1]));
      for (const pid of m) {
        const comm = spawnSync("bash", ["-c", `cat /proc/${pid}/comm 2>/dev/null || true`], { encoding: "utf8" });
        if ((comm.stdout || "").trim() === "workerd") return pid;
      }
      return null;
    };
    const before = workerdPid();
    check("workerd holds the port", before !== null);

    // Cross the old fuse (60s) with a healthy supervisor, then confirm the
    // Worker is STILL the same process and STILL answering.
    await sleep(70_000);
    check("supervisor still alive past 60s", sup.pid !== undefined && !sup.killed);
    const after = workerdPid();
    check("SAME workerd identity past 60s", after !== null && after === before,
      `before=${before} after=${after}`);
    const health = spawnSync(
      "curl", ["-fsS", "--max-time", "5", `http://127.0.0.1:${port}/health`],
      { encoding: "utf8" }
    );
    check("/health STILL 200 past 60s", health.status === 0, `curl rc=${health.status}`);

    // Now SIGKILL the supervisor: ONLY THEN does cleanup arm — port frees,
    // no descendant workerd remains.
    sup.kill("SIGKILL");
    check("port freed after supervisor SIGKILL", await waitUntil(() => portOpen(port), false, 30_000));
    check("no descendant workerd remains", await waitUntil(() => workerdPid() === null, true, 15_000));
  } finally {
    try { closeSync(logFd); } catch { /* already closed */ }
    rmSync(persistDir, { recursive: true, force: true });
    try { rmSync(logPath, { force: true }); } catch { /* best effort */ }
    try { sup.kill("SIGKILL"); } catch { /* gone */ }
    await waitUntil(() => portOpen(port), false, 10_000);
  }
}

const scenarios = {
  occupied: scenarioOccupiedPort,
  clean: scenarioCleanRun,
  kill: scenarioKilledSupervisor,
  longrun: scenarioLongRunSurvives,
};
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
