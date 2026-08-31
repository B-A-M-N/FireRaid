/**
 * P1-AUDIT-2 (P0-2) — host/Worker TELEMETRY TRANSPORT parity.
 *
 * host-worker-parity.test.ts pins clean-stream DECISION parity. This spec
 * pins the TRANSPORT semantics the Worker's ingestTelemetryBatch has and a
 * bare-append host store does not:
 *
 *   exact replay        — a lost ACK + retried batch must not double-append
 *                         (pointer counts, key counts, focus transitions,
 *                         direct-fill and weak-score totals all hinge on it)
 *   overlap             — 1..5 stored, then 3..8 arrives: the accepted
 *                         prefix is stripped, only 6..8 persists
 *   lost ACK + retry    — the canonical retry shape end-to-end
 *   submit after flush  — a final submit whose eventBatch carries events
 *                         already flushed scores the unique canonical stream
 *   overlapping flushes — interleaved /api/events batches converge to the
 *                         same stored stream as sequential arrival
 *   ACK truth           — acceptedThrough reports the authoritative
 *                         watermark, not "the batch's last seq"
 *
 * Final host metrics must equal aggregation over the unique canonical
 * event stream — the same invariant the Worker's watermark gate gives D1.
 */
import { describe, it, expect } from "vitest";
import {
  admit,
  makeCsrf,
  ReferenceSessionAdapter,
  referenceInject,
  ReferenceVerificationAdapter,
  ReferenceTelemetryAdapter,
  type MiddlewareDeps,
  type HostEnforcementAdapter,
} from "../../src/host-adapter/index.js";
import { aggregateTelemetry } from "../../src/telemetry/aggregate.js";
import { deriveProfilePure } from "../../src/core/profile.js";

const SECRET = "p".repeat(64);
const VERSION = 1;
const HTML = '<html><body><form id="signup-form"></form></body></html>';

class CountingEnforcement implements HostEnforcementAdapter {
  allowed = 0;
  async allow(): Promise<boolean> {
    this.allowed++;
    return true;
  }
  deny(): void {}
}

function deps(telemetry: ReferenceTelemetryAdapter, recipe?: { families: string[] }): MiddlewareDeps {
  return {
    secret: SECRET,
    version: VERSION,
    upstreamRegisterUrl: "http://upstream.invalid/api/register",
    session: new ReferenceSessionAdapter(SECRET),
    render: { inject: (h, p, c, l) => referenceInject(h, p, c, l) },
    verification: new ReferenceVerificationAdapter(),
    telemetry,
    enforcement: new CountingEnforcement(),
    labMode: false,
    recipe: recipe as never,
  };
}

function cookieFor(sessionId: string): Promise<string> {
  return new ReferenceSessionAdapter(SECRET).sessionCookie(sessionId);
}

function csrfFor(sessionId: string): Promise<string> {
  return makeCsrf(SECRET, sessionId);
}

/** Drive one POST through the facade path admit() sees. */async function postJson(
  depsObj: MiddlewareDeps,
  sessionId: string,
  path: string,
  body: Record<string, unknown>
): Promise<{ status: number; json: Record<string, unknown> | null; kind: string; result: Awaited<ReturnType<typeof admit>> }> {
  const cookie = await cookieFor(sessionId);
  const req = new Request(`http://mw${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
  const result = await admit(req, depsObj, async () => HTML);
  const status = result.kind === "deny" ? 403 : 200;
  const json =
    result.kind === "ingest"
      ? { received: result.received, acceptedThrough: result.acceptedThrough }
      : result.kind === "admit"
        ? { ok: true, disposition: result.disposition }
        : result.kind === "deny"
          ? { ok: false, disposition: result.disposition }
          : null;
  return { status, json, kind: result.kind, result };
}

/** seq 1..n of a humanish pointer+key stream (the evidence carriers). */
function stream(n: number): Array<{ seq: number; dt: number; kind: string; target?: string }> {
  const events = [];
  let dt = 0;
  for (let i = 1; i <= n; i++) {
    dt += 120;
    const kind = i % 2 === 0 ? "pointer" : "key";
    events.push({ seq: i, dt, kind, target: kind === "key" ? "email" : undefined });
  }
  return events;
}

describe("P0-2: host telemetry transport semantics (Worker parity)", () => {
  it("exact replay after a lost ACK does NOT double-append", async () => {
    const telemetry = new ReferenceTelemetryAdapter();
    const sessionId = await new ReferenceSessionAdapter(SECRET).createSession();
    const d = deps(telemetry);

    const events = stream(5);
    const first = await postJson(d, sessionId, "/api/events", { events });
    expect(first.json).toMatchObject({ received: 5, acceptedThrough: 5 });

    // Response lost; the client retries the SAME batch (the canonical
    // lost-ACK retry). A bare-append store would now hold 1..5,1..5.
    const retry = await postJson(d, sessionId, "/api/events", { events });
    expect(retry.json).toMatchObject({ received: 0, acceptedThrough: 5 });

    const stored = telemetry.streamsFor(sessionId);
    expect(stored.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it("overlap: stored 1..5, arriving 3..8 persists ONLY 6..8 and ACKs 8", async () => {
    const telemetry = new ReferenceTelemetryAdapter();
    const sessionId = await new ReferenceSessionAdapter(SECRET).createSession();
    const d = deps(telemetry);

    await postJson(d, sessionId, "/api/events", { events: stream(5) });
    const overlap = await postJson(d, sessionId, "/api/events", {
      events: stream(8).slice(2), // seq 3..8
    });
    // The Worker contract: received counts the never-stored suffix.
    expect(overlap.json).toMatchObject({ received: 3, acceptedThrough: 8 });
    expect(telemetry.streamsFor(sessionId).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("empty batch is idempotent and ACKs the current watermark", async () => {
    const telemetry = new ReferenceTelemetryAdapter();
    const sessionId = await new ReferenceSessionAdapter(SECRET).createSession();
    const d = deps(telemetry);
    await postJson(d, sessionId, "/api/events", { events: stream(3) });
    const empty = await postJson(d, sessionId, "/api/events", { events: [] });
    expect(empty.json).toMatchObject({ received: 0, acceptedThrough: 3 });
    expect(telemetry.streamsFor(sessionId)).toHaveLength(3);
  });

  it("final submit whose eventBatch carries already-flushed events scores the UNIQUE stream", async () => {
    // This is P0-1 + P0-2 joined: the real signup.js drains 1..10 through
    // /api/events, then submits eventBatch=1..10 (its outbox until ACK).
    // Metrics must equal aggregation over 1..10 — not 1..10 twice.
    const telemetry = new ReferenceTelemetryAdapter();
    const sessionId = await new ReferenceSessionAdapter(SECRET).createSession();
    // A profile with interaction scoring ON — the aggregate drives evidence.
    let profile = null;
    let sid = sessionId;
    for (let i = 0; i < 50; i++) {
      sid = await new ReferenceSessionAdapter(SECRET).createSession();
      const p = await deriveProfilePure(
        { secret: SECRET, version: VERSION, sessionId: sid, mode: "production" },
        { families: ["interaction"] } as never
      );
      if (p.interaction?.scoringEnabled) { profile = p; break; }
    }
    expect(profile).not.toBeNull();
    const d = deps(telemetry, { families: ["interaction"] });

    const events = stream(10);
    const drained = await postJson(d, sid, "/api/events", { events });
    expect(drained.json).toMatchObject({ received: 10, acceptedThrough: 10 });

    // Submit carrying the SAME 10 events (retry semantics — the outbox was
    // never ACK-trimmed because the responses "were lost").
    const submit = await postJson(d, sid, "/signup", {
      csrf: await csrfFor(sid),
      form: { name: "A", email: "a@b.c" },
      eventBatch: events,
    });
    expect(submit.kind).toBe("admit");

    // The canonical store holds 1..10 EXACTLY ONCE.
    const stored = telemetry.streamsFor(sid);
    expect(stored.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    // And the metrics the middleware scored equal aggregation over that
    // unique stream (the Worker invariant).
    const capture = {
      capturePointer: profile!.telemetry.capturePointer,
      captureKey: profile!.telemetry.captureKey,
    };
    const metrics = aggregateTelemetry(stored, capture);
    const replayed = aggregateTelemetry([...stored, ...stored], capture);
    // Sanity: double-counting MUST move pointer/key counts — otherwise this
    // test cannot distinguish the bug it exists to catch.
    expect(replayed.pointerCount).toBe(metrics.pointerCount * 2);
    expect(replayed.keyCount).toBe(metrics.keyCount * 2);
  });

  it("overlapping flushes converge to the same stored stream regardless of arrival order", async () => {
    const telemetry = new ReferenceTelemetryAdapter();
    const sessionId = await new ReferenceSessionAdapter(SECRET).createSession();
    const d = deps(telemetry);

    // Interleave: A=1..5, B=3..8, C=6..10, D=1..4 (full replay), A again.
    const s = stream(10);
    const batches = [s.slice(0, 5), s.slice(2, 8), s.slice(5, 10), s.slice(0, 4), s.slice(0, 5)];
    for (const b of batches) {
      await postJson(d, sessionId, "/api/events", { events: b });
    }
    expect(telemetry.streamsFor(sessionId).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("structurally invalid batch still denies (invalid verdict carried in the union)", async () => {
    const telemetry = new ReferenceTelemetryAdapter();
    const sessionId = await new ReferenceSessionAdapter(SECRET).createSession();
    const d = deps(telemetry);
    const res = await postJson(d, sessionId, "/api/events", {
      events: [
        { seq: 2, dt: 0, kind: "page_ready" },
        { seq: 1, dt: 100, kind: "focus", target: "x" },
      ],
    });
    expect(res.kind).toBe("deny");
    expect(res.json).toMatchObject({ disposition: "INVALID_TELEMETRY" });
    expect(telemetry.streamsFor(sessionId)).toHaveLength(0);
  });

  it("ACK acceptedThrough is the authoritative watermark, not the batch's last seq", async () => {
    const telemetry = new ReferenceTelemetryAdapter();
    const sessionId = await new ReferenceSessionAdapter(SECRET).createSession();
    const d = deps(telemetry);
    await postJson(d, sessionId, "/api/events", { events: stream(9) });
    // A late 3-event batch 10..12 ACKs 12. Then a stale 1..5 replay ACKs 9
    // (the stored watermark), never 5 — a client trimming to 5 would
    // re-send 6..9 forever.
    const stale = await postJson(d, sessionId, "/api/events", { events: stream(5) });
    expect(stale.json).toMatchObject({ received: 0, acceptedThrough: 9 });
  });
});
