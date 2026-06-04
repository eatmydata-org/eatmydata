import type { Action, ActionOutputFormat, DataSource } from './types';
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
            const close = c;
            i++;
            while (i < s.length && s[i] !== close) {
                if (s[i] === '\\') {
                    i += 2;
                    continue;
                }
                i++;
            }
            i++; // skip the closing quote (or step past EOF safely)
            continue;
        }
        if (c === '`') {
            i++;
            while (i < s.length && s[i] !== '`') {
                if (s[i] === '\\') {
                    i += 2;
                    continue;
                }
                if (s[i] === '$' && s[i + 1] === '{') {
                    // Nested interpolation inside a template literal — recurse
                    // so its inner `}` doesn't bleed into our brace depth.
                    i = findExprEnd(s, i + 2);
                    continue;
                }
                i++;
            }
            i++; // skip the closing backtick
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
    const fetchSummaries: DataSourceFetchResult[] = [];
    const globals: Record<string, unknown> = {};
    let topError: string | undefined;

    const db = await resolveDb(action.dataSourceId);

    for (const ds of action.dataSources) {
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
            topError = topError ?? `Data source ${ds.name}: ${error}`;
        }
    }

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
            const parts = [`Sandbox failure (phase: ${result.phase})`];
            if (result.line !== undefined) parts.push(`line: ${result.line}`);
            parts.push(`message: ${result.error}`);
            if (result.stack) parts.push(`stack: ${result.stack}`);
            // List the globals that WERE bound. If a ReferenceError points
            // at one of these names the code line is at fault; if it points
            // at a name NOT in this list, the Coder wrote a name that
            // doesn't match any saved data source (typo / model drift).
            const boundNames = Object.keys(globals);
            parts.push(
                `bound data-source globals: ${
                    boundNames.length ? boundNames.map((n) => `\`${n}\``).join(', ') : '(none)'
                }`,
            );
            topError = parts.join('\n');
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
 * Rules:
 *   - string → 'markdown' (covers the common "produce a tabular markdown answer" path)
 *   - array of ECharts options → 'echarts' (multi-chart dashboard form)
 *   - object with ECharts-shaped top-level keys (series/xAxis/yAxis/grid) → 'echarts'
 *   - everything else (objects without ECharts shape, arrays of other things,
 *     numbers, etc.) → 'json'
 *
 * 'html' is not auto-inferred — it requires explicit user intent and would
 * round-trip through a future explicit signal if we ever bring it back.
 */
export function inferOutputFormat(output: unknown): ActionOutputFormat {
    if (typeof output === 'string') return 'markdown';
    if (isEchartsOptionArray(output)) return 'echarts';
    if (isEchartsOption(output)) return 'echarts';
    return 'json';
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
