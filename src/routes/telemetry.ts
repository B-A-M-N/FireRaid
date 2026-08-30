/**
 * POST /api/events — telemetry batch ingestion.
 * FR-INV: buffer client-side, flush to D1 with watermark-gated idempotency.
 * FIX: Validate telemetry meta (FR-R2-033).
 * FR-R4-015: oversized batches rejected wholesale (TOO_MANY_EVENTS).
 * FR-R5-018/020: watermark-gated retry semantics + byte-accurate sizing.
 */
import { json, error } from "../security/headers.js";
import type { Env } from "../env.js";
import {
  getSessionId,
  loadSession,
  isExpired,
  touchSession,
} from "../core/session.js";
import {
  ALLOWED_EVENT_TYPES,
  MAX_EVENTS_PER_BATCH,
  MAX_EVENT_PAYLOAD_BYTES,
} from "../types/telemetry.js";

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

type ValidateResult =
  | { ok: true; events: ValidatedEvent[] }
  | { ok: false; code: "TOO_MANY_EVENTS" | "NOT_AN_ARRAY" };

/** UTF-8 byte length of a string (FR-R5-020). */
export function payloadByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Validate a telemetry batch. Shared between /api/events and /api/submit.
 *
 * FR-R4-015: an array longer than MAX_EVENTS_PER_BATCH is rejected wholesale
 *   ({ok:false, code:"TOO_MANY_EVENTS"}) — never truncated silently.
 *   Otherwise invalid events are dropped individually.
 */
export function validateTelemetryBatch(events: unknown): ValidateResult {
  if (!Array.isArray(events)) return { ok: true, events: [] };
  if (events.length > MAX_EVENTS_PER_BATCH) {
    return { ok: false, code: "TOO_MANY_EVENTS" };
  }

  const valid: ValidatedEvent[] = [];
  let lastSeq = -1;
  let lastDt = -1;

  for (const raw of events) {
    if (typeof raw !== "object" || raw === null) continue;
    const e = raw as Record<string, unknown>;
    if (typeof e.kind !== "string" || !ALLOWED_EVENT_TYPES.has(e.kind)) continue;
    if (typeof e.seq !== "number" || !Number.isFinite(e.seq) || e.seq < 0) continue;
    if (typeof e.dt !== "number" || !Number.isFinite(e.dt) || e.dt < 0) continue;
    // FR-R4-015: within-batch ordering must be strictly increasing by seq,
    // nondecreasing by dt. Out-of-order events are dropped, not rejected.
    if (e.seq <= lastSeq) continue;
    if (e.dt < lastDt) continue;

    // Validate meta
    let meta: ValidatedEvent["meta"];
    if (e.meta !== undefined && e.meta !== null) {
      if (typeof e.meta !== "object") continue;
      const metaObj = e.meta as Record<string, unknown>;
      meta = {};
      if (metaObj.synthetic !== undefined) {
        if (typeof metaObj.synthetic !== "boolean") continue;
        meta.synthetic = metaObj.synthetic;
      }
      if (metaObj.inputType !== undefined) {
        if (typeof metaObj.inputType !== "string" || metaObj.inputType.length > 32) continue;
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
 * FR-R5-018: persist a validated batch with a watermark.
 * Single D1 batch (transactional):
 *   1. INSERT event_batches
 *   2. UPDATE sessions SET last_event_seq = ? WHERE id = ? AND last_event_seq < ?
 * Statement 2 must change exactly 1 row; otherwise the caller is replaying
 * stale events → throws SEQ_WATERMARK_VIOLATION. Empty batches resolve 0.
 * Throws PAYLOAD_TOO_LARGE when the JSON payload exceeds 16 KiB.
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

  const insertStmt = db
    .prepare(
      `INSERT INTO event_batches (session_id, created_at, first_seq, last_seq, event_count, payload_json)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(sessionId, Date.now(), firstSeq, lastSeq, events.length, payload);

  const watermarkStmt = db
    .prepare(
      `UPDATE sessions SET last_event_seq = ? WHERE id = ? AND last_event_seq < ?`
    )
    .bind(lastSeq, sessionId, lastSeq);

  const results = await db.batch([insertStmt, watermarkStmt]);
  const watermark = results[1] as { meta?: { changes?: number } };
  if ((watermark.meta?.changes ?? 0) !== 1) {
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

  // FR-R4-015: oversized batches are rejected wholesale
  const validated = validateTelemetryBatch(body.events);
  if (!validated.ok) {
    return error("batch exceeds max events", 413);
  }

  if (validated.events.length > 0) {
    try {
      await persistTelemetryBatch(env.DB, sessionId, validated.events);
      await touchSession(env.DB, sessionId);
    } catch (err) {
      if (err instanceof Error && err.message === "PAYLOAD_TOO_LARGE") {
        return error("payload too large", 413);
      }
      if (err instanceof Error && err.message === "SEQ_WATERMARK_VIOLATION") {
        return error("stale event batch (watermark)", 409);
      }
      return error("failed to persist events", 500);
    }
  }

  return json({ received: validated.events.length });
}
