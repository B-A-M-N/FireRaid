/**
 * POST /api/events — telemetry batch ingestion.
 * FR-INV: buffer client-side, flush to D1 with watermark-gated idempotency.
 * FIX: Validate telemetry meta (FR-R2-033).
 * FR-R4-015: oversized batches rejected wholesale (TOO_MANY_EVENTS).
 * FR-R5-018/020: watermark-gated retry semantics + byte-accurate sizing.
 * FR-R6-031: fresh sessions (last_event_seq NULL) accept their first batch —
 *   every watermark comparison uses COALESCE(last_event_seq, -1).
 * FR-R6-033: the watermark compares the batch's FIRST seq edge, not last —
 *   an overlapping replay (stored 50, incoming 1..100) is rejected.
 * FR-R6-034: seq/dt must be safe integers (fractions rejected).
 * FR-R6-035: structural violations reject the WHOLE batch — no silent
 *   per-event normalization that mutates the observation stream.
 * FR-R6-032: the INSERT itself is gated on the watermark predicate INSIDE
 *   the D1 batch, so a rejected batch inserts nothing; batch identity
 *   (session_id, first_seq, last_seq) is unique, making exact replays a
 *   distinct, benign BATCH_IDENTITY_CONFLICT.
 */
import { json, error } from "../security/headers.js";
import type { Env } from "../env.js";
import {
  getSessionId,
  isExpired,
} from "../core/session.js";
import {
  loadSession,
} from "../cloudflare/session.js";;
import {
  ALLOWED_EVENT_TYPES,
  MAX_EVENTS_PER_BATCH,
  MAX_EVENT_PAYLOAD_BYTES,
} from "../types/telemetry.js";
import { isLabMode } from "../env.js";
import { mergeSessionMetrics } from "../telemetry/aggregate.js";

/** Canonical validated telemetry event shape. */
export interface ValidatedEvent {
  seq: number;
  dt: number;
  kind: string;
  target?: string;
  meta?: {
    synthetic?: boolean;
    inputType?: string;
  };
}

export type ValidateResult =
  | { ok: true; events: ValidatedEvent[] }
  | {
      ok: false;
      code:
        | "TOO_MANY_EVENTS"
        | "NOT_AN_ARRAY"
        | "MALFORMED_EVENT"
        | "SEQ_ORDER_VIOLATION";
      detail?: string;
    };

/** UTF-8 byte length of a string (FR-R5-020). */
export function payloadByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Validate a telemetry batch. Shared between /api/events and /api/submit.
 *
 * FR-R4-015: an array longer than MAX_EVENTS_PER_BATCH is rejected wholesale
 *   ({ok:false, code:"TOO_MANY_EVENTS"}) — never truncated silently.
 * FR-R6-034: seq/dt must be Number.isSafeInteger; dt nonnegative, seq >= 0.
 * FR-R6-035: a structurally bad event rejects the whole batch
 *   (MALFORMED_EVENT / SEQ_ORDER_VIOLATION) — the server never silently
 *   rewrites a malformed observation stream into a well-formed-looking one.
 */
export function validateTelemetryBatch(events: unknown): ValidateResult {
  if (!Array.isArray(events)) return { ok: false, code: "NOT_AN_ARRAY" };
  if (events.length > MAX_EVENTS_PER_BATCH) {
    return { ok: false, code: "TOO_MANY_EVENTS" };
  }

  const valid: ValidatedEvent[] = [];
  let lastSeq = -1;
  let lastDt = -1;

  for (const raw of events) {
    if (typeof raw !== "object" || raw === null) {
      return { ok: false, code: "MALFORMED_EVENT", detail: "event is not an object" };
    }
    const e = raw as Record<string, unknown>;
    if (typeof e.kind !== "string" || !ALLOWED_EVENT_TYPES.has(e.kind)) {
      return { ok: false, code: "MALFORMED_EVENT", detail: `unknown kind: ${String(e.kind)}` };
    }
    // FR-R6-034: safe integers only — Number.isFinite allowed 1.5 through.
    if (typeof e.seq !== "number" || !Number.isSafeInteger(e.seq) || e.seq < 0) {
      return { ok: false, code: "MALFORMED_EVENT", detail: `bad seq: ${String(e.seq)}` };
    }
    if (typeof e.dt !== "number" || !Number.isSafeInteger(e.dt) || e.dt < 0) {
      return { ok: false, code: "MALFORMED_EVENT", detail: `bad dt: ${String(e.dt)}` };
    }
    // FR-R6-035: within-batch ordering must be strictly increasing by seq,
    // nondecreasing by dt — violations reject the WHOLE batch.
    if (e.seq <= lastSeq) {
      return { ok: false, code: "SEQ_ORDER_VIOLATION", detail: `seq ${e.seq} after ${lastSeq}` };
    }
    if (e.dt < lastDt) {
      return { ok: false, code: "SEQ_ORDER_VIOLATION", detail: `dt regressed at seq ${e.seq}` };
    }

    // Validate meta
    let meta: ValidatedEvent["meta"];
    if (e.meta !== undefined && e.meta !== null) {
      if (typeof e.meta !== "object") {
        return { ok: false, code: "MALFORMED_EVENT", detail: "meta is not an object" };
      }
      const metaObj = e.meta as Record<string, unknown>;
      meta = {};
      if (metaObj.synthetic !== undefined) {
        if (typeof metaObj.synthetic !== "boolean") {
          return { ok: false, code: "MALFORMED_EVENT", detail: "meta.synthetic not boolean" };
        }
        meta.synthetic = metaObj.synthetic;
      }
      if (metaObj.inputType !== undefined) {
        if (typeof metaObj.inputType !== "string" || metaObj.inputType.length > 32) {
          return { ok: false, code: "MALFORMED_EVENT", detail: "meta.inputType invalid" };
        }
        meta.inputType = metaObj.inputType;
      }
    }

    valid.push({
      seq: e.seq,
      dt: e.dt,
      kind: e.kind,
      target: typeof e.target === "string" ? e.target.slice(0, 128) : undefined,
      meta,
    });
    lastSeq = e.seq;
    lastDt = e.dt;
  }

  return { ok: true, events: valid };
}

/**
 * Persist a validated batch with a first-edge watermark (FR-R6-031/032/033).
 *
 * Single D1 batch (transactional), both statements gated on the SAME
 * predicate — the watermark's PRE-UPDATE value must be below the batch's
 * FIRST seq:
 *   1. INSERT ... SELECT ... WHERE COALESCE((SELECT last_event_seq FROM
 *      sessions WHERE id = ?), -1) < ?first_seq
 *   2. UPDATE sessions SET last_event_seq = ?last_seq WHERE id = ? AND
 *      COALESCE(last_event_seq, -1) < ?first_seq
 *
 * If statement 2 changes 0 rows, the batch lost a race or replayed — nothing
 * observable was committed (statement 1's predicate is the identical
 * pre-update read, so a "changed 0" means its INSERT also matched 0 rows).
 * A unique-violation on idx_event_batches_identity (migration 0008) means an
 * EXACT replay of an already-accepted batch → BATCH_IDENTITY_CONFLICT.
 * Empty batches resolve 0. Throws PAYLOAD_TOO_LARGE over 16 KiB.
 */
export async function persistTelemetryBatch(
  db: D1Database,
  sessionId: string,
  events: ValidatedEvent[]
): Promise<number> {
  if (events.length === 0) return 0;

  const payload = JSON.stringify(events);
  if (payloadByteLength(payload) > MAX_EVENT_PAYLOAD_BYTES) {
    throw new Error("PAYLOAD_TOO_LARGE");
  }

  const firstSeq = events[0].seq;
  const lastSeq = events[events.length - 1].seq;

  // FR-R6-032/033: BOTH statements gated on the first edge of the incoming
  // batch vs the stored watermark (COALESCE handles fresh NULL rows).
  // FR-R7-017: the watermark UPDATE also bumps last_seen_at — previously
  // the route called touchSession() after this, causing a second UPDATE.
  const now = Date.now();
  const insertStmt = db
    .prepare(
      `INSERT INTO event_batches (session_id, created_at, first_seq, last_seq, event_count, payload_json)
       SELECT ?, ?, ?, ?, ?, ?
       WHERE COALESCE((SELECT last_event_seq FROM sessions WHERE id = ?), -1) < ?`
    )
    .bind(sessionId, now, firstSeq, lastSeq, events.length, payload, sessionId, firstSeq);

  const watermarkStmt = db
    .prepare(
      `UPDATE sessions SET last_event_seq = ?, last_seen_at = ? WHERE id = ? AND COALESCE(last_event_seq, -1) < ?`
    )
    .bind(lastSeq, now, sessionId, firstSeq);

  let results: { meta?: { changes?: number } }[];
  try {
    results = (await db.batch([insertStmt, watermarkStmt])) as { meta?: { changes?: number } }[];
  } catch (err) {
    // FR-R6-032: unique violation on the identity index = exact replay of an
    // accepted batch. Distinguishable, benign, and NOT a watermark violation.
    const msg = err instanceof Error ? err.message : String(err);
    if (/UNIQUE\s+constraint\s+failed.*idx_event_batches_identity|constraint\s+failed.*event_batches/i.test(msg)) {
      throw new Error("BATCH_IDENTITY_CONFLICT");
    }
    throw err;
  }

  const watermark = results[1] ?? {};
  if ((watermark.meta?.changes ?? 0) !== 1) {
    // Overlapping/stale replay: the INSERT's identical predicate already
    // selected 0 rows, so nothing was committed.
    throw new Error("SEQ_WATERMARK_VIOLATION");
  }
  return lastSeq;
}

export async function events(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return error("method not allowed", 405);

  const sessionId = getSessionId(req);
  if (!sessionId) return error("no session", 403);
  const session = await loadSession(env.DB, sessionId);
  if (!session) return error("invalid session", 403);
  if (isExpired(session.createdAt)) return error("session expired", 403);

  let body: { events?: unknown };
  try {
    body = (await req.json()) as { events?: unknown };
  } catch {
    return error("invalid JSON", 400);
  }

  if (!body.events || !Array.isArray(body.events)) {
    return error("missing events array", 400);
  }

  const validated = validateTelemetryBatch(body.events);
  if (!validated.ok) {
    if (validated.code === "TOO_MANY_EVENTS") {
      return error("batch exceeds max events", 413);
    }
    return error(`telemetry rejected: ${validated.code}${validated.detail ? ` (${validated.detail})` : ""}`, 400);
  }

  if (validated.events.length > 0) {
    try {
      await persistTelemetryBatch(env.DB, sessionId, validated.events);
      // FR-R7-022: production sessions maintain a compact per-session
      // metrics row that submit scoring reads at finalize time. Lab mode
      // skips this — research needs the raw event_batches rows intact.
      if (!isLabMode(env)) {
        // Read capture config from the session's persisted profile — we
        // already SELECTed the session above, so the capture flags are not
        // yet in hand. Use the page-config defaults (pointer/key both on,
        // matching the most common production profile shape); when the
        // profile disables capture the resulting noPointerEvents/noKeyEvents
        // fields become NULL (unknown) rather than scoring the user.
        try {
          await mergeSessionMetrics(
            env.DB,
            sessionId,
            validated.events,
            { capturePointer: true, captureKey: true }
          );
        } catch (mergeErr) {
          // Metrics merge is best-effort; never block an event batch.
          console.warn("session_metrics merge failed:", mergeErr);
        }
      }
    } catch (err) {
      if (err instanceof Error && err.message === "PAYLOAD_TOO_LARGE") {
        return error("payload too large", 413);
      }
      if (err instanceof Error && err.message === "SEQ_WATERMARK_VIOLATION") {
        return error("stale event batch (watermark)", 409);
      }
      if (err instanceof Error && err.message === "BATCH_IDENTITY_CONFLICT") {
        // FR-R6-032: exact replay of an accepted batch — idempotent success.
        return json({ received: 0, duplicate: true });
      }
      return error("failed to persist events", 500);
    }
  }

  return json({ received: validated.events.length, acceptedThrough: validated.events[validated.events.length - 1].seq });
}

/**
 * FR-R5-048: retention — delete event batches older than the cutoff.
 * Wired by the scheduled handler; exported here so the SQL lives beside the
 * rest of the telemetry storage code.
 */
export async function pruneEventBatches(db: D1Database, beforeMs: number): Promise<number> {
  const result = await db
    .prepare(`DELETE FROM event_batches WHERE created_at < ?`)
    .bind(beforeMs)
    .run();
  return result.meta?.changes ?? 0;
}
