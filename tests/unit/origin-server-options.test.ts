/**
 * P0-6 / P0-7 — Node origin server construction options do what they say.
 *
 * P0-6: publicOrigin is parsed ONCE at construction (fail fast on
 * malformed input), request URLs are built from the parsed origin (the
 * Host header cannot influence the URL), and https origins survive intact
 * (no `http://https://` splice).
 *
 * P0-7: maxHeaderSize is enforced by the HTTP parser via the
 * http.createServer option — a header block over the limit is rejected at
 * the socket level, observable as a 431/400-style response or a
 * connection close, never as a served request.
 */
import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import net from "node:net";
import { createOriginServer, closeServer } from "../../src/runtime/node.js";
import type { AddressInfo } from "node:net";
import {
  ReferenceSessionAdapter,
  ReferenceTelemetryAdapter,
  ReferenceEnforcementAdapter,
  ReferenceCanaryStore,
  referenceInject,
} from "../../src/host-adapter/index.js";
import type { MiddlewareDeps } from "../../src/host-adapter/middleware.js";

const SECRET = "s".repeat(64);
const VERSION = 1;
const SIGNUP_HTML = '<form id="signup-form"><input name="name"></form>';
const ROUTES = {
  applicationPage: "/signup",
  applicationSubmit: "/signup",
  telemetry: "/api/events",
  canaryPrefix: "/c/",
};

function deps(): MiddlewareDeps {
  return {
    profileKeys: { current: { id: "default", secret: SECRET } },
    version: VERSION,
    upstreamRegisterUrl: "http://localhost:1/api/register",
    session: new ReferenceSessionAdapter(SECRET, { version: VERSION }),
    render: { inject: referenceInject },
    verification: { verificationMode: "host-owned" as const, verify: async () => true },
    telemetry: new ReferenceTelemetryAdapter(),
    enforcement: new ReferenceEnforcementAdapter(),
    canaryStore: new ReferenceCanaryStore(),
    enforcementMode: "advisory" as const,
    routes: ROUTES,
  } as MiddlewareDeps;
}

const servers: http.Server[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const s = servers.pop()!;
    if (s.listening) await closeServer(s);
  }
});

async function listen(server: http.Server): Promise<number> {
  servers.push(server);
  return new Promise<number>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
    server.on("error", reject);
  });
}

describe("P0-6: publicOrigin parsing", () => {
  it("throws at construction on a malformed URL", () => {
    expect(() =>
      createOriginServer({ middlewareDeps: deps(), htmlLoader: async () => SIGNUP_HTML, routes: ROUTES, publicOrigin: "not a url" })
    ).toThrow(/not a valid URL/);
  });

  it("throws on a non-http(s) scheme", () => {
    expect(() =>
      createOriginServer({ middlewareDeps: deps(), htmlLoader: async () => SIGNUP_HTML, routes: ROUTES, publicOrigin: "ftp://example.org" })
    ).toThrow(/scheme must be http: or https:/);
  });

  it("throws when the origin carries a path, query, hash, or userinfo", () => {
    const cases = ["https://example.org/signup", "https://example.org/?a=1", "https://example.org/#x", "https://user:pass@example.org"];
    for (const bad of cases) {
      expect(() =>
        createOriginServer({ middlewareDeps: deps(), htmlLoader: async () => SIGNUP_HTML, routes: ROUTES, publicOrigin: bad }),
        bad
      ).toThrow(/scheme \+ host/);
    }
  });

  it("request URL is built from the parsed origin, not the Host header", async () => {
    // Observable: the host-owned verification adapter receives the request
    // URL the runtime constructed (VerificationInput.requestUrl). Submit
    // with a SPOOFED Host header and assert the URL carries the configured
    // origin — scheme, host, and port all intact (the old splice built
    // `http://https://signup.example.org:8443/...` here). Enforcement is a
    // stub returning `created` (P0-8: the real reference adapter would
    // honestly report transport-failure against the dead test upstream and
    // the runtime would 502 before the verifier ever saw a submit).
    const seenUrls: string[] = [];
    const d = deps();
    const server = createOriginServer({
      middlewareDeps: {
        ...d,
        verification: {
          verificationMode: "host-owned" as const,
          verify: async (_profile, input) => {
            seenUrls.push(input.requestUrl);
            return true;
          },
        },
        enforcement: { allow: async () => ({ kind: "created" }), deny: () => {} },
      },
      htmlLoader: async () => SIGNUP_HTML,

      routes: ROUTES,
      publicOrigin: "https://signup.example.org:8443",
    });
    const port = await listen(server);

    const base = `http://127.0.0.1:${port}`;
    const pageResp = await fetch(`${base}/signup`, { headers: { host: "evil.example" } });
    const cookie = (pageResp.headers.get("set-cookie") ?? "").split(";")[0];
    const page = await pageResp.text();
    const csrf = page.match(/name="csrf" value="([^"]+)"/)?.[1] ?? "";
    const res = await fetch(`${base}/signup`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, host: "evil.example" },
      body: JSON.stringify({
        csrf,
        form: { name: "Origin", email: "o@example.invalid", password: "x-pass-123" },
      }),
    });
    expect(res.status).toBe(200);
    expect(seenUrls.length).toBeGreaterThanOrEqual(1);
    for (const u of seenUrls) {
      expect(u.startsWith("https://signup.example.org:8443/"), u).toBe(true);
      expect(u.startsWith("http://evil.example"), u).toBe(false);
      expect(u.includes("http://https://"), u).toBe(false);
    }
  });

  it("rejects targets that would ESCAPE the pinned origin (WHATWG explicit-form priority)", async () => {
    // `new URL("//evil.com/x", base)` and `new URL("http://evil.com/x", base)`
    // both resolve to evil.com — WHATWG gives an explicit scheme/authority
    // priority over the base. P0-6's promise is that the pinned origin
    // governs; such a request is a client error, not something to re-home.
    const server = createOriginServer({
      middlewareDeps: deps(),
      htmlLoader: async () => SIGNUP_HTML,
      routes: ROUTES,
      publicOrigin: "https://signup.example.org",
    });
    const port = await listen(server);

    const targets = ["//evil.com/x", "http://evil.com/x", "https://evil.com/x"];
    // Node's http client only sends origin-form targets, so drive the
    // attack request-targets over raw sockets.
    for (const target of targets) {
      const line = `GET ${target} HTTP/1.1\r\nHost: signup.example.org\r\n\r\n`;
      const status = await new Promise<string>((resolve) => {
        const sock = net.connect(port, "127.0.0.1", () => sock.write(line));
        let data = "";
        sock.on("data", (c: Buffer | string) => {
          data += String(c);
          if (data.includes("\r\n\r\n") || data.length > 200) {
            sock.destroy();
            resolve(data.split("\r\n")[0] ?? "");
          }
        });
        sock.on("close", () => resolve(data.split("\r\n")[0] ?? ""));
        sock.on("error", () => resolve(data.split("\r\n")[0] ?? ""));
        setTimeout(() => {
          sock.destroy();
          resolve(data.split("\r\n")[0] ?? "");
        }, 2000);
      });
      expect(status, `target ${target}`).toMatch(/^HTTP\/1\.1 400/);
    }
  });
});


describe("P0-7: maxHeaderSize at construction", () => {
  it("rejects a header block over the configured limit at the socket level", async () => {
    const server = createOriginServer({
      middlewareDeps: deps(),
      htmlLoader: async () => SIGNUP_HTML,

      routes: ROUTES,
      maxHeaderSize: 1024,
    });
    const port = await listen(server);

    // Raw socket: send a request whose headers exceed 1024 bytes.
    const result = await new Promise<string>((resolve) => {
      const sock = net.connect(port, "127.0.0.1", () => {
        const pad = "x".repeat(2048);
        sock.write(`GET /signup HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Pad: ${pad}\r\n\r\n`);
      });
      let data = "";
      sock.on("data", (chunk: Buffer | string) => {
        data += String(chunk);
        if (data.includes("\r\n\r\n") || data.length > 512) {
          sock.destroy();
          resolve(data);
        }
      });
      sock.on("close", () => resolve(data));
      sock.on("error", () => resolve(data)); // connection reset also = rejected
      setTimeout(() => {
        sock.destroy();
        resolve(data);
      }, 3000);
    });

    // Node answers 431 (Request Header Fields Too Large) or closes the
    // connection — either way the request is NOT served as 200.
    expect(result).not.toMatch(/^HTTP\/1\.1 200/);
  });

  it("a header block under the limit is served normally", async () => {
    const server = createOriginServer({
      middlewareDeps: deps(),
      htmlLoader: async () => SIGNUP_HTML,

      routes: ROUTES,
      maxHeaderSize: 16_384,
    });
    const port = await listen(server);
    const res = await fetch(`http://127.0.0.1:${port}/signup`);
    expect(res.status).toBe(200);
  });
});
