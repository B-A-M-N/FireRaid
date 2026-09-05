/**
 * Review decision WRITE — evaluation control plane, intentionally isolated.
 *
 * FR-P1-05: this module is the ONLY home of the reviewer-decision write. It
 * imports src/eval/review-workflow.ts, so it is never in the production
 * Worker's import graph (src/worker-production.ts never references it). The
 * label-owning admin module (admin.ts) is eval-free, so the entire eval
 * control plane ships only in the lab/evaluation Worker (src/index.ts).
 *
 * The runtime LAB_MODE guard remains as defense-in-depth; the stronger
 * property is that the handler does not exist in the production artifact at
 * all.
 */
import { json, error } from "../security/headers.js";
import { readJsonBody } from "../security/body-limits.js";
import { requireAdminMutation } from "../security/admin-auth.js";
import { finalizeReview } from "../eval/review-workflow.js";
import { D1ReviewStore } from "../cloudflare/review-store.js";
import type { Env } from "../env.js";

export async function adminReviewDecision(req: Request, env: Env): Promise<Response> {
  // EVALUATION-ONLY GUARD: reviewer decisions are not writable in production.
  if (env.LAB_MODE !== "true") {
    return error("not found", 404);
  }

  // FR-P1-06: a reviewer decision is a state mutation — gate it the same way
  // as cleanup. Bearer callers pass with the token alone; cookie callers need
  // same-site origin + the CSRF double-submit header.
  if (!(await requireAdminMutation(req, env))) return error("unauthorized", 401);
  if (req.method !== "POST") return error("method not allowed", 405);

  // FR-P1-02 closure: bounded streaming read — reviewer notes are small;
  // never buffer an arbitrary body before auth'd schema checks.
  const MAX_REVIEW_BODY_BYTES = 16_384;
  const bodyRead = await readJsonBody(req, MAX_REVIEW_BODY_BYTES);
  if (!bodyRead.ok) {
    return error(
      bodyRead.reason === "OVERSIZE" ? "payload too large" : "invalid JSON",
      bodyRead.reason === "OVERSIZE" ? 413 : 400
    );
  }
  const body = bodyRead.data as { sessionId: string; decision: string; reviewerId?: string; note?: string };

  if (!body.sessionId || !body.decision) {
    return error("missing sessionId or decision", 400);
  }
  if (body.decision !== "approved" && body.decision !== "rejected") {
    return error("decision must be 'approved' or 'rejected'", 400);
  }

  const store = new D1ReviewStore(env.DB);
  const entry = await store.getBySession(body.sessionId);
  if (!entry) return error("not found", 404);

  const { entry: updated, calibration } = finalizeReview(
    entry,
    body.decision as "approved" | "rejected",
    { reviewerId: body.reviewerId, note: body.note }
  );

  const updatedRows = await store.updateEntry(updated);
  if (updatedRows === 0) {
    // Concurrent decision: entry was already finalized by another reviewer.
    return error("already decided", 409);
  }

  // Only record calibration when this is the first (winning) decision.
  await store.recordCalibration(calibration);

  return json({ ok: true, reviewedBy: body.reviewerId ?? "anonymous" });
}