/**
 * Unit tests for telemetry integrity fixes.
 *
 * Coverage:
 * - validateTelemetryBatch: batch-size rejection, invalid-kind dropping,
 *   seq strictly-increasing, dt nondecreasing (FR-R4-015).
 * - aggregateTelemetry: per-field focus tracking (FR-R4-013),
 *   completionMs from first meaningful interaction (FR-R4-014),
 *   capture-aware noPointerEvents (FR-R4-012).
 * - Watermark behavior can't be tested without D1 — skipped.
 */
import { describe, it, expect } from "vitest";
import { validateTelemetryBatch } from "../../src/routes/telemetry.js";
import { aggregateTelemetry } from "../../src/telemetry/aggregate.js";
import type { ValidatedEvent } from "../../src/routes/telemetry.js";

// ── Helpers ──────────────────────────────────────────────────────────

function mkEvent(
  seq: number,
  dt: number,
  kind: string,
  target?: string,
  meta?: ValidatedEvent["meta"]
): ValidatedEvent {
  return { seq, dt, kind, target, meta };
}

// ── validateTelemetryBatch (FR-R4-015) ──────────────────────────────

describe("validateTelemetryBatch (FR-R4-015)", () => {
  it("64 valid events → {ok:true}", () => {
    const events: unknown[] = [];
    for (let i = 1; i <= 64; i++) {
      events.push({ seq: i, dt: i * 100, kind: "focus", target: `f${i}` });
    }
    const result = validateTelemetryBatch(events);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.events.length).toBe(64);
  });

  it("65 events → {ok:false, code:'TOO_MANY_EVENTS'}", () => {
    const events: unknown[] = [];
    for (let i = 1; i <= 65; i++) {
      events.push({ seq: i, dt: i * 100, kind: "focus", target: `f${i}` });
    }
    const result = validateTelemetryBatch(events);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("TOO_MANY_EVENTS");
  });

  it("invalid kind → whole batch rejected (FR-R6-035, no silent drop)", () => {
    const events: unknown[] = [
      { seq: 1, dt: 100, kind: "focus", target: "a" },
      { seq: 2, dt: 200, kind: "bogus_kind", target: "b" },
      { seq: 3, dt: 300, kind: "input", target: "c" },
    ];
    const result = validateTelemetryBatch(events);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("MALFORMED_EVENT");
  });

  it("seq not strictly-increasing → whole batch rejected (FR-R6-035)", () => {
    const events: unknown[] = [
      { seq: 3, dt: 300, kind: "focus", target: "a" },
      { seq: 1, dt: 100, kind: "focus", target: "b" }, // seq not increasing
      { seq: 2, dt: 200, kind: "focus", target: "c" }, // seq not increasing
    ];
    const result = validateTelemetryBatch(events);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SEQ_ORDER_VIOLATION");
  });

  it("dt not nondecreasing → whole batch rejected (FR-R6-035)", () => {
    const events: unknown[] = [
      { seq: 1, dt: 300, kind: "focus", target: "a" },
      { seq: 2, dt: 100, kind: "focus", target: "b" }, // dt decreases
      { seq: 3, dt: 200, kind: "focus", target: "c" }, // dt decreases
    ];
    const result = validateTelemetryBatch(events);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SEQ_ORDER_VIOLATION");
  });

  it("fractional seq → rejected (FR-R6-034 safe integers)", () => {
    const result = validateTelemetryBatch([{ seq: 1.5, dt: 100, kind: "focus" }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("MALFORMED_EVENT");
  });

  it("empty array → {ok:true, events:[]}", () => {
    const result = validateTelemetryBatch([]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.events).toEqual([]);
  });

  it("null input → rejected NOT_AN_ARRAY (FR-R6-035)", () => {
    const result = validateTelemetryBatch(null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("NOT_AN_ARRAY");
  });
});

// ── aggregateTelemetry — per-field focus (FR-R4-013) ────────────────

describe("aggregateTelemetry — per-field focus (FR-R4-013)", () => {
  it("focus(name) → input(name) → directFill false", () => {
    const events = [
      mkEvent(1, 100, "focus", "name"),
      mkEvent(2, 200, "input", "name"),
    ];
    const metrics = aggregateTelemetry(events);
    expect(metrics.directFill).toBe(false);
  });

  it("focus(name) → blur(name) → input(name) → directFill true", () => {
    const events = [
      mkEvent(1, 100, "focus", "name"),
      mkEvent(2, 200, "blur", "name"),
      mkEvent(3, 300, "input", "name"),
    ];
    const metrics = aggregateTelemetry(events);
    expect(metrics.directFill).toBe(true);
  });

  it("input(email) while name focused → directFill true (target not focused)", () => {
    const events = [
      mkEvent(1, 100, "focus", "name"),
      mkEvent(2, 200, "input", "email"),
    ];
    const metrics = aggregateTelemetry(events);
    expect(metrics.directFill).toBe(true);
  });

  it("focus→input(name)→input(email) → directFill true (second target never focused)", () => {
    const events = [
      mkEvent(1, 100, "focus", "name"),
      mkEvent(2, 200, "input", "name"),
      mkEvent(3, 300, "input", "email"),
    ];
    const metrics = aggregateTelemetry(events);
    expect(metrics.directFill).toBe(true);
  });

  it("focus→blur→focus→input → directFill false", () => {
    const events = [
      mkEvent(1, 100, "focus", "name"),
      mkEvent(2, 200, "blur", "name"),
      mkEvent(3, 300, "focus", "name"),
      mkEvent(4, 400, "input", "name"),
    ];
    const metrics = aggregateTelemetry(events);
    expect(metrics.directFill).toBe(false);
  });

  it("input with no target while focus set empty → directFill true", () => {
    const events = [
      mkEvent(1, 100, "focus", "name"),
      mkEvent(2, 200, "blur", "name"),
      mkEvent(3, 300, "input"), // no target, focused set is empty
    ];
    const metrics = aggregateTelemetry(events);
    expect(metrics.directFill).toBe(true);
  });

  it("input with no target while focus set non-empty → directFill false", () => {
    const events = [
      mkEvent(1, 100, "focus", "name"),
      mkEvent(2, 200, "input"), // no target, but name is focused
    ];
    const metrics = aggregateTelemetry(events);
    expect(metrics.directFill).toBe(false);
  });

  it("blur without target is ignored for tracking", () => {
    const events = [
      mkEvent(1, 100, "focus", "name"),
      mkEvent(2, 200, "blur"), // no target — shouldn't affect tracking
      mkEvent(3, 300, "input", "name"),
    ];
    const metrics = aggregateTelemetry(events);
    expect(metrics.directFill).toBe(false);
  });

  it("focus without target is ignored for tracking", () => {
    const events = [
      mkEvent(1, 100, "focus"), // no target — doesn't add to set
      mkEvent(2, 200, "input", "email"), // email never focused
    ];
    const metrics = aggregateTelemetry(events);
    expect(metrics.directFill).toBe(true);
  });
});

// ── aggregateTelemetry — completion time (FR-R4-014) ────────────────

describe("aggregateTelemetry — completion time (FR-R4-014)", () => {
  it("page_ready dt0, focus dt500, submit dt2000 → completionMs=1500, pageToSubmitMs=2000", () => {
    const events = [
      mkEvent(1, 0, "page_ready"),
      mkEvent(2, 500, "focus", "name"),
      mkEvent(3, 2000, "submit_attempt"),
    ];
    const metrics = aggregateTelemetry(events);
    expect(metrics.completionMs).toBe(1500); // 2000 - 500
    expect(metrics.pageToSubmitMs).toBe(2000); // 2000 - 0
  });

  it("only page_ready events → completionMs=0, pageToSubmitMs > 0", () => {
    const events = [
      mkEvent(1, 0, "page_ready"),
      mkEvent(2, 5000, "page_ready"),
    ];
    const metrics = aggregateTelemetry(events);
    expect(metrics.completionMs).toBe(0);
    expect(metrics.pageToSubmitMs).toBe(5000);
  });

  it("input only, no submit → completionMs=0", () => {
    const events = [
      mkEvent(1, 0, "page_ready"),
      mkEvent(2, 100, "input", "email"),
    ];
    const metrics = aggregateTelemetry(events);
    expect(metrics.completionMs).toBe(0);
  });

  it("change event counts as meaningful interaction", () => {
    const events = [
      mkEvent(1, 0, "page_ready"),
      mkEvent(2, 300, "change", "select"),
      mkEvent(3, 1200, "submit_attempt"),
    ];
    const metrics = aggregateTelemetry(events);
    expect(metrics.completionMs).toBe(900); // 1200 - 300
  });
});

// ── aggregateTelemetry — capture-aware (FR-R4-012) ──────────────────

describe("aggregateTelemetry — capture-aware (FR-R4-012)", () => {
  function eventsWithPointerCount(count: number): ValidatedEvent[] {
    return Array.from({ length: count }, (_, i) =>
      mkEvent(i + 1, 100 + i, "pointer")
    );
  }

  function eventsWithKeyCount(count: number): ValidatedEvent[] {
    return Array.from({ length: count }, (_, i) =>
      mkEvent(i + 1, 100 + i, "key")
    );
  }

  it("capturePointer:false + zero pointer events → noPointerEvents=undefined", () => {
    const events: ValidatedEvent[] = [];
    const metrics = aggregateTelemetry(events, { capturePointer: false });
    expect(metrics.noPointerEvents).toBeUndefined();
  });

  it("capturePointer:true + zero pointer events → noPointerEvents=true", () => {
    const events: ValidatedEvent[] = [];
    const metrics = aggregateTelemetry(events, { capturePointer: true });
    expect(metrics.noPointerEvents).toBe(true);
  });

  it("capturePointer:true + pointer events → noPointerEvents=false", () => {
    const events = eventsWithPointerCount(5);
    const metrics = aggregateTelemetry(events, { capturePointer: true });
    expect(metrics.noPointerEvents).toBe(false);
  });

  it("captureKey:false → noKeyEvents=undefined", () => {
    const events: ValidatedEvent[] = [];
    const metrics = aggregateTelemetry(events, { captureKey: false });
    expect(metrics.noKeyEvents).toBeUndefined();
  });

  it("captureKey:true + key events → noKeyEvents=false", () => {
    const events = eventsWithKeyCount(4);
    const metrics = aggregateTelemetry(events, { captureKey: true });
    expect(metrics.noKeyEvents).toBe(false);
  });

  it("captureKey:true + zero keys → noKeyEvents=true", () => {
    const events: ValidatedEvent[] = [];
    const metrics = aggregateTelemetry(events, { captureKey: true });
    expect(metrics.noKeyEvents).toBe(true);
  });

  it("missingInteractionSequence when both channels captured and both zero", () => {
    const events: ValidatedEvent[] = [];
    const metrics = aggregateTelemetry(events, { capturePointer: true, captureKey: true });
    expect(metrics.missingInteractionSequence).toBe(true);
  });

  it("missingInteractionSequence undefined when capture off", () => {
    const events: ValidatedEvent[] = [];
    const metrics = aggregateTelemetry(events, { capturePointer: false });
    expect(metrics.missingInteractionSequence).toBeUndefined();
  });

  it("missingInteractionSequence false when pointer events present", () => {
    const events = eventsWithPointerCount(3);
    const metrics = aggregateTelemetry(events);
    expect(metrics.missingInteractionSequence).toBe(false);
  });

  it("capturePointer field reflects config", () => {
    const metrics1 = aggregateTelemetry([], { capturePointer: false });
    expect(metrics1.capturePointer).toBe(false);
    const metrics2 = aggregateTelemetry([], { capturePointer: true });
    expect(metrics2.capturePointer).toBe(true);
  });

  it("captureKey field reflects config", () => {
    const metrics1 = aggregateTelemetry([], { captureKey: false });
    expect(metrics1.captureKey).toBe(false);
    const metrics2 = aggregateTelemetry([], { captureKey: true });
    expect(metrics2.captureKey).toBe(true);
  });
});

// ── aggregateTelemetry — default capture (backward compat) ──────────

describe("aggregateTelemetry — default capture (backward compat)", () => {
  it("no capture arg → defaults to both true (preserves old behavior)", () => {
    const events: ValidatedEvent[] = [];
    const metrics = aggregateTelemetry(events);
    expect(metrics.noPointerEvents).toBe(true);
    expect(metrics.noKeyEvents).toBe(true);
    expect(metrics.capturePointer).toBe(true);
    expect(metrics.captureKey).toBe(true);
    expect(metrics.missingInteractionSequence).toBe(true);
  });

  it("empty events → directFill false, no pointer events", () => {
    const metrics = aggregateTelemetry([]);
    expect(metrics.directFill).toBe(false);
    expect(metrics.pointerCount).toBe(0);
    expect(metrics.focusTransitions).toBe(0);
    expect(metrics.completionMs).toBe(0);
    expect(metrics.pageToSubmitMs).toBe(0);
  });
});

// ── payloadByteLength (FR-R5-020) ────────────────────────────────────

import { payloadByteLength } from "../../src/routes/telemetry.js";

describe("payloadByteLength (FR-R5-020)", () => {
  it("ASCII string → byteLength equals charLength", () => {
    expect(payloadByteLength("hello")).toBe(5);
    expect(payloadByteLength("")).toBe(0);
    expect(payloadByteLength("abc def")).toBe(7);
  });

  it("multi-byte CJK characters → correct UTF-8 byte count", () => {
    // 日本語 = 3 chars, each 3 bytes in UTF-8
    expect(payloadByteLength("日本語")).toBe(9);
  });

  it("emoji → correct UTF-8 byte count (4 bytes each)", () => {
    // 😀 is 4 bytes in UTF-8
    expect(payloadByteLength("😀")).toBe(4);
    expect(payloadByteLength("😀😀")).toBe(8);
  });

  it("mixed ASCII and multi-byte", () => {
    // "a" (1) + "日" (3) + "b" (1) + "本" (3) + "c" (1) = 9
    expect(payloadByteLength("a日b本c")).toBe(9);
  });
});

// ── persistTelemetryBatch watermark semantics (FR-R5-018) ────────────

import { persistTelemetryBatch } from "../../src/routes/telemetry.js";

describe("persistTelemetryBatch — watermark semantics (FR-R5-018)", () => {
  // Mock D1 that captures batch() calls and returns configurable results
  function makeMockDB(stmts: { meta: { changes: number } }[]) {
    return {
      prepare(_sql: string) {
        return {
          bind(..._args: unknown[]) {
            return this;
          },
        };
      },
      async batch(_stmts: unknown[]) {
        const results = stmts.map((s, i) => {
          if (i < stmts.length) return s;
          return { meta: { changes: 0 } };
        });
        // D1 batch returns array of results in order
        return results as unknown[];
      },
    } as unknown as D1Database;
  }

  it("both statements succeed (changes:1, changes:1) → resolves with lastSeq", async () => {
    const mockDb = makeMockDB([
      { meta: { changes: 1 } },
      { meta: { changes: 1 } },
    ]);
    const testEvents: ValidatedEvent[] = [
      { seq: 1, dt: 100, kind: "focus" },
      { seq: 5, dt: 500, kind: "input" },
    ];
    const lastSeq = await persistTelemetryBatch(mockDb as D1Database, "test-session", testEvents);
    expect(lastSeq).toBe(5);
  });

  it("empty events → resolves with 0", async () => {
    const mockDb = makeMockDB([{ meta: { changes: 0 } }, { meta: { changes: 0 } }]);
    const lastSeq = await persistTelemetryBatch(mockDb as D1Database, "test-session", []);
    expect(lastSeq).toBe(0);
  });

  it("first statement changes === 0 → throws SEQ_WATERMARK_VIOLATION", async () => {
    const mockDb = makeMockDB([
      { meta: { changes: 0 } },
      { meta: { changes: 0 } },
    ]);
    const testEvents: ValidatedEvent[] = [{ seq: 1, dt: 100, kind: "focus" }];
    await expect(
      persistTelemetryBatch(mockDb as D1Database, "test-session", testEvents)
    ).rejects.toThrow("SEQ_WATERMARK_VIOLATION");
  });

  it("PAYLOAD_TOO_LARGE error for oversized payload", async () => {
    // Build a payload that exceeds 16KB — use events with large targets
    const largeTarget = "x".repeat(300); // each event ~350 bytes of JSON
    const tooManyEvents: ValidatedEvent[] = Array.from({ length: 65 }, (_, i) => ({
      seq: i + 1,
      dt: (i + 1) * 100,
      kind: "focus",
      target: largeTarget,
    }));
    // 65 events would be rejected by validateTelemetryBatch (TOO_MANY_EVENTS),
    // but we pass already-validated events directly to persistTelemetryBatch.
    // 65 events * ~350 bytes ≈ 22.75KB > 16KB — should trigger PAYLOAD_TOO_LARGE.
    const mockDbOversize = makeMockDB([
      { meta: { changes: 1 } },
      { meta: { changes: 1 } },
    ]);
    await expect(
      persistTelemetryBatch(mockDbOversize as D1Database, "test-session", tooManyEvents)
    ).rejects.toThrow("PAYLOAD_TOO_LARGE");
  });
});
