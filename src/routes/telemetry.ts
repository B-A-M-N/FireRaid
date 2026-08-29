/**
 * POST /api/events — telemetry batch ingestion.
 * FR-INV: buffer client-side, flush to D1 in batches. No sensitive data.
 * FIX: Validate telemetry meta (FR-R2-033).
 */
import { json, error } from "../security/headers.js";
import type { Env } from "../env.js";
import {
  getSessionId,
  loadSession,
  isExpired,
  now,
  touchSession,
} from "../core/session.js";
import {
  ALLOWED_EVENT_TYPES,
  MAX_EVENTS_PER_BATCH,
  MAX_EVENT_PAYLOAD_BYTES,
} from "../types/telemetry.js";

interface EventsBody {
  events?: unknown;
}

/**
 * Validate a telemetry batch. Shared between /api/events and /api/submit.
 */
export function validateTelemetryBatch(events: unknown): Array<{ seq: number; dt: number; kind: string; target?: string; meta?: { synthetic?: boolean; inputType?: string } }> {
  if (!Array.isArray(events)) return [];
  
  const valid: Array<{ seq: number; dt: number; kind: string; target?: string; meta?: { synthetic?: boolean; inputType?: string } }> = [];
  
  for (const raw of events) {
    if (typeof raw !== "object" || raw === null) continue;
    const e = raw as Record<string, unknown>;
    if (typeof e.kind !== "string" || !ALLOWED_EVENT_TYPES.has(e.kind)) continue;
    if (typeof e.seq !== "number" || !Number.isFinite(e.seq) || e.seq < 0) continue;
    if (typeof e.dt !== "number" || !Number.isFinite(e.dt) || e.dt < 0) continue;
    
    // Validate meta
    let meta: { synthetic?: boolean; inputType?: string } | undefined;
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
  }
  
  return valid;
}

export async function events(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return error("method not allowed", 405);

  const sessionId = getSessionId(req);
  if (!sessionId) return error("no session", 403);
  const session = await loadSession(env.DB, sessionId);
  if (!session) return error("invalid session", 403);
  if (isExpired(session.createdAt)) return error("session expired", 403);

  let body: EventsBody;
  try {
    body = (await req.json()) as EventsBody;
  } catch {
    return error("invalid JSON", 400);
  }

  if (!body.events || !Array.isArray(body.events)) {
    return error("missing events array", 400);
  }

  if (body.events.length > MAX_EVENTS_PER_BATCH) {
    return error(`batch exceeds max ${MAX_EVENTS_PER_BATCH} events`, 413);
  }

  // Validate events
  const valid = validateTelemetryBatch(body.events);

  // Persist batch
  if (valid.length > 0) {
    try {
      const payload = JSON.stringify(valid);
      if (payload.length > MAX_EVENT_PAYLOAD_BYTES) {
        return error("payload too large", 413);
      }
      await env.DB.prepare(
        `INSERT INTO event_batches (session_id, created_at, first_seq, last_seq, event_count, payload_json)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
        .bind(
          sessionId,
          now(),
          valid[0].seq,
          valid[valid.length - 1].seq,
          valid.length,
          payload
        )
        .run();
      await touchSession(env.DB, sessionId);
    } catch (err) {
      return error("failed to persist events", 500);
    }
  }

  return json({ received: valid.length });
}
