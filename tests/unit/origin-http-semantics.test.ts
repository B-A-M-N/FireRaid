/**
 * FR-RR-09 — body-level protocol errors keep their HTTP semantics through the
 * generic host middleware AND its Node runtime projection.
 *
 * The bounded streaming readers classify OVERSIZE / BAD_JSON / MISSING; the
 * middleware preserves those as httpStatus on the deny result; the origin
 * server honors it instead of the blanket 403. These tests go through
 * createOriginServer — including a chunked (no Content-Length) oversize body,
 * the case a Content-Length-only check cannot see — so the whole wire path is
 * exercised, not just the reader utility.
 */
import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import net from "node:net";
import { createOriginServer, closeServer } from "../../src/runtime/node.js";
import type { AddressInfo } from "node:net";
import {
  ReferenceSessionAdapter,
  referenceInject,
} from "../../src/host-adapter/index.js";
import { MAX_HOST_JSON_BYTES } from "../../src/types/telemetry.js";
import {
  DurableTelemetryAdapter,
  DurableCanaryStore,
  DurableSubmissionStore,
} from "./helpers/durable-stores.js";

const SECRET = "s".repeat(64);
const VERSION = 1;
const SIGNUP_HTML =
  '<form id="signup-form"><input name="email"><input name="password"><button>Submit</button></form>';
const ROUTES = {
  applicationPage: "/signup",
  applicationSubmit: "/signup",
  telemetry: "/api/events",
  canaryPrefix: "/c/",
};

const servers: http.Server[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const s = servers.pop()!;
    if (s.listening) await closeServer(s);
  }
});

function boot(): Promise<number> {
  const server = createOriginServer({
    middlewareDeps: {
      profileKeys: { current: { id: "default", secret: SECRET } },
      version: VERSION,
      upstreamRegisterUrl: "http://127.0.0.1:1/register",
      session: new ReferenceSessionAdapter(SECRET, { version: VERSION }),
      render: { inject: referenceInject },
      telemetry: new DurableTelemetryAdapter(),
      verification: { verificationMode: "host-owned" as const, verify: async () => true },
      enforcement: { allow: async () => ({ kind: "created" as const }), deny: () => {} },
      canaryStore: new DurableCanaryStore(),
      submissionStore: new DurableSubmissionStore(),
      enforcementMode: "enforcement",
      routes: ROUTES,
    } as never,
    htmlLoader: async () => SIGNUP_HTML,
    routes: ROUTES,
  });
  servers.push(server);
  return new Promise<number>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
    server.on("error", reject);
  });
}

async function pageCookie(port: number): Promise<string> {
  const page = await fetch(`http://127.0.0.1:${port}/signup`);
  return (page.headers.get("set-cookie") ?? "").split(";")[0];
}

/** Oversize JSON payload (MAX + padding inside a form field). */
function oversizeJson(csrf: string = "x"): string {
  return JSON.stringify({ csrf, form: { email: "h@example.invalid", pad: "a".repeat(MAX_HOST_JSON_BYTES) } });
}

/** Raw socket request with chunked framing — no Content-Length anywhere. */
function chunkedRequest(
  port: number,
  raw: (sock: net.Socket) => void
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1");
    let data = "";
    sock.on("connect", () => raw(sock));
    sock.on("data", (d: Buffer) => {
      data += d.toString();
      if (data.includes("\r\n\r\n")) {
        const status = Number(data.split(" ")[1]);
        // The JSON error body follows the header separator; enough to assert on.
        const body = data.split("\r\n\r\n")[1] ?? "";
        sock.end();
        resolve({ status, body });
      }
    });
    sock.on("error", reject);
  });
}

function chunk(sock: net.Socket, payload: string): void {
  const hex = Buffer.byteLength(payload).toString(16);
  sock.write(`${hex}\r\n${payload}\r\n`);
}

describe("FR-RR-09: submit path HTTP semantics through the Node runtime", () => {
  it("an oversize JSON body with Content-Length is 413, not 403", async () => {
    const port = await boot();
    const res = await fetch(`http://127.0.0.1:${port}/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: oversizeJson(),
    });
    // The Node bridge enforces the same cap at the transport layer
    // (PAYLOAD_TOO_LARGE); the middleware's httpStatus path is the backstop
    // for hosts that bridge bodies themselves. Either way: 413, never 403.
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toBe("PAYLOAD_TOO_LARGE");
  });

  it("an oversize CHUNKED body (no Content-Length) is 413 — streamed enforcement", async () => {
    const port = await boot();
    const cookie = await pageCookie(port);
    const res = await chunkedRequest(port, (sock) => {
      sock.write(
        `POST /signup HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nCookie: ${cookie}\r\n` +
          `Content-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n`
      );
      // Drip over the cap in 16KB chunks — the limit must trip mid-stream,
      // proving bytes are counted as they arrive, not from a declared length.
      const payload = JSON.stringify({ csrf: "x", form: { pad: "b".repeat(16 * 1024) } });
      for (let i = 0; i < (MAX_HOST_JSON_BYTES / (16 * 1024)) + 1; i++) chunk(sock, payload);
      sock.write("0\r\n\r\n");
    });
    expect(res.status).toBe(413);
  });

  it("malformed JSON is 400, not 403", async () => {
    const port = await boot();
    const cookie = await pageCookie(port);
    const res = await fetch(`http://127.0.0.1:${port}/signup`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("BAD_JSON");
  });

  it("a missing body is 400, not 403", async () => {
    const port = await boot();
    const cookie = await pageCookie(port);
    const res = await fetch(`http://127.0.0.1:${port}/signup`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      // No body at all.
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("MISSING_BODY");
  });

  it("an oversize urlencoded form is 413", async () => {
    const port = await boot();
    const cookie = await pageCookie(port);
    const res = await fetch(`http://127.0.0.1:${port}/signup`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: `email=h@example.invalid&pad=${"a".repeat(MAX_HOST_JSON_BYTES)}`,
    });
    expect(res.status).toBe(413);
  });

  it("CSRF failure stays a 403 admission denial — not collapsed to 400", async () => {
    const port = await boot();
    const cookie = await pageCookie(port);
    const res = await fetch(`http://127.0.0.1:${port}/signup`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ csrf: "wrong-token", form: { email: "h@example.invalid", password: "p-123456" } }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("CSRF_FAILED");
  });
});

describe("FR-RR-09: ingest path HTTP semantics through the Node runtime", () => {
  it("an oversize telemetry batch is 413", async () => {
    const port = await boot();
    const cookie = await pageCookie(port);
    const res = await fetch(`http://127.0.0.1:${port}/api/events`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ events: [{ pad: "a".repeat(MAX_HOST_JSON_BYTES) }] }),
    });
    expect(res.status).toBe(413);
  });

  it("malformed telemetry JSON is 400", async () => {
    const port = await boot();
    const cookie = await pageCookie(port);
    const res = await fetch(`http://127.0.0.1:${port}/api/events`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: "][",
    });
    expect(res.status).toBe(400);
  });
});
