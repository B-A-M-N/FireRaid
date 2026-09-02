/**
 * D1 implementation of the review queue + calibration log.
 */

import type { ReviewQueueEntry } from "../core/review.js";
import type { CalibrationRecord } from "../eval/review-workflow.js";

export interface ReviewQueueFilters {
  status?: "pending" | "reviewed";
  tier?: string;
  limit?: number;
  offset?: number;
}

export class D1ReviewStore {
  constructor(private db: D1Database) {}

  async createEntry(entry: ReviewQueueEntry): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO review_queue (session_id, public_id, created_at, risk_score, risk_tier, disposition, policy, reasons_json, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (session_id) DO UPDATE SET
           public_id = excluded.public_id,
           created_at = excluded.created_at,
           risk_score = excluded.risk_score,
           risk_tier = excluded.risk_tier,
           disposition = excluded.disposition,
           policy = excluded.policy,
           reasons_json = excluded.reasons_json,
           status = excluded.status
         WHERE review_queue.status = 'pending'`
      )
      .bind(
        entry.sessionId,
        entry.publicId,
        entry.createdAt,
        entry.riskScore,
        entry.riskTier,
        entry.disposition,
        entry.policy,
        JSON.stringify(entry.reasons),
        entry.status
      )
      .run();
  }

  async getBySession(sessionId: string): Promise<ReviewQueueEntry | null> {
    const row = await this.db
      .prepare(`SELECT * FROM review_queue WHERE session_id = ?`)
      .bind(sessionId)
      .first<{
        session_id: string;
        public_id: string;
        created_at: number;
        risk_score: number;
        risk_tier: string;
        disposition: string;
        policy: string;
        reasons_json: string;
        status: string;
        reviewer_decision: string | null;
        reviewer_note: string | null;
        reviewed_at: number | null;
        reviewed_by: string | null;
      }>();
    if (!row) return null;
    return this.mapRow(row);
  }

  async list(filters: ReviewQueueFilters = {}): Promise<ReviewQueueEntry[]> {
    const parts: string[] = [];
    const params: (string | number)[] = [];
    if (filters.status) {
      parts.push("status = ?");
      params.push(filters.status);
    }
    if (filters.tier) {
      parts.push("risk_tier = ?");
      params.push(filters.tier);
    }
    let sql = "SELECT * FROM review_queue";
    if (parts.length > 0) sql += " WHERE " + parts.join(" AND ");
    sql += " ORDER BY created_at DESC";
    const limit = Math.max(1, Math.min(filters.limit ?? 50, 200));
    const offset = Math.max(0, filters.offset ?? 0);
    sql += " LIMIT ? OFFSET ?";
    params.push(limit, offset);
    const rows = await this.db.prepare(sql).bind(...params).all<{
      session_id: string;
      public_id: string;
      created_at: number;
      risk_score: number;
      risk_tier: string;
      disposition: string;
      policy: string;
      reasons_json: string;
      status: string;
      reviewer_decision: string | null;
      reviewer_note: string | null;
      reviewed_at: number | null;
      reviewed_by: string | null;
    }>();
    return rows.results.map((r) => this.mapRow(r));
  }

  async updateEntry(entry: ReviewQueueEntry): Promise<number> {
    const res = await this.db
      .prepare(
        `UPDATE review_queue
         SET status = ?, reviewer_decision = ?, reviewer_note = ?, reviewed_at = ?, reviewed_by = ?
         WHERE session_id = ? AND status = 'pending'`
      )
      .bind(
        entry.status,
        entry.reviewerDecision ?? null,
        entry.reviewerNote ?? null,
        entry.reviewedAt ?? null,
        entry.reviewedBy ?? null,
        entry.sessionId
      )
      .run();
    // Row-guard semantics: 0 = a concurrent reviewer already finalized the
    // entry (the caller reports the conflict; no calibration is recorded).
    return res.meta?.changes ?? 0;
  }

  async recordCalibration(record: CalibrationRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO review_calibration
           (session_id, public_id, risk_score, risk_tier, fireraid_disposition, reviewer_decision, agreed, reviewed_at, reviewer_id, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        record.sessionId,
        record.publicId,
        record.riskScore,
        record.riskTier,
        record.fireraidDisposition,
        record.reviewerDecision,
        record.agreed ? 1 : 0,
        record.reviewedAt,
        record.reviewerId ?? null,
        record.note ?? null
      )
      .run();
  }

  async calibrationStats(): Promise<{
    total: number;
    agreed: number;
    disagreed: number;
    byTier: Record<string, { total: number; agreed: number }>;
  }> {
    const rows = await this.db
      .prepare(
        `SELECT risk_tier, agreed, COUNT(*) AS cnt FROM review_calibration GROUP BY risk_tier, agreed`
      )
      .all<{ risk_tier: string; agreed: number; cnt: number }>();
    const byTier: Record<string, { total: number; agreed: number }> = {};
    let total = 0;
    let agreed = 0;
    for (const r of rows.results ?? []) {
      byTier[r.risk_tier] ??= { total: 0, agreed: 0 };
      byTier[r.risk_tier].total += r.cnt;
      if (r.agreed === 1) {
        byTier[r.risk_tier].agreed += r.cnt;
        agreed += r.cnt;
      }
      total += r.cnt;
    }
    return { total, agreed, disagreed: total - agreed, byTier };
  }

  private mapRow(row: {
    session_id: string;
    public_id: string;
    created_at: number;
    risk_score: number;
    risk_tier: string;
    disposition: string;
    policy: string;
    reasons_json: string;
    status: string;
    reviewer_decision: string | null;
    reviewer_note: string | null;
    reviewed_at: number | null;
    reviewed_by: string | null;
  }): ReviewQueueEntry {
    return {
      sessionId: row.session_id,
      publicId: row.public_id,
      createdAt: row.created_at,
      riskScore: row.risk_score,
      riskTier: row.risk_tier,
      disposition: row.disposition,
      policy: row.policy,
      reasons: JSON.parse(row.reasons_json || "[]"),
      status: row.status as ReviewQueueEntry["status"],
      reviewerDecision: (row.reviewer_decision as ReviewQueueEntry["reviewerDecision"]) ?? undefined,
      reviewerNote: row.reviewer_note ?? undefined,
      reviewedAt: row.reviewed_at ?? undefined,
      reviewedBy: row.reviewed_by ?? undefined,
    };
  }
}
