import type { Action, ActionOutputFormat, DataSource, ResultBlock } from './types';
import { resolveDb } from '@/lib/data-sources/resolver';
import { runInSandbox } from '@/lib/sandbox/runtime';
import { isEchartsOption, isEchartsOptionArray } from '@/lib/echarts/shape';
import { normalizeQueryResultColumns } from '@/lib/sqlite/ts-from-columns';
import type { QueryResult } from '@/lib/wa-sqlite/types';

/**
 * Split a markdown TEMPLATE into alternating literal segments and `${expr}`
 * interpolations. The invariant: everything between a `${` and its matching
 * `}` is JS source code that must be passed through verbatim; everything
 * else is literal text that the wrapper will escape for safe embedding in a
 * JS template literal.
 *
 * Naive `template.replace(/`/g, '\\`')` over the whole template is wrong:
 *
 *   1. Nested template literals inside expressions get over-escaped, e.g.
 *      `${arr.map(r => \`x: ${r.id}\`).join('\n')}` becomes invalid JS.
 *   2. Backslashes inside string literals in expressions get doubled, so
 *      `${arr.join('\n')}` turns into `${arr.join('\\n')}` — JS then reads
 *      that as the two-character string backslash-n, not a newline.
 *
 * Parser rules:
 *   - `\${` in the source escapes the interpolation; the result is a literal
 *     `${` in the output and the backslash is consumed.
 *   - `${...}` enters expression mode. Scan to the matching `}` tracking
 *     brace depth outside of strings/template-literals. Inside `'...'`,
 *     `"..."`, or `` `...` `` strings, braces don't count and `\` escapes
 *     the next character. A nested `` `...${...}...` `` recurses through
 *     the same scan so the inner `}` doesn't close the outer interpolation.
 *
 * An unterminated `${` returns whatever was parsed so far; a downstream
 * QuickJS parse error will surface the malformed template loudly enough.
 */
export function parseMarkdownTemplate(template: string): {
    literals: string[];
    expressions: string[];
} {
    const literals: string[] = [];
    const expressions: string[] = [];
    let lit = '';
    let i = 0;
    while (i < template.length) {
        // Escaped `${` opts out of interpolation — emit a literal `${`.
        if (template[i] === '\\' && template[i + 1] === '$' && template[i + 2] === '{') {
            lit += '${';
            i += 3;
            continue;
        }
        if (template[i] === '$' && template[i + 1] === '{') {
            literals.push(lit);
            lit = '';
            const end = findExprEnd(template, i + 2);
            expressions.push(template.slice(i + 2, end - 1));
            i = end;
            continue;
        }
        lit += template[i];
        i++;
    }
    literals.push(lit);
    return { literals, expressions };
}

/**
 * Given `s` and a `start` index pointing at the first char AFTER `${`,
 * return the index ONE PAST the matching `}`. If the template is unclosed,
 * return `s.length` — the caller will produce a malformed wrapped template
 * which QuickJS will reject at parse time.
 */
function findExprEnd(s: string, start: number): number {
    let i = start;
    let depth = 1;
    while (i < s.length && depth > 0) {
        const c = s[i];
        if (c === '\\') {
            // Backslash escapes the next char wherever we are at top level.
            i += 2;
            continue;
        }
        if (c === '"' || c === "'") {
            i = scanQuotedString(s, i + 1, c);
            continue;
        }
        if (c === '`') {
            i = scanTemplateLiteral(s, i + 1);
            continue;
        }
        if (c === '{') {
            depth++;
            i++;
            continue;
        }
        if (c === '}') {
            depth--;
            i++;
            if (depth === 0) return i;
            continue;
        }
        i++;
    }
    return i;
}

/**
 * Scan a `'...'`/`"..."` string body starting at `i` (the first char after the
 * opening quote `close`). Returns the index ONE PAST the closing quote (or past
 * EOF safely). Inside the string, `\` escapes the next char and braces don't
 * count.
 */
function scanQuotedString(s: string, i: number, close: string): number {
    while (i < s.length && s[i] !== close) {
        if (s[i] === '\\') {
            i += 2;
            continue;
        }
        i++;
    }
    return i + 1; // skip the closing quote (or step past EOF safely)
}

/**
 * Scan a `` `...` `` template-literal body starting at `i` (the first char after
 * the opening backtick). Returns the index ONE PAST the closing backtick. A
 * nested `${...}` recurses through `findExprEnd` so its inner `}` doesn't bleed
 * into the caller's brace depth.
 */
function scanTemplateLiteral(s: string, i: number): number {
    while (i < s.length && s[i] !== '`') {
        if (s[i] === '\\') {
            i += 2;
            continue;
        }
        if (s[i] === '$' && s[i + 1] === '{') {
            i = findExprEnd(s, i + 2);
            continue;
        }
        i++;
    }
    return i + 1; // skip the closing backtick
}

/**
 * Wrap a markdown TEMPLATE as a JS statement that assigns the interpolated
 * string to `__output`. The template's own `${expr}` runs through the JS
 * template-literal engine inside QuickJS — that's the whole reuse trick.
 *
 * Literals are escaped (`\`, `` ` ``, and any stray `${` left over from a
 * `\${` opt-out). Expressions are emitted verbatim so user-typed JS source
 * (including nested template literals and string escapes) lands in QuickJS
 * exactly as the Coder wrote it.
 */
export function wrapMarkdownTemplate(template: string): string {
    const { literals, expressions } = parseMarkdownTemplate(template);
    const escaped = literals.map((l) =>
        l.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${'),
    );
    let src = '__output = `';
    for (let i = 0; i < escaped.length; i++) {
        src += escaped[i];
        if (i < expressions.length) {
            src += '${' + expressions[i] + '}';
        }
    }
    src += '`;';
    return src;
}

export type DataSourceFetchResult = {
    name: string;
    rowCount: number;
    columns: string[];
    truncated: boolean;
    error?: string;
};

export type ActionExecution = {
    /** Stable identifier used for the in-memory result store and /result/:id route. */
    id: string;
    actionId: string;
    actionName: string;
    /**
     * The ActionVersion this execution belongs to. Optional for backward
     * compatibility with rows persisted before versioning existed — those
     * render as "legacy" in the UI.
     */
    versionId?: string;
    startedAt: number;
    finishedAt: number;
    outputFormat: ActionOutputFormat;
    /** Per-data-source materialization summary (rowCount > 0 etc). */
    dataSources: DataSourceFetchResult[];
    /** Sandbox result — value of `__output` after the code ran. */
    output?: unknown;
    stdout: string[];
    /** Top-level error: SQL fetch failure or sandbox failure. */
    error?: string;
};

/**
 * Run the Action end-to-end: fetch every data source's real rows (unbounded),
 * then execute the JS code in QuickJS with those rows bound as named globals.
 * No LLM involvement — this is the deterministic execution pipeline.
 *
 * Invariant: callers must persist `action` to IndexedDB before calling this.
 * Every ActionExecution has a corresponding Action row.
 */
export async function executeAction(action: Action): Promise<ActionExecution> {
    const startedAt = Date.now();
    const id = crypto.randomUUID();

    const db = await resolveDb(action.dataSourceId);
    const { fetchSummaries, globals, fetchError } = await fetchAllDataSources(
        db,
        action.dataSources,
    );
    let topError: string | undefined = fetchError;

    const kind = action.kind ?? 'code';
    let output: unknown = undefined;
    let stdout: string[] = [];
    if (!topError && action.code) {
        const code = kind === 'markdown' ? wrapMarkdownTemplate(action.code) : action.code;
        const result = await runInSandbox({ code, globals });
        if (result.ok) {
            output = result.output;
            stdout = result.stdout;
        } else {
            topError = formatExecutionError(result, globals);
            stdout = result.stdout;
        }
    } else if (!action.code) {
        topError = 'Action has no code step.';
    }

    // For markdown actions, force the renderer to markdown regardless of
    // sandbox output shape. `inferOutputFormat` would also pick markdown
    // (the wrapped template's `__output` is a string), but being explicit
    // avoids a surprise if the model ever passes a template that produces
    // a non-string in some corner case.
    const outputFormat: ActionOutputFormat =
        kind === 'markdown' ? 'markdown' : inferOutputFormat(output);

    return {
        id,
        actionId: action.id,
        actionName: action.name,
        startedAt,
        finishedAt: Date.now(),
        outputFormat,
        dataSources: fetchSummaries,
        output,
        stdout,
        error: topError,
    };
}

/**
 * Duck-type the format of `__output` from its runtime shape. The Coder no
 * longer declares the output format; the renderer infers it here.
 *
 * The primary path is the composable BLOCK model: the Coder builds
 * `md()`/`chart()`/`table()` blocks and composes them with `present(...)`,
 * which sets `__output` to a `{ __kind:'blocks', blocks }` wrapper. The
 * legacy bare-value shapes are retained for backward compatibility (results
 * already persisted in IDB) and as a convenience for a Coder that returns a
 * single bare value.
 *
 * Order is load-bearing — `blocks` first; ECharts before the flat-record
 * array check, so a bare chart array isn't mistaken for a table:
 *   - block wrapper / bare block / array of blocks → 'blocks'
 *   - string → 'markdown'
 *   - array of ECharts options / single ECharts option → 'echarts'
 *   - array of flat scalar records → 'blocks' (one table block, convenience)
 *   - everything else → 'json'
 *
 * 'html' is not auto-inferred — it requires explicit user intent and would
 * round-trip through a future explicit signal if we ever bring it back.
 */
export function inferOutputFormat(output: unknown): ActionOutputFormat {
    if (isBlocksOutput(output)) return 'blocks';
    if (typeof output === 'string') return 'markdown';
    if (isEchartsOptionArray(output)) return 'echarts';
    if (isEchartsOption(output)) return 'echarts';
    if (isFlatRecordArray(output)) return 'blocks';
    return 'json';
}

type WireBlock = {
    __kind: 'block';
    type: 'markdown' | 'chart' | 'table';
    [k: string]: unknown;
};

/** A single block tag produced by `md()`/`chart()`/`table()` in the sandbox. */
function isWireBlock(x: unknown): x is WireBlock {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return false;
    const o = x as Record<string, unknown>;
    return (
        o.__kind === 'block' && (o.type === 'markdown' || o.type === 'chart' || o.type === 'table')
    );
}

/**
 * The composable-output shapes the renderer treats as `'blocks'`: the
 * `present(...)` wrapper, a single bare block, or a bare array of blocks.
 */
export function isBlocksOutput(x: unknown): boolean {
    if (
        x &&
        typeof x === 'object' &&
        !Array.isArray(x) &&
        (x as Record<string, unknown>).__kind === 'blocks' &&
        Array.isArray((x as { blocks?: unknown }).blocks)
    ) {
        return true;
    }
    if (isWireBlock(x)) return true;
    return Array.isArray(x) && x.length > 0 && x.every(isWireBlock);
}

/**
 * A non-empty array whose every element is a plain object of SCALAR values
 * (string | number | boolean | null | undefined). Nested objects/arrays
 * disqualify it — those stay JSON. ECharts arrays are excluded by the caller
 * ordering (the ECharts checks run first).
 */
function isFlatRecordArray(x: unknown): x is Array<Record<string, unknown>> {
    if (!Array.isArray(x) || x.length === 0) return false;
    return x.every((el) => {
        if (!el || typeof el !== 'object' || Array.isArray(el)) return false;
        return Object.values(el as Record<string, unknown>).every(
            (v) =>
                v === null ||
                v === undefined ||
                typeof v === 'string' ||
                typeof v === 'number' ||
                typeof v === 'boolean',
        );
    });
}

/** Union of keys across all rows, preserving first-seen insertion order. */
export function deriveTableColumns(rows: Array<Record<string, unknown>>): string[] {
    const seen = new Set<string>();
    for (const row of rows) for (const k of Object.keys(row)) seen.add(k);
    return [...seen];
}

/**
 * Coerce a `table(rows, { columns })` spec to a list of STRING field names.
 * The model often reaches for AG-Grid-style column descriptors
 * (`{ field, headerName }`) or other objects; a non-string `field` crashes
 * AG-Grid (`field.includes` in `initDotNotation`). We accept strings as-is and
 * pull a name out of objects (`field`/`name`/`key`/`id`); anything unusable
 * falls back to deriving columns from the row keys.
 */
export function normalizeTableColumns(
    columns: unknown,
    rows: Array<Record<string, unknown>>,
): string[] {
    if (!Array.isArray(columns) || columns.length === 0) return deriveTableColumns(rows);
    const names: string[] = [];
    for (const c of columns) {
        if (typeof c === 'string') {
            names.push(c);
        } else if (c && typeof c === 'object') {
            const o = c as Record<string, unknown>;
            const cand = o.field ?? o.name ?? o.key ?? o.id;
            if (typeof cand === 'string') names.push(cand);
        }
        // Non-string, non-extractable entries are dropped rather than passed
        // through as a bad colDef field.
    }
    return names.length > 0 ? names : deriveTableColumns(rows);
}

/**
 * Normalize `__output` into the renderer's `ResultBlock[]`. Handles the
 * `present(...)` wrapper, a bare block, a bare array of blocks, and (as a
 * convenience) a bare array of flat records → a single table block. Maps the
 * wire `type` field to `kind` and derives table columns when absent. Returns
 * `[]` if nothing applies (the renderer falls back to JSON).
 */
export function toBlocks(output: unknown): ResultBlock[] {
    let wire: WireBlock[];
    if (
        output &&
        typeof output === 'object' &&
        !Array.isArray(output) &&
        (output as Record<string, unknown>).__kind === 'blocks' &&
        Array.isArray((output as { blocks?: unknown }).blocks)
    ) {
        wire = (output as { blocks: unknown[] }).blocks.filter(isWireBlock);
    } else if (isWireBlock(output)) {
        wire = [output];
    } else if (Array.isArray(output) && output.length > 0 && output.every(isWireBlock)) {
        wire = output as WireBlock[];
    } else if (isFlatRecordArray(output)) {
        return [{ kind: 'table', columns: deriveTableColumns(output), rows: output }];
    } else {
        return [];
    }
    return wire.map(wireBlockToResultBlock);
}

function wireBlockToResultBlock(b: WireBlock): ResultBlock {
    if (b.type === 'markdown') {
        return { kind: 'markdown', text: String(b.text ?? '') };
    }
    if (b.type === 'chart') {
        return {
            kind: 'chart',
            option: (b.option ?? {}) as Record<string, unknown>,
        };
    }
    const rows = (Array.isArray(b.rows) ? b.rows : []) as Array<Record<string, unknown>>;
    const columns = normalizeTableColumns(b.columns, rows);
    return {
        kind: 'table',
        columns,
        rows,
        ...(typeof b.title === 'string' ? { title: b.title } : {}),
        ...(typeof b.caption === 'string' ? { caption: b.caption } : {}),
    };
}

/**
 * Stable content hash over the parts of an Action that define a *version*:
 * the code and the SQL of each data source (order-sensitive — the user
 * intentionally chose the order). Used to dedupe ActionVersion rows so that
 * re-executing identical params lands on the same version row.
 */
export async function hashActionParams(params: {
    code: string;
    dataSources: Pick<DataSource, 'name' | 'query'>[];
}): Promise<string> {
    const canonical = JSON.stringify({
        code: params.code,
        dataSources: params.dataSources.map((d) => ({
            name: d.name,
            query: d.query,
        })),
    });
    const bytes = new TextEncoder().encode(canonical);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}

type DbLike = { execFull: (sql: string) => Promise<unknown> | unknown };
type Fetched = { columns: string[]; rows: Array<Record<string, unknown>>; truncated: boolean };

/**
 * Fetch every data source's rows, binding each result set as a named global for
 * the sandbox. Per-source failures are captured into the summary and the FIRST
 * one becomes the top-level error (so the sandbox step is skipped).
 */
async function fetchAllDataSources(
    db: DbLike,
    dataSources: DataSource[],
): Promise<{
    fetchSummaries: DataSourceFetchResult[];
    globals: Record<string, unknown>;
    fetchError: string | undefined;
}> {
    const fetchSummaries: DataSourceFetchResult[] = [];
    const globals: Record<string, unknown> = {};
    let fetchError: string | undefined;

    for (const ds of dataSources) {
        try {
            const result = await fetchDataSource(db, ds);
            fetchSummaries.push({
                name: ds.name,
                rowCount: result.rows.length,
                columns: result.columns,
                truncated: result.truncated,
            });
            globals[ds.name] = result.rows;
        } catch (e) {
            const error = e instanceof Error ? e.message : String(e);
            fetchSummaries.push({
                name: ds.name,
                rowCount: 0,
                columns: [],
                truncated: false,
                error,
            });
            fetchError = fetchError ?? `Data source ${ds.name}: ${error}`;
        }
    }

    return { fetchSummaries, globals, fetchError };
}

/**
 * Build the top-level error string for a sandbox failure, including the bound
 * data-source globals so a ReferenceError can be triaged: a name IN this list
 * means the code line is at fault; a name NOT in it means the Coder wrote a
 * name that doesn't match any saved data source (typo / model drift).
 */
function formatExecutionError(
    result: Extract<Awaited<ReturnType<typeof runInSandbox>>, { ok: false }>,
    globals: Record<string, unknown>,
): string {
    const parts = [`Sandbox failure (phase: ${result.phase})`];
    if (result.line !== undefined) parts.push(`line: ${result.line}`);
    parts.push(`message: ${result.error}`);
    if (result.stack) parts.push(`stack: ${result.stack}`);
    const boundNames = Object.keys(globals);
    parts.push(
        `bound data-source globals: ${
            boundNames.length ? boundNames.map((n) => `\`${n}\``).join(', ') : '(none)'
        }`,
    );
    return parts.join('\n');
}

async function fetchDataSource(db: DbLike, ds: DataSource): Promise<Fetched> {
    const raw = (await db.execFull(ds.query)) as QueryResult;
    // Same identifier-safety rename the Planner applied when the data
    // source was saved. The Coder's bound global keys MUST match the type
    // declaration it was shown — otherwise it writes e.g. `result.col0`
    // and finds the row keyed by `AVG(...)` at runtime.
    const normalized = normalizeQueryResultColumns(raw);
    return {
        columns: normalized.columns,
        rows: normalized.rows,
        truncated: normalized.truncated,
    };
}
