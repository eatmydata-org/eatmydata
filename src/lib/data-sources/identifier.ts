/**
 * Identifier-cleanup helpers used by the import pipeline so generated
 * table/column names are always safe to splice into sqlite SQL.
 *
 * Strategy: lowercase, replace any non-[a-z0-9_] run with `_`, collapse
 * repeats, strip leading digits/underscores, ensure non-empty, fall back
 * to a generic name, and dedup against a set.
 */

// Names sqlite parses specially in standalone position. Not exhaustive —
// just the ones we'd plausibly bump into in spreadsheet imports.
const RESERVED = new Set([
    'select', 'from', 'where', 'group', 'order', 'by', 'having',
    'join', 'inner', 'outer', 'left', 'right', 'full', 'on',
    'union', 'all', 'as', 'and', 'or', 'not', 'null', 'true', 'false',
    'in', 'is', 'like', 'between', 'case', 'when', 'then', 'else', 'end',
    'create', 'table', 'view', 'index', 'drop', 'alter', 'insert', 'update',
    'delete', 'into', 'values', 'set', 'with', 'recursive',
    'primary', 'key', 'foreign', 'references', 'default', 'unique', 'check',
    'rowid', 'oid', '_rowid_',
]);

/**
 * Convert any string to snake_case sqlite identifier. Empty input or all
 * non-alphanumeric → `fallback`. Returns sanitized identifier — does NOT
 * dedup; pair with `dedupIdentifier` for that.
 */
export function toSnakeCase(input: string, fallback = 'unnamed'): string {
    let s = String(input ?? '');
    // Strip a trailing extension if it looks like a filename ("Q3.csv").
    s = s.replace(/\.[a-zA-Z0-9]{1,5}$/, '');
    // Insert separators between camelCase/PascalCase runs before lowercasing.
    s = s.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
    s = s.toLowerCase();
    s = s.replace(/[^a-z0-9]+/g, '_');
    s = s.replace(/_+/g, '_').replace(/^_+|_+$/g, '');
    // sqlite identifiers can't start with a digit (well, technically they
    // can if quoted, but we don't quote — we want bare identifiers).
    if (/^[0-9]/.test(s)) s = `t_${s}`;
    if (s.length === 0) s = fallback;
    if (RESERVED.has(s)) s = `${s}_`;
    return s;
}

/**
 * Append `_1`, `_2`, … until the candidate is not in `taken`. The input
 * is treated as already-sanitized; pass it through `toSnakeCase` first.
 * The first colliding suffix is `_1` (matches the human-name `(1)` rule).
 */
export function dedupIdentifier(name: string, taken: Set<string>): string {
    if (!taken.has(name)) return name;
    let i = 1;
    while (taken.has(`${name}_${i}`)) i++;
    return `${name}_${i}`;
}

/**
 * Dedup a human-readable name by suffixing ` (1)`, ` (2)`, … until unique
 * against `taken`. Used for data-source display names where the rule is
 * "no two sources can share a display name" — mirrors the `_1` table-name
 * rule above but in human-friendly form.
 *
 * Note: this is rename-safe across re-imports of the same file. If the
 * user has `Sales Q3` and `Sales Q3 (1)`, importing the same file a third
 * time produces `Sales Q3 (2)`.
 */
export function dedupHumanName(name: string, taken: Set<string>): string {
    if (!taken.has(name)) return name;
    let i = 1;
    while (taken.has(`${name} (${i})`)) i++;
    return `${name} (${i})`;
}

/**
 * Strip a filename extension and trim whitespace. Used as the seed for
 * both source display name (`Sales Q3`) and table name (`sales_q3`).
 */
export function basenameWithoutExtension(filename: string): string {
    const trimmed = filename.trim();
    const lastDot = trimmed.lastIndexOf('.');
    if (lastDot <= 0) return trimmed;
    const ext = trimmed.slice(lastDot + 1);
    // Only treat short alphanumeric suffixes as extensions.
    if (!/^[a-zA-Z0-9]{1,5}$/.test(ext)) return trimmed;
    return trimmed.slice(0, lastDot);
}

/**
 * Convenience: sanitize a list while deduping against itself plus an
 * existing taken-set. Returns the new names in the same order.
 */
export function sanitizeColumnNames(
    headers: readonly string[],
    extraTaken: Set<string> = new Set(),
): string[] {
    const taken = new Set<string>(extraTaken);
    const out: string[] = [];
    headers.forEach((h, i) => {
        const base = toSnakeCase(h || `col_${i + 1}`, `col_${i + 1}`);
        const uniq = dedupIdentifier(base, taken);
        taken.add(uniq);
        out.push(uniq);
    });
    return out;
}
