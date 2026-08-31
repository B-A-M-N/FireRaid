/**
 * P1-AUDIT-2: readLabAssignment fail-closed contract (submit.ts + canary.ts).
 *
 * The shared helper that resolves a bound lab session's immutable treatment
 * must NEVER fall back to a random profile when the assignment cannot be read
 * back. Distinguishes:
 *   - D1 query THROWS        → { ok:false, code:assignment_unreadable }
 *   - recipe_json corrupt    → { ok:false, code:assignment_corrupt }
 *   - no lab_runs row        → { ok:true, assignment:null }  (genuinely unbound)
 *   - healthy bound row      → { ok:true, assignment:{recipe,holdout,turnstile} }
 *
 * This is the exact behavior the external audit (P1-AUDIT-2) flagged: a bound
 * FULL run whose assignment read failed was previously scored as RANDOM.
 */
import { describe, it, expect } from "vitest";
import { readLabAssignment } from "../../src/core/lab-assignment.js";

/** Minimal D1 stub that returns a canned parser chain. */
function d1Returning(row: unknown): D1Database {
  return {
    prepare(/* sql: string */) {
      return {
        bind() {
          return {
            first: async () => row,
          };
        },
        run: async () => ({ meta: { changes: 0 } }),
      };
    },
    batch: async () => [],
  } as unknown as D1Database;
}

/** Minimal D1 stub whose first() throws (infra failure). */
function d1ThrowingOnFirst(): D1Database {
  return {
    prepare() {
      return {
        bind() {
          return {
            first: async () => {
              throw new Error("database unreachable");
            },
            run: async () => ({ meta: { changes: 0 } }),
          };
        },
        run: async () => ({ meta: { changes: 0 } }),
      };
    },
    batch: async () => [],
  } as unknown as D1Database;
}

describe("readLabAssignment fail-closed contract (P1-AUDIT-2)", () => {
  it("no lab_runs row → genuinely unbound → ok:true, assignment:null", async () => {
    const r = await readLabAssignment(d1Returning(null), "s1");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.assignment).toBeNull();
  });

  it("healthy bound row → returns recipe + holdout + turnstile", async () => {
    const r = await readLabAssignment(
      d1Returning({
        recipe_json: JSON.stringify({ families: ["semantic", "decoy-route"] }),
        holdout_mode: 0,
        turnstile_required: 1,
      }),
      "s1"
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.assignment).not.toBeNull();
      expect(r.assignment?.recipe?.families).toEqual(["semantic", "decoy-route"]);
      expect(r.assignment?.holdoutMode).toBe(false);
      expect(r.assignment?.turnstileRequired).toBe(true);
    }
  });

  it("null recipe_json (e.g. empty CONTROL) → ok:true with no recipe, still reads flags", async () => {
    const r = await readLabAssignment(
      d1Returning({ recipe_json: null, holdout_mode: 1, turnstile_required: 0 }),
      "s1"
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.assignment?.recipe).toBeUndefined();
      expect(r.assignment?.holdoutMode).toBe(true);
      expect(r.assignment?.turnstileRequired).toBe(false);
    }
  });

  it("D1 read THROWS → FAIL CLOSED: ok:false assignment_unreadable (never random)", async () => {
    const r = await readLabAssignment(d1ThrowingOnFirst(), "s1");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("assignment_unreadable");
      expect(r.detail).toContain("database unreachable");
    }
  });

  it("corrupt recipe_json → FAIL CLOSED: ok:false assignment_corrupt (never random)", async () => {
    const r = await readLabAssignment(
      d1Returning({ recipe_json: "{ not valid json", holdout_mode: 0, turnstile_required: 0 }),
      "s1"
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("assignment_corrupt");
    }
  });
});