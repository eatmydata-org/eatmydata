/**
 * Sanitizes the rows returned by `data_sample` so the LLM sees the *shape* of
 * the data — column types, null patterns, value formats, value-set
 * cardinality, magnitudes — without seeing real values, real category names,
 * real frequencies, or real cross-column correlations.
 *
 * Strategy is chosen *from the data itself*, never from column names:
 *
 *   1. Each column is classified by its observed JS type and cardinality.
 *   2. A perturbation is applied to the values:
 *        - text, parses as ISO date  → generalize to month (`YYYY-MM-??`).
 *        - text, low cardinality     → distinct values are ALIASED to `A`,
 *          `B`, `C`, … and the column is REBUILT as a uniform cycle over
 *          those aliases (+ null if any), so the LLM sees the value set
 *          and that nulls exist but cannot infer frequencies.
 *        - text, high cardinality    → length-preserving mask
 *          (`J*** S*****`, `0000-000-0000`, `*@example.com` — letters become
 *          `*` after the first letter of each word, digits become `0`,
 *          separators are kept verbatim).
 *        - numeric, low cardinality  → distinct values preserved (kept as
 *          mathematical inputs the model may need to filter on) but the
 *          column is REBUILT as a uniform cycle over them so frequencies
 *          are flattened.
 *        - numeric, high cardinality → Laplace noise calibrated to the
 *          column's interquartile range, CLAMPED to the observed
 *          [min, max] so noised values stay in a plausible range, and
 *          rounded back to integer when the source values were integers.
 *        - BLOB                      → replaced with `<blob: N bytes>`.
 *   3. Each column is then shuffled *independently* using a per-chat seeded
 *      PRNG. This is the load-bearing step for row-level privacy: two values
 *      that appeared on the same row no longer do, so the LLM cannot infer
 *      row-level associations like "this email belongs to this customer".
 *
 * Together, distribution flattening (step 2 for low-card columns) and
 * independent column shuffling (step 3) destroy both marginal frequency
 * leakage ("most users are in the US") and joint correlation leakage
 * ("country=US correlates with high spend").
 *
 * No dictionaries, no name regexes, no cross-call stability. The per-chat
 * seed is kept only so two identical sample queries in the same session
 * produce reproducible output (helpful for debugging); it provides no
 * privacy guarantee on its own.
 *
 * With small samples (e.g. N=1) shuffling is effectively a no-op. The
 * accompanying system prompt instructs the model never to treat sampled
 * values, frequencies, or category vocabularies as factual regardless of N.
 *
 * One exception to value masking: **author-supplied SQL literals** (e.g. the
 * `'Q4 2023'` in `CASE WHEN … THEN 'Q4 2023' …`). These are values the LLM
 * already sees in the query and writes its code against, so masking them
 * protects nothing and silently breaks codegen (`row.period === 'Q4 2023'`
 * never matches an aliased `'A'`). Such values pass through unmasked, but only
 * when both signals from `execQuery` agree: the column is a computed
 * expression (`columnOrigins[i] === ''`, from `sqlite3_column_origin_name`)
 * AND the value is in the EXPLAIN-extracted literal set (`sqlLiterals`). The
 * value's *identity* is preserved; its frequency and row associations are
 * still destroyed. Absent that metadata, masking is unchanged. See the `step 2`
 * notes in `applyColumn` and the rationale in `sample-sanitizer.test.ts`.
 */
import type { QueryResult } from '@/lib/wa-sqlite/types';
import { randomUint32 } from '@/lib/random';

type ObservedType = 'text' | 'integer' | 'real' | 'date' | 'blob' | 'null';

type Strategy =
    | 'flatten-text'
    | 'flatten-numeric'
    | 'mask-text'
    | 'generalize-date'
    | 'noise-numeric'
    | 'blob-placeholder'
    | 'passthrough';

function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function shuffleInPlace<T>(arr: T[], rng: () => number): void {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const tmp = arr[i]!;
        arr[i] = arr[j]!;
        arr[j] = tmp;
    }
}

/** Inverse-CDF sample from a zero-centred Laplace distribution. */
function laplaceNoise(rng: () => number, scale: number): number {
    if (scale <= 0) return 0;
    const u = rng() - 0.5;
    const sign = u < 0 ? -1 : 1;
    return -scale * sign * Math.log(1 - 2 * Math.abs(u));
}

function looksLikeIsoDate(s: string): boolean {
    return /^\d{4}-\d{2}-\d{2}/.test(s) && Number.isFinite(Date.parse(s));
}

function observeType(values: ReadonlyArray<unknown>): ObservedType {
    for (const v of values) {
        if (v === null || v === undefined) continue;
        if (typeof v === 'number') {
            return Number.isInteger(v) ? 'integer' : 'real';
        }
        // sqlite-wasm returns large INTEGER aggregates (SUM, COUNT past 2^53)
        // as bigint. Treat them as integers so they pick up Laplace noise
        // instead of being masked as text.
        if (typeof v === 'bigint') return 'integer';
        if (typeof v === 'string') {
            return looksLikeIsoDate(v) ? 'date' : 'text';
        }
        if (v instanceof Uint8Array) return 'blob';
        // Anything else (boolean, object) — treat as text for sanitization.
        return 'text';
    }
    return 'null';
}

function distinctCount(values: ReadonlyArray<unknown>): number {
    const seen = new Set<unknown>();
    for (const v of values) {
        if (v === null || v === undefined) continue;
        if (v instanceof Uint8Array) {
            seen.add(v.join(','));
        } else if (typeof v === 'object') {
            seen.add(JSON.stringify(v));
        } else {
            seen.add(v);
        }
    }
    return seen.size;
}

function isLowCardinality(distinct: number, total: number): boolean {
    if (total <= 1) return true;
    // distinct ≤ √N or distinct ≤ 10, whichever is larger, and not unique.
    const threshold = Math.max(10, Math.ceil(Math.sqrt(total)));
    return distinct <= threshold && distinct < total;
}

function pickStrategy(type: ObservedType, lowCard: boolean): Strategy {
    switch (type) {
        case 'null':
            return 'passthrough';
        case 'blob':
            return 'blob-placeholder';
        case 'date':
            // Always generalize dates; shuffling also runs afterwards.
            return 'generalize-date';
        case 'text':
            return lowCard ? 'flatten-text' : 'mask-text';
        case 'integer':
        case 'real':
            return lowCard ? 'flatten-numeric' : 'noise-numeric';
    }
}

/** `0 → 'A'`, `25 → 'Z'`, `26 → 'AA'`, `27 → 'AB'`, … — generic category
 *  aliases that won't collide with masked text (which always contains `*`
 *  or `0`) and signal "synthetic" to the model. */
function categoryAlias(i: number): string {
    let s = '';
    let n = i;
    while (true) {
        s = String.fromCharCode(65 + (n % 26)) + s;
        n = Math.floor(n / 26) - 1;
        if (n < 0) return s;
    }
}

/** Build a length-N column whose values cycle uniformly over `categories`
 *  (e.g. for N=10, k=3 → 4/3/3). The subsequent independent shuffle places
 *  them at random row positions, so callers must not rely on order. */
function uniformCycle<T>(categories: ReadonlyArray<T>, n: number): T[] {
    const out: T[] = [];
    for (let i = 0; i < n; i++) out.push(categories[i % categories.length]!);
    return out;
}

/** Length-preserving mask: letters → `*` (first letter of each word kept),
 *  digits → `0`, separators preserved as structural markers. */
function maskText(s: string): string {
    let out = '';
    let atWordStart = true;
    for (let i = 0; i < s.length; i++) {
        const ch = s.charAt(i);
        if (/[A-Za-z]/.test(ch)) {
            out += atWordStart ? ch : '*';
            atWordStart = false;
        } else if (/[0-9]/.test(ch)) {
            out += '0';
            atWordStart = false;
        } else {
            out += ch;
            atWordStart = true;
        }
    }
    return out;
}

function generalizeDate(s: string): string {
    if (!looksLikeIsoDate(s)) return maskText(s);
    const month = s.slice(0, 7); // YYYY-MM
    // Preserve the rough format: date-only stays date-only, datetime keeps
    // a redacted time portion so the LLM still sees the column has a time
    // component.
    const hadTime = /[T ]\d{2}:\d{2}/.test(s);
    return hadTime ? `${month}-??T??:??:??` : `${month}-??`;
}

function iqr(values: ReadonlyArray<number>): number {
    if (values.length < 2) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const q = (p: number) => {
        const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)));
        return sorted[idx]!;
    };
    return q(0.75) - q(0.25);
}

function noiseScale(values: ReadonlyArray<number>): number {
    const v = values.filter((x) => Number.isFinite(x));
    if (v.length < 2) return Math.max(1, Math.abs(v[0] ?? 0) * 0.05);
    const spread = iqr(v);
    if (spread > 0) return spread * 0.5;
    // Constant column with cardinality > threshold (rare). Fall back to ~5%
    // of magnitude so the noise is at least visible.
    const mag = v.reduce((a, b) => a + Math.abs(b), 0) / v.length;
    return Math.max(1, mag * 0.05);
}

/**
 * Holds only the per-chat PRNG seed. No dictionaries — values are not
 * re-identifiable across calls and don't need to be.
 */
export class SampleSanitizer {
    private rng: () => number;

    constructor(seed: number = randomUint32()) {
        this.rng = mulberry32(seed);
    }

    sanitize(result: QueryResult): QueryResult {
        const cols = result.columns;
        if (cols.length === 0 || result.rows.length === 0) return result;

        // Literal-passthrough. An author-supplied SQL literal (e.g. the
        // 'Q4 2023' in `CASE WHEN … THEN 'Q4 2023' …`) is a value the LLM
        // already reads in the query and writes its code against. Obfuscating
        // it protects nothing (the model authored it) and silently breaks
        // codegen (`row.period === 'Q4 2023'` never matches the aliased 'A').
        // So such values pass through unmasked — but ONLY when BOTH signals
        // produced in db.ts agree:
        //   • columnOrigins[i] === ''  → the column is a computed expression
        //     (CASE/literal/aggregate/func), not a raw base-table column. A
        //     raw column is always masked even if a cell coincides with a
        //     literal (real data ≠ author constant).
        //   • the cell value is in result.sqlLiterals (the EXPLAIN-extracted
        //     constant set) → it actually is one of the author's constants,
        //     not a computed/aggregated value living in the same expr column.
        // Either signal alone over-exempts; see db.ts #extractSqlLiterals.
        // Exempt values still ride the frequency-flatten + shuffle below — we
        // preserve value *identity*, not counts or row associations. When the
        // metadata is absent (e.g. a synthesized QueryResult), every predicate
        // is `() => false`, so behaviour is exactly the pre-feature masking.
        const literalSet = new Set(result.sqlLiterals ?? []);
        const origins = result.columnOrigins;
        const exemptFor = (colIndex: number): ((v: unknown) => boolean) => {
            const isExpressionColumn = origins?.[colIndex] === '';
            if (!isExpressionColumn || literalSet.size === 0) return () => false;
            return (v: unknown) => v !== null && v !== undefined && literalSet.has(String(v));
        };

        // Transpose to columnar so we can compute stats and shuffle per-column.
        const columnar: Record<string, unknown[]> = {};
        for (const c of cols) columnar[c] = [];
        for (const row of result.rows) {
            for (const c of cols) columnar[c]!.push(row[c]);
        }

        const transformed: Record<string, unknown[]> = {};
        for (let i = 0; i < cols.length; i++) {
            const c = cols[i]!;
            const values = columnar[c]!;
            const type = observeType(values);
            const distinct = distinctCount(values);
            const lowCard = isLowCardinality(distinct, values.length);
            const strategy = pickStrategy(type, lowCard);
            transformed[c] = this.applyColumn(values, strategy, exemptFor(i));
            // Independent per-column shuffle. This breaks (col_a, col_b)
            // co-occurrence across rows — the load-bearing privacy step.
            shuffleInPlace(transformed[c]!, this.rng);
        }

        const rows: Array<Record<string, unknown>> = [];
        for (let i = 0; i < result.rows.length; i++) {
            const row: Record<string, unknown> = {};
            for (const c of cols) row[c] = transformed[c]![i];
            rows.push(row);
        }
        return { ...result, rows };
    }

    private applyColumn(
        values: unknown[],
        strategy: Strategy,
        // True for cells whose value is an author-supplied SQL literal in an
        // expression column — kept verbatim (value identity preserved) while
        // still subject to frequency-flattening + shuffle. Defaults to "never
        // exempt" so direct callers / tests get the original masking.
        exempt: (v: unknown) => boolean = () => false,
    ): unknown[] {
        switch (strategy) {
            case 'passthrough':
                return [...values];
            case 'flatten-text': {
                // Collect distinct non-null values in encounter order, alias
                // each to A/B/C..., then rebuild the column as a uniform
                // cycle over [aliases, ...nullIfPresent]. Frequencies are
                // destroyed; presence of null is preserved. Literal-exempt
                // distinct values keep their real text instead of an alias —
                // the text equivalent of how `flatten-numeric` keeps category
                // codes verbatim — so a coder's `=== 'Q4 2023'` still matches
                // while the count of Q4-vs-Q1 rows is still flattened.
                const seen = new Set<unknown>();
                const distinct: unknown[] = [];
                let hasNull = false;
                for (const v of values) {
                    if (v === null || v === undefined) {
                        hasNull = true;
                        continue;
                    }
                    if (!seen.has(v)) {
                        seen.add(v);
                        distinct.push(v);
                    }
                }
                const aliases: unknown[] = distinct.map((v, i) =>
                    exempt(v) ? v : categoryAlias(i),
                );
                const cats: unknown[] = hasNull ? [...aliases, null] : aliases;
                if (cats.length === 0) return values.map(() => null);
                return uniformCycle(cats, values.length);
            }
            case 'flatten-numeric': {
                // Same as flatten-text but values are kept verbatim — numeric
                // category values (status codes, etc.) are mathematical
                // inputs the model may need to filter on; only the frequency
                // is flattened, not the value identity.
                const seen = new Set<unknown>();
                const distinct: unknown[] = [];
                let hasNull = false;
                for (const v of values) {
                    if (v === null || v === undefined) {
                        hasNull = true;
                        continue;
                    }
                    if (!seen.has(v)) {
                        seen.add(v);
                        distinct.push(v);
                    }
                }
                const cats: unknown[] = hasNull ? [...distinct, null] : distinct;
                if (cats.length === 0) return values.map(() => null);
                return uniformCycle(cats, values.length);
            }
            case 'mask-text':
                return values.map((v) =>
                    v === null || v === undefined ? v : exempt(v) ? v : maskText(String(v)),
                );
            case 'generalize-date':
                return values.map((v) =>
                    v === null || v === undefined
                        ? v
                        : exempt(v)
                          ? v
                          : typeof v === 'string'
                            ? generalizeDate(v)
                            : v,
                );
            case 'blob-placeholder':
                return values.map((v) => {
                    if (v === null || v === undefined) return v;
                    if (v instanceof Uint8Array) return `<blob: ${v.byteLength} bytes>`;
                    return v;
                });
            case 'noise-numeric': {
                // BigInts coerce to Number for the stats pass; this is lossy
                // for values past 2^53 but the goal here is noise scale, not
                // exact arithmetic.
                const nums: number[] = [];
                for (const v of values) {
                    if (typeof v === 'number' && Number.isFinite(v)) nums.push(v);
                    else if (typeof v === 'bigint') nums.push(Number(v));
                }
                const scale = noiseScale(nums);
                const allIntegers = nums.every((n) => Number.isInteger(n));
                // Clamp noised values to the observed range so the model
                // never sees a value outside what the column could plausibly
                // contain (e.g. negative ages, future birth dates).
                let min = Infinity;
                let max = -Infinity;
                for (const n of nums) {
                    if (n < min) min = n;
                    if (n > max) max = n;
                }
                const clamp = (x: number) =>
                    Number.isFinite(min) && Number.isFinite(max)
                        ? Math.min(max, Math.max(min, x))
                        : x;
                return values.map((v) => {
                    // A literal numeric constant the coder may filter on
                    // (`=== 42`) must keep its exact value, not be noised.
                    if (exempt(v)) return v;
                    if (typeof v === 'bigint') {
                        const noised = clamp(Number(v) + laplaceNoise(this.rng, scale));
                        return BigInt(Math.round(noised));
                    }
                    if (typeof v !== 'number' || !Number.isFinite(v)) return v;
                    const noised = clamp(v + laplaceNoise(this.rng, scale));
                    return allIntegers ? Math.round(noised) : Math.round(noised * 1000) / 1000;
                });
            }
        }
    }
}

let active: SampleSanitizer | null = null;

export function getActiveSanitizer(): SampleSanitizer {
    if (!active) active = new SampleSanitizer();
    return active;
}

export function resetSanitizer(): void {
    active = new SampleSanitizer();
}
