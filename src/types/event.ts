/**
 * Evidence taxonomy (FR-INV-004, FR-INV-005).
 * Three classes: causal (A), strong behavioral (B), weak heuristic (C).
 */
export type EvidenceClass = "A" | "B" | "C";

export type Disposition =
  | "ACCEPT"
  | "REVIEW"
  | "QUARANTINE"
  | "REJECT_TURNSTILE"
  | "INVALID_SESSION";

export interface Evidence {
  id: string;
  class: EvidenceClass;
  weight: number;
  source: string;
  verified: boolean;
  metadata?: Record<string, unknown>;
}

export interface DecisionRecord {
  policy: string;
  signals: Evidence[];
  score: number;
  disposition: Disposition;
  reasons: string[];
  createdAt: number;
}

export type AgentOutcome =
  | "submitted"
  | "stopped"
  | "handoff"
  | "timeout"
  | "error";

export type RunStatus =
  | "PENDING"
  | "RUNNING"
  | "COMPLETE"
  | "ERROR"
  | "TIMEOUT";
