/**
 * Low-cardinality (categorical) column criteria.
 *
 * The SQL planner writes `WHERE`/`CASE` clauses against real category
 * vocabularies (status='cancelled', channel='partner', …). Knowing the
 * *actual* value set of a categorical column up front lets it write correct
 * SQL without guessing — and the sample path deliberately aliases low-card
 * text to generic A/B/C placeholders, so it can't recover those names there
 * anyway.
 *
 * Detection itself is data-source-agnostic: it runs lazily the first time a
 * table is described, straight off the live data via SQL, and the verdict is
 * cached per column in `__rh_meta_columns` (see db.ts). That covers every
 * source — file imports, the pre-built demo `.sqlite` blobs, and the legacy
 * default DB alike — rather than only the file-import path. This module owns
 * just the thresholds and the predicate so the importer and the analyzer
 * share one definition of "categorical".
 *
 * A column counts as low-cardinality when its distinct non-null count is:
 *   - at or below {@link LOW_CARD_ALWAYS_FLOOR} (a handful of values — a
 *     near-certain enum: booleans, statuses, ratings, weekdays …), OR
 *   - at or below {@link LOW_CARD_MAX_DISTINCT} *and* small relative to the
 *     row count ({@link LOW_CARD_MAX_RATIO}) — i.e. the values genuinely
 *     repeat rather than being unique-per-row.
 *
 * The ratio gate is what keeps unique-ish columns (ids, emails, names, free
 * text) out: a 30-row table of 30 distinct emails fails it and is never
 * listed, so we don't dump PII-shaped columns to the model. On the large
 * demo tables the distinct cap alone already excludes them (thousands of
 * distinct values blow past 50).
 */

/** A column with this many or fewer distinct values is always categorical. */
export const LOW_CARD_ALWAYS_FLOOR = 8;
/** Never treat a column with more distinct values than this as low-card. */
export const LOW_CARD_MAX_DISTINCT = 50;
/**
 * Between the floor and the cap, a column qualifies only if its distinct
 * count is at most this fraction of the row count (it must repeat).
 */
export const LOW_CARD_MAX_RATIO = 0.5;

/**
 * Decide whether a column is low-cardinality from its distinct non-null
 * count and a row-count denominator (the non-null count, or total rows as a
 * permissive upper bound). Pure — the single source of truth for the rule.
 */
export function isLowCardinality(distinctCount: number, rowCount: number): boolean {
    if (distinctCount <= 0 || distinctCount > LOW_CARD_MAX_DISTINCT) return false;
    if (distinctCount <= LOW_CARD_ALWAYS_FLOOR) return true;
    return distinctCount <= rowCount * LOW_CARD_MAX_RATIO;
}
