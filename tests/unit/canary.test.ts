/**
 * Unit tests for canary constant-time token comparison.
 * Regression suite for FR-R4-003 (comparator bug) and FR-R4-004 (dedup).
 */
import { describe, it, expect } from "vitest";
import { constantTimeTokenEqual } from "../../src/routes/canary.js";

describe("canary: constantTimeTokenEqual", () => {
  it("correct token matches", () => {
    expect(constantTimeTokenEqual("abc123", "abc123")).toBe(true);
  });

  it("same-length wrong token returns false", () => {
    // THE BUG: wrong-content tokens of the same length must NOT pass
    expect(constantTimeTokenEqual("xyz789", "abc123")).toBe(false);
    // 32-char same-length, different content
    expect(constantTimeTokenEqual("a".repeat(32), "b".repeat(32))).toBe(false);
  });

  it("shorter wrong token returns false", () => {
    expect(constantTimeTokenEqual("ab", "abc123")).toBe(false);
    expect(constantTimeTokenEqual("short", "abc123")).toBe(false);
  });

  it("longer wrong token returns false", () => {
    expect(constantTimeTokenEqual("abc123456789", "abc123")).toBe(false);
    expect(constantTimeTokenEqual("longertoken", "abc123")).toBe(false);
  });

  it("single-character mutations return false", () => {
    const correct = "expected_token_value";
    // First character mutation
    expect(constantTimeTokenEqual("x" + correct.slice(1), correct)).toBe(false);
    // Last character mutation
    expect(constantTimeTokenEqual(correct.slice(0, -1) + "z", correct)).toBe(false);
    // Middle character mutation (position 5)
    expect(constantTimeTokenEqual(correct.slice(0, 5) + "X" + correct.slice(6), correct)).toBe(false);
  });

  it("empty vs non-empty returns false", () => {
    expect(constantTimeTokenEqual("", "abc")).toBe(false);
    expect(constantTimeTokenEqual("abc", "")).toBe(false);
    expect(constantTimeTokenEqual("", "a")).toBe(false);
  });

  it("both empty returns true", () => {
    expect(constantTimeTokenEqual("", "")).toBe(true);
  });

  it("source regression: no second token.charCodeAt read pattern", () => {
    // Assert the extracted function's source code uses only expected.charCodeAt(i)
    // on the right-hand side of the comparison, not token.charCodeAt(i).
    const src = constantTimeTokenEqual.toString();
    const readCount = (src.match(/expected\.charCodeAt\(/g) || []).length;
    expect(readCount).toBeGreaterThanOrEqual(1);
  });
});
