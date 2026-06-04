/**
 * Literal-passthrough in the obfuscation engine.
 *
 * ── The bug this fixes ───────────────────────────────────────────────────
 * The sanitizer masks sampled values so the coder LLM never sees real data.
 * But a value produced by a SQL *literal* —
 *
 *     CASE WHEN s.OrderDate < '2024-01-01' THEN 'Q4 2023' ELSE 'Q1 2024' END
 *
 * — is NOT real data. It is a value the LLM already reads in the query and
 * writes its code against (`row.period === 'Q4 2023'`). The old behaviour
 * aliased `'Q4 2023'`/`'Q1 2024'` to `'A'`/`'B'`, so the coder's comparison
 * never matched and every aggregation stayed at 0. Masking an author-supplied
 * constant protects nothing (the model authored it) and silently breaks
 * codegen. So such values must pass through unmasked.
 *
 * ── Why the fix needs TWO signals, not one ───────────────────────────────
 * The fix passes a cell through iff BOTH hold:
 *
 *   (A) the value is in `sqlLiterals` — the set of constants the query
 *       compiles to, extracted in db.ts by scanning the `EXPLAIN` VDBE
 *       program for String8/Integer/Int64/Real operands. (value-level)
 *   (B) `columnOrigins[i] === ''` — sqlite3_column_origin_name returned NULL,
 *       i.e. the column is a computed expression, not a raw base-table
 *       column. (column-level)
 *
 * Neither implies the other, and either one ALONE over-exempts:
 *
 *   • (A) without (B) — a global value whitelist. A literal frequently
 *     coincides with genuine data: `WHERE status = 'shipped'` puts 'shipped'
 *     in the set while a raw `status` column literally contains 'shipped';
 *     `LIMIT 100` / `> 0` inject 100 / 0 / 1, which collide with most
 *     boolean/categorical data. Origin scoping fences the set to expression
 *     columns so it can never un-mask raw data. → see `origin fence` test.
 *
 *   • (B) without (A) — exempt every expression column. But expression ≠
 *     literal: `first || ' ' || last`, `price * 1.2`, `SUM(amount)`,
 *     `LOWER(email)` are all NULL-origin yet are real (often PII) data that
 *     must stay masked. The literal-set filter keeps "expression" from
 *     meaning "leak it". → see `literal-set filter` test.
 *
 * The interesting case that needs BOTH at the *cell* level is a CASE with a
 * real branch — `CASE WHEN x THEN customer_name ELSE 'Unknown' END` — one
 * expression column holding both literal cells and real-PII cells. Origin
 * can't separate them (whole column is NULL-origin); the literal set
 * discriminates cell-by-cell. → see `CASE with a real branch` test.
 *
 * ── What is preserved vs destroyed ───────────────────────────────────────
 * Exemption preserves value *identity* only. The exempt column still rides
 * the uniform-cycle frequency-flatten and the independent shuffle, so counts
 * and row associations are still destroyed. → see `frequency is still
 * flattened` test.
 *
 * Residual leak (acceptable, documented): a real datum that genuinely equals
 * an author constant in the same expression column (a customer truly named
 * "Unknown") passes through — but it only ever leaks a value the author
 * already typed into the query.
 */
import { describe, expect, it } from 'vitest';
import { SampleSanitizer } from './sample-sanitizer';
import type { QueryResult } from '@/lib/wa-sqlite/types';

function mk(
    columns: string[],
    rows: Array<Record<string, unknown>>,
    extra?: { columnOrigins?: string[]; sqlLiterals?: string[] },
): QueryResult {
    return {
        columns,
        declaredTypes: columns.map(() => ''),
        columnOrigins: extra?.columnOrigins,
        sqlLiterals: extra?.sqlLiterals,
        rows,
        truncated: false,
        rowLimit: 1000,
    };
}

/** One-column QueryResult from a flat list of cell values. */
function oneCol(
    name: string,
    values: unknown[],
    extra?: { origin?: string; sqlLiterals?: string[] },
): QueryResult {
    return mk(
        [name],
        values.map((v) => ({ [name]: v })),
        {
            columnOrigins: extra?.origin === undefined ? undefined : [extra.origin],
            sqlLiterals: extra?.sqlLiterals,
        },
    );
}

function colValues(result: QueryResult, col: string): unknown[] {
    return result.rows.map((r) => r[col]);
}

function distinctOf(values: unknown[]): Set<unknown> {
    return new Set(values.filter((v) => v !== null && v !== undefined));
}

// Skewed 10×'Q4 2023' + 2×'Q1 2024' — low-cardinality text, the flatten-text
// path. Skew lets us prove frequency is destroyed even when identity is kept.
const PERIOD_VALUES = [...Array<string>(10).fill('Q4 2023'), ...Array<string>(2).fill('Q1 2024')];

describe('SampleSanitizer literal-passthrough', () => {
    it('passes a SQL literal in an expression column through unmasked (the bug)', () => {
        // (A) ✓ value in sqlLiterals, (B) ✓ origin '' → exempt.
        const result = oneCol('period', PERIOD_VALUES, {
            origin: '',
            sqlLiterals: ['Q4 2023', 'Q1 2024'],
        });
        const out = new SampleSanitizer(1).sanitize(result);
        const vals = colValues(out, 'period');

        // Real literal text survives verbatim — no A/B aliasing.
        expect(distinctOf(vals)).toEqual(new Set(['Q4 2023', 'Q1 2024']));
        expect(vals).not.toContain('A');
        expect(vals).not.toContain('B');
    });

    it('without the metadata, the same column is masked (proves the metadata drives it)', () => {
        // No columnOrigins / sqlLiterals → both predicates are () => false →
        // exactly the pre-feature behaviour (aliased to A/B). This is also the
        // back-compat guarantee for callers that synthesize a QueryResult.
        const result = oneCol('period', PERIOD_VALUES);
        const out = new SampleSanitizer(1).sanitize(result);
        const vals = colValues(out, 'period');

        expect(distinctOf(vals)).toEqual(new Set(['A', 'B']));
        expect(vals).not.toContain('Q4 2023');
    });

    it('preserves literal identity but still flattens frequency', () => {
        // Privacy property: the exempt column keeps its value set but NOT its
        // 10:2 skew — the uniform cycle equalizes counts across 12 rows.
        const result = oneCol('period', PERIOD_VALUES, {
            origin: '',
            sqlLiterals: ['Q4 2023', 'Q1 2024'],
        });
        const out = new SampleSanitizer(1).sanitize(result);
        const vals = colValues(out, 'period');

        expect(distinctOf(vals)).toEqual(new Set(['Q4 2023', 'Q1 2024'])); // identity kept
        const q4 = vals.filter((v) => v === 'Q4 2023').length;
        expect(q4).not.toBe(10); // original frequency destroyed
        expect(q4).toBe(6); // uniform cycle over 2 categories across 12 rows
    });

    it('origin fence: a raw base-table column is masked even when its value is a literal', () => {
        // SELECT status FROM orders WHERE status IN ('shipped','pending').
        // 'shipped'/'pending' are in the literal set, but `status` is a raw
        // column (origin = 'status'), so it is REAL data and must be masked.
        // This is the case (A)-without-(B) would leak.
        const values = Array.from({ length: 12 }, (_, i) => (i % 2 === 0 ? 'shipped' : 'pending'));
        const result = oneCol('status', values, {
            origin: 'status', // non-empty → raw column
            sqlLiterals: ['shipped', 'pending'],
        });
        const out = new SampleSanitizer(1).sanitize(result);
        const vals = colValues(out, 'status');

        expect(vals).not.toContain('shipped');
        expect(vals).not.toContain('pending');
        // low-cardinality text → aliased to A/B/C…
        expect(vals.every((v) => typeof v === 'string' && /^[A-Z]+$/.test(v))).toBe(true);
    });

    it('literal-set filter: a NON-literal value in an expression column is still masked', () => {
        // full_name = first || ' ' || last → expression column (origin ''),
        // but the concatenated value is not a SQL literal, so it must stay
        // masked. This is the case (B)-without-(A) would leak (real PII).
        const names = Array.from({ length: 12 }, (_, i) => `Name${i} Surname${i}`);
        const result = oneCol('full_name', names, {
            origin: '', // expression column…
            sqlLiterals: ['Q4 2023'], // …but the names aren't literals
        });
        const out = new SampleSanitizer(1).sanitize(result);
        const vals = colValues(out, 'full_name');

        // high-cardinality text → mask-text (letters after word-start → '*').
        expect(vals.every((v) => typeof v === 'string' && v.includes('*'))).toBe(true);
        expect(vals).not.toContain(names[0]);
    });

    it('CASE with a real branch: literal cell passes, real cells masked, same column', () => {
        // CASE WHEN x THEN customer_name ELSE 'Unknown' END — one expression
        // column with mixed cells. Needs cell-level matching: origin alone
        // can't tell the literal 'Unknown' apart from the real names.
        const names = Array.from({ length: 11 }, (_, i) => `Customer${i} X${i}`);
        const values = [...names, 'Unknown']; // 12 distinct → mask-text path
        const result = oneCol('label', values, {
            origin: '',
            sqlLiterals: ['Unknown'],
        });
        const out = new SampleSanitizer(1).sanitize(result);
        const vals = colValues(out, 'label');

        expect(vals.filter((v) => v === 'Unknown')).toHaveLength(1); // literal kept
        expect(vals.filter((v) => v !== 'Unknown').every((v) => String(v).includes('*'))).toBe(
            true,
        ); // real names masked
    });

    it('numeric literal in an expression column keeps its exact value (no noise)', () => {
        // High-cardinality numeric expression column → noise-numeric. The
        // literal 42 (e.g. `CASE … THEN 42 …`) must survive exactly so a
        // coder's `=== 42` works; the rest are noised.
        const values = [42, ...Array.from({ length: 11 }, (_, i) => (i + 1) * 100)];
        const result = oneCol('bucket', values, {
            origin: '',
            sqlLiterals: ['42'], // EXPLAIN stringifies numeric literals
        });
        const out = new SampleSanitizer(7).sanitize(result);
        const vals = colValues(out, 'bucket');

        expect(vals).toContain(42);
    });

    it('date literal in an expression column is not generalized', () => {
        // CASE … THEN '2023-01-01' ELSE '2024-01-01' END — ISO-date-shaped
        // literals would normally be generalized to YYYY-MM-??; exempt them.
        const values = Array.from({ length: 12 }, (_, i) =>
            i % 2 === 0 ? '2023-01-01' : '2024-01-01',
        );
        const result = oneCol('as_of', values, {
            origin: '',
            sqlLiterals: ['2023-01-01', '2024-01-01'],
        });
        const out = new SampleSanitizer(1).sanitize(result);
        const vals = colValues(out, 'as_of');

        expect(distinctOf(vals)).toEqual(new Set(['2023-01-01', '2024-01-01']));
        expect(vals.some((v) => String(v).includes('?'))).toBe(false); // not generalized
    });
});
