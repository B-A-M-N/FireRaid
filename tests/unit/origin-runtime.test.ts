/**
 * Origin runtime tests — verify the Node.js HTTP adapter wiring the product
 * middleware (createFireRaidMiddleware + admit).
 *
 * Exercises:
 *   - createOriginServer starts and serves a GET on the application page
 *     returning injected HTML (contains a csrf hidden input)
 *   - unknown path → 404
 *   - deny path → 403 JSON
 *   - closeServer shuts down (awaitable)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { createOriginServer, closeServer } from "../../src/runtime/node.js";
import type { AddressInfo } from "node:net";
import {
  ReferenceSessionAdapter,
  ReferenceTelemetryAdapter,
  ReferenceEnforcementAdapter,
  ReferenceCanaryStore,
  referenceInject,
} from "../../src/host-adapter/index.js";

const SECRET = "s".repeat(64);
const VERSION = 1;

const SIGNUP_HTML = '<form id="signup-form"><input name="csrf"><input name="name"><input name="email"><button>Submit</button></form>';

const ROUTES = {
  applicationPage: "/signup",
  applicationSubmit: "/signup",
  telemetry: "/api/events",
  canaryPrefix: "/c/",
};

function buildDeps() {
  return {
    // Production-shaped fixture: profileKeys is THE contract (item 18).
    profileKeys: { current: { id: "default", secret: SECRET } },
    version: VERSION,
    upstreamRegisterUrl: "http://localhost:5051/api/register",
    session: new ReferenceSessionAdapter(SECRET, { version: VERSION }),
    render: { inject: referenceInject },
    verification: { verificationMode: "host-owned" as const, verify: async () => true },
    telemetry: new ReferenceTelemetryAdapter(),
    enforcement: new ReferenceEnforcementAdapter(),
    canaryStore: new ReferenceCanaryStore(),
    enforcementMode: "advisory" as const,
    routes: ROUTES,
  };
}

async function htmlLoader() {
  return SIGNUP_HTML;
}

describe("origin runtime (node:http adapter)", () => {
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    const deps = buildDeps();
    server = createOriginServer({
      middlewareDeps: deps,
      htmlLoader,
      port: 0, // ephemeral port
      routes: ROUTES,
    });
    port = await new Promise<number>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as AddressInfo;
        resolve(addr.port);
      });
      server.on("error", reject);
    });
  });

  afterEach(async () => {
    if (server.listening) {
      await closeServer(server);
    }
  });

  it("GET on application page returns injected HTML with csrf hidden input", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/signup`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain('name="csrf"');
    expect(res.headers.get("set-cookie")).toContain("__Host-fr_sid=");
  });

  it("unknown path → 404", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/nonexistent`);
    expect(res.status).toBe(404);
  });

  it("deny path returns 403 JSON with error message", async () => {
    // POST to /signup without a session is denied (NO_SESSION → 403).
    const res = await fetch(`http://127.0.0.1:${port}/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ form: { name: "A", email: "a@b.c" } }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toHaveProperty("error", "NO_SESSION");
  });

  it("closeServer shuts down (awaitable)", async () => {
    // server.listening should be true and closeServer resolves without error
    expect(server.listening).toBe(true);
    await closeServer(server);
    expect(server.listening).toBe(false);
  });
});
