/**
 * FireRaid paired demo — entry point (npm run demo).
 *
 * Starts:
 *   - the shared ledger upstream (FireRaid-ignorant; the ONLY truth source)
 *   - the CONTROL origin (plain passthrough — no middleware)
 *   - the FireRaid origin (real middleware, production composition, enforcement)
 *   - the demo coordinator (paired trials via the real harness adapters)
 *   - this dashboard server (static UI + SSE event stream + run buttons)
 *
 * NOTHING in this file participates in the product/package graph; demo/ is
 * excluded from the product boundary by construction (see
 * scripts/check-product-boundary.mjs PRODUCT_FILES — demo files are absent,
 * and tsconfig.product.json does not include demo/).
 */
import http from "node:http";
import { readFileSync } from "node:fs";
import { startDemoCoordinator, type DemoCoordinator } from "./runner.js";
import type { DemoEvent, TrialRecord } from "./shared.js";

const DASHBOARD_PORT = Number(process.env.FIRERAID_DEMO_PORT ?? 4777);

async function main(): Promise<void> {
  const coordinator: DemoCoordinator = await startDemoCoordinator();
  const { controlUrl, fireraidUrl } = await coordinator.ready();

  const dashboardHtml = readFileSync(new URL("./dashboard.html", import.meta.url), "utf-8");

  const sseClients = new Set<http.ServerResponse>();
  const sendSse = (res: http.ServerResponse, event: string, data: unknown): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Wire the coordinator's semantic event stream to every live dashboard.
  coordinator.subscribe((e: DemoEvent) => {
    for (const client of sseClients) sendSse(client, "demo-event", e);
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${DASHBOARD_PORT}`);
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/dashboard")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(dashboardHtml);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/demo-info") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ controlUrl, fireraidUrl }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/history") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(coordinator.history()));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/events") {
      // SSE: semantic trial events (shared.ts DemoEvent). Replay history as
      // synthetic "trial.completed" frames so a mid-run join still sees
      // the 2×2 matrix.
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      sendSse(res, "hello", { controlUrl, fireraidUrl });
      for (const rec of coordinator.history() as TrialRecord[]) {
        sendSse(res, "trial-record", rec);
      }
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }
    if (req.method === "POST" && (url.pathname === "/api/run-agent" || url.pathname === "/api/run-human")) {
      const actor = url.pathname === "/api/run-agent" ? "agent" : "human";
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ accepted: true, actor }));
      // One trial at a time — a second request while running is refused by
      // the busy flag (below), not queued (a demo is watched live).
      void (async () => {
        try {
          const record = await coordinator.runTrial(actor);
          for (const client of sseClients) {
            sendSse(client, "trial-record", record);
          }
        } catch (err) {
          console.error("[demo] trial failed:", err);
          for (const client of sseClients) {
            sendSse(client, "coordinator-error", { error: String(err) });
          }
        }
      })();
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  // Serialize trials: one paired run at a time (the dashboard disables the
  // buttons while one is in flight, and the server enforces it too).
  let busy = false;
  const originalRun = coordinator.runTrial.bind(coordinator);
  coordinator.runTrial = async (actor) => {
    if (busy) throw new Error("a trial is already running");
    busy = true;
    try {
      return await originalRun(actor);
    } finally {
      busy = false;
    }
  };

  await new Promise<void>((resolve) => server.listen(DASHBOARD_PORT, "127.0.0.1", resolve));
  console.log("FireRaid paired demo");
  console.log(`  dashboard:   http://127.0.0.1:${DASHBOARD_PORT}`);
  console.log(`  CONTROL:     ${controlUrl}  (plain origin, no FireRaid)`);
  console.log(`  FIRERAID:    ${fireraidUrl}  (real middleware, enforcement mode)`);
  console.log("  upstream:    shared account service + read-only ledger (THE truth source)");
  console.log("");
  console.log("Open the dashboard and press RUN AGENT, then RUN HUMAN.");

  const shutdown = (): void => {
    console.log("\nShutting down demo...");
    server.close();
    coordinator.shutdown().then(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("demo failed to start:", err);
  process.exit(1);
});
