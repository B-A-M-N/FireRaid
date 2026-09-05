/**
 * FR-P0-C — classify `wrangler d1 migrations list <db> --remote` output.
 *
 * The old inline regex was exactly inverted: it matched /No migrations/ as a
 * FAILURE (Wrangler prints "✅ No migrations to apply!" when the database is
 * CURRENT) and passed anything else (a stale database prints a TABLE of
 * outstanding migration filenames, which need not contain "unapplied").
 *
 * Contract, per the installed Wrangler's actual outputs:
 *   current     → "✅ No migrations to apply!" (or "No migrations to apply")
 *   outstanding → a list of migration rows (0000_name, 0001_other, …)
 *   unknown     → anything else — callers must FAIL CLOSED on unknown.
 *
 * Classification is deliberately conservative: only a recognized
 * current-marker counts as current; recognized migration-row shapes count as
 * outstanding; everything else (auth failures land here only when wrangler
 * exits 0, network garbage, future format changes) is "unknown" → the
 * caller fails the check.
 */

const CURRENT_MARKERS = [
  "no migrations to apply",
  "no migrations found",
];

// A migration row: a migration-name-ish token, e.g. "0000_create". Wrangler
// prints outstanding migrations in a simple box-drawing table (name +
// creation timestamp) or as bare lines; both forms start (after optional
// bullets/table gutters/whitespace) with NNNN_name.
const MIGRATION_ROW = /^[\s*│|]*\d{4}_[A-Za-z0-9_-]+/;

/**
 * @param {string} stdout — trimmed wrangler stdout
 * @returns {{kind: "current"} | {kind: "outstanding", count: number, names: string[]} | {kind: "unknown", reason: string}}
 */
export function classifyMigrationList(stdout) {
  const text = String(stdout ?? "");
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

  // 1. Outstanding rows FIRST: a current-marker could theoretically
  //    co-appear with listed rows in a mixed update; actual outstanding
  //    migration rows are the actionable fact.
  const rows = lines.filter((l) => MIGRATION_ROW.test(l));
  if (rows.length > 0) {
    return {
      kind: "outstanding",
      count: rows.length,
      names: rows.map((l) => l.replace(/^\s*\*?\s*/, "").split(/\s{2,}|\t/)[0]),
    };
  }

  // 2. Current marker.
  const lower = text.toLowerCase();
  if (CURRENT_MARKERS.some((m) => lower.includes(m))) {
    return { kind: "current" };
  }

  // 3. Anything else — including empty output — is unparseable.
  return {
    kind: "unknown",
    reason: rows.length === 0 && lines.length === 0
      ? "empty output"
      : "no current-marker and no migration rows recognized",
  };
}
