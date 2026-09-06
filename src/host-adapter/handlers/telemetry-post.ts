/**
 * POST /telemetry ingest handler (extracted from middleware.ts).
 */
import { readJsonBody } from "../../security/body-limits.js";
import { MAX_HOST_JSON_BYTES } from "../../types/telemetry.js";
import type { MiddlewareDeps, MiddlewareResult } from "../middleware-types.js";
import { DeadlineSignal, DeadlineError } from "../deadline.js";
import { reportOperationalError } from "../lifecycle/store-finalization.js";

export async function handleIngestPost(
  req: Request,
  deps: MiddlewareDeps,
  deadline: DeadlineSignal
): Promise<MiddlewareResult> {
  const session = await deadline.run(deps.session.resolveSession(req, deadline.signal));
  const sessionId = session?.id ?? null;
  if (!sessionId) return { kind: "deny", disposition: "NO_SESSION" };

  let ingestBody: { events?: unknown };
  {
    // P1-8 / FR-P1-02: bounded STREAMING JSON reader — counts bytes as they
    // arrive and cancels mid-body on oversize. FR-RR-09: the body-level
    // failure reason is preserved with its HTTP semantics (OVERSIZE → 413,
    // MISSING/BAD → 400) — a too-large batch is not the server's fault, and
    // these are transport facts, not admission denials.
    const read = await readJsonBody(req, MAX_HOST_JSON_BYTES);
    if (!read.ok) {
      return {
        kind: "deny",
        disposition: read.reason === "MISSING" ? "MISSING_BODY" : "BAD_JSON",
        ...(read.reason === "OVERSIZE" ? { httpStatus: 413 as const } : { httpStatus: 400 as const }),
      };
    }
    ingestBody = read.data as { events?: unknown };
  }
  // FR-P1-11: a telemetry/store adapter that exceeds the deadline (or throws)
  // is FireRaid/host infrastructure failing — an operational error, fail-closed,
  // never an applicant-facing deny and never an unhandled hang.
  let ingest;
  try {
    ingest = await deadline.run(deps.telemetry.accept(sessionId, ingestBody.events ?? [], deadline.signal));
  } catch (err) {
    reportOperationalError(deps, "telemetry.accept", err);
    return { kind: "error", operationalReason: err instanceof DeadlineError ? "INGEST_ADAPTER_DEADLINE" : "INGEST_ADAPTER_FAILED" };
  }
  if (ingest.kind === "invalid") {
    try {
      await deadline.run(deps.enforcement.deny(sessionId, "INVALID_TELEMETRY", undefined, deadline.signal));
    } catch (err) {
      reportOperationalError(deps, "enforcement.deny(invalid-telemetry)", err);
      return { kind: "error", operationalReason: "INGEST_DENY_FAILED" };
    }
    return { kind: "deny", disposition: "INVALID_TELEMETRY" };
  }
  if (ingest.kind === "conflict") {
    return {
      kind: "ingest",
      acceptedThrough: ingest.acceptedThrough,
      received: 0,
    };
  }
  return {
    kind: "ingest",
    acceptedThrough: ingest.acceptedThrough,
    received: ingest.received,
  };
}
