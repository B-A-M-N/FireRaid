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
 * FR-P0-3: read the authoritative telemetry watermark for a session.
 * One indexed SELECT; -1 when the session has no stored events yet.
 */
export async function readWatermark(db: D1Database, sessionId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT last_event_seq FROM sessions WHERE id = ?`)
    .bind(sessionId)
    .first<{ last_event_seq: number | null }>();
  return row?.last_event_seq ?? -1;
}

export type IngestOutcome =
  | {
      kind: "accepted";
      /** Events actually persisted (the never-stored suffix). */
      stored: ValidatedEvent[];
      /** Authoritative watermark after persistence = last stored seq. */
      acceptedThrough: number;
      /** True when the incoming batch was an exact replay (nothing new). */
      duplicate: boolean;
    }
  | { kind: "conflict"; acceptedThrough: number }
  | { kind: "too_large" }
  | { kind: "failed" };

/**
 * FR-P0-2/P0-3: the ONE canonical telemetry ingestion path, shared by
 * /api/events and /api/submit. Given a validated batch:
 *
 *   1. Read the authoritative watermark (sessions.last_event_seq).
 *   2. If the batch's FIRST seq is <= watermark, strip the already-accepted
 *      prefix — an overlap carries both stored events AND never-stored ones;
 *      dropping the whole batch silently loses the suffix (the FR-R7-022-era
 *      submit bug).
 *   3. If nothing remains, the batch was fully stored → duplicate success
 *      reporting the current watermark.
 *   4. Otherwise persist the suffix with the first-edge watermark gate
 *      (transactional INSERT + UPDATE below), then fold the suffix into the
 *      compact metrics state.
 *
 * An overlapping batch whose suffix is empty is a duplicate; a batch whose
 * first seq exceeds watermark+1 has a gap but is still accepted — clients
 * may legitimately skip events (kind gating client-side) and the seq stream
 * is an ordering guarantee, not a completeness one.
 */
export async function ingestTelemetryBatch(
  db: D1Database,
  sessionId: string,
  events: ValidatedEvent[]
): Promise<IngestOutcome> {
  if (events.length === 0) {
    const wm = await readWatermark(db, sessionId);
    return { kind: "accepted", stored: [], acceptedThrough: wm, duplicate: true };
  }

  const watermark = await readWatermark(db, sessionId);
  // Strip everything the server already stores. Events are seq-sorted and
  // strictly increasing (validated), so a simple first-seq comparison
  // identifies the accepted prefix.
  const suffix = events.filter((e) => e.seq > watermark);
  if (suffix.length === 0) {
    // Fully-stored batch: exact replay, idempotent success.
    return { kind: "accepted", stored: [], acceptedThrough: watermark, duplicate: true };
  }

  const persisted = await persistEventSuffix(db, sessionId, suffix);
  if (persisted === "TOO_LARGE") return { kind: "too_large" };
  if (persisted === "CONFLICT") {
    // Lost a race with a concurrent batch covering this range — report the
    // authoritative watermark so the client can trim exactly.
    return { kind: "conflict", acceptedThrough: await readWatermark(db, sessionId) };
  }
  if (persisted === "FAILED") return { kind: "failed" };

  // Fold the SAME suffix into the compact metrics state (production only;
  // callers gate this behind isLabMode — the raw rows must stay intact for
  // research replay).
  return {
    kind: "accepted",
    stored: suffix,
    acceptedThrough: suffix[suffix.length - 1].seq,
    duplicate: false,
  };
}

type PersistResult = "OK" | "TOO_LARGE" | "CONFLICT" | "FAILED";

/**
 * Persist a never-stored suffix of events with the first-edge watermark
 * gate (FR-R6-032/033 semantics retained). Single D1 batch (transactional):
 *   1. INSERT ... WHERE COALESCE((SELECT last_event_seq ...), -1) < ?first
 *   2. UPDATE sessions SET last_event_seq = ?last, last_seen_at = now
 *      WHERE COALESCE(last_event_seq, -1) < ?first
 *
 * If statement 2 changes 0 rows, a concurrent batch won — nothing was
 * committed (statement 1 shares the identical pre-update predicate).
 * A unique-violation on idx_event_batches_identity means an exact replay
 * raced through the prefix strip → treated as CONFLICT (benign; the other
 * writer won and the data is stored).
 */
async function persistEventSuffix(
  db: D1Database,
  sessionId: string,
  events: ValidatedEvent[]
): Promise<PersistResult> {
  const payload = JSON.stringify(events);
  if (payloadByteLength(payload) > MAX_EVENT_PAYLOAD_BYTES) {
    return "TOO_LARGE";
  }

  const firstSeq = events[0].seq;
  const lastSeq = events[events.length - 1].seq;
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
    const msg = err instanceof Error ? err.message : String(err);
    if (/UNIQUE\s+constraint\s+failed.*idx_event_batches_identity|constraint\s+failed.*event_batches/i.test(msg)) {
      // The concurrent writer stored this exact range first. Not an error:
      // report conflict with the authoritative watermark.
      return "CONFLICT";
    }
    return "FAILED";
  }

  const watermark = results[1] ?? {};
  if ((watermark.meta?.changes ?? 0) !== 1) {
    return "CONFLICT";
  }
  return "OK";
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

  const outcome = await ingestTelemetryBatch(env.DB, sessionId, validated.events);

  switch (outcome.kind) {
    case "too_large":
      return error("payload too large", 413);
    case "failed":
      return error("failed to persist events", 500);
    case "conflict":
      // FR-P0-2: a watermark conflict is NOT a drop-everything signal — the
      // response carries the authoritative acceptedThrough so the client
      // trims exactly the stored prefix and retries the remainder.
      return json({ received: 0, duplicate: true, acceptedThrough: outcome.acceptedThrough });
    case "accepted": {
      // FR-P0-6: fold the newly-stored suffix into the compact metrics row
      // using the PROFILE's actual capture mask (not assumed true/true).
      // Production only — lab needs the raw rows and nothing else.
      if (!isLabMode(env) && outcome.stored.length > 0) {
        try {
          const capture = await resolveCaptureMask(env, session);
          await mergeSessionMetrics(env.DB, sessionId, outcome.stored, capture);
        } catch (mergeErr) {
          // Metrics merge is best-effort; never block an event batch.
          console.warn("session_metrics merge failed:", mergeErr);
        }
      }
      return json({
        received: outcome.stored.length,
        duplicate: outcome.duplicate,
        acceptedThrough: outcome.acceptedThrough,
      });
    }
  }
}

/**
 * FR-P0-6: resolve the capture mask from the session's ISSUED PROFILE, not
 * from page-config assumptions. The profile was randomized per session —
 * capturePointer/captureKey are treatment variables, and scoring a user as
 * noPointerEvents because the profile disabled pointer capture is a false
 * positive by construction.
 *
 * Reconstruction is the same canonical path submit uses (reconstructIssued
 * Profile honors the persisted profile_key_id); on failure the mask is
 * treated as unknown → both channels enabled=false → metrics stay NULL
 * (never scored) rather than assumed-on.
 */
async function resolveCaptureMask(
  env: Env,
  session: { profileVersion: number; profileKeyId: string | null; labModeHoldout?: boolean }
): Promise<{ capturePointer: boolean; captureKey: boolean }> {
  try {
    const { reconstructIssuedProfile } = await import("../core/reconstruct.js");
    const reconstructed = await reconstructIssuedProfile(env, {
      id: "", // unused by derivation; derivation keys on profileVersion/keyId
      profileVersion: session.profileVersion,
      profileKeyId: session.profileKeyId,
    });
    if (reconstructed.ok) {
      return {
        capturePointer: reconstructed.profile.telemetry.capturePointer,
        captureKey: reconstructed.profile.telemetry.captureKey,
      };
    }
  } catch (err) {
    console.warn("capture-mask reconstruction failed:", err instanceof Error ? err.message : err);
  }
  // Unknown profile → treat capture as OFF for both channels: metrics become
  // NULL (unknown), never false-positive.
  return { capturePointer: false, captureKey: false };
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
