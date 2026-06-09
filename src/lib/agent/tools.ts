import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { resolveDb } from '@/lib/data-sources/resolver';
import { isMetaTable, getLowCardColumns, ensureCardinalityAnalyzed } from '@/lib/data-sources/db';
import { LOW_CARD_MAX_DISTINCT } from '@/lib/data-sources/low-cardinality';
import type { ColumnInfo, ForeignKey, QueryResult, TableSchema } from '@/lib/wa-sqlite/types';
import type { PlanInput, SavedQuery } from '@/lib/types';
import { getActiveSanitizer } from './sample-sanitizer';
import { normalizeQueryResultColumns } from '@/lib/sqlite/ts-from-columns';

const planSchema = z
    .object({
        summary: z.string().default(''),
        tables: z.array(z.string()).default([]),
        columns: z.array(z.string()).default([]),
        intended_queries: z.array(z.string()).default([]),
    })
    .passthrough();

const saveQuerySchema = z
    .object({
        name: z.string().default('query'),
        sql: z.string(),
        description: z.string().default(''),
    })
    .passthrough();

const describeTableSchema = z.object({ table: z.string() }).passthrough();

const dataSampleSchema = z
    .object({
        sql: z.string(),
        limit: z.number().int().min(1).max(20).optional(),
    })
    .passthrough();

const emptyInputSchema = z.object({}).passthrough();

const workOnActionSchema = z
    .object({
        name: z.string().min(1),
        description: z.string().default(''),
        intent: z.string().min(1),
        // F4: `mode` is gone. The runtime always runs the Planner with
        // REPLAN context when prior sources exist and lets the Planner
        // decide whether to add/replace/keep. If a stale model still
        // passes `mode`, `.passthrough()` accepts it without effect.
    })
    .passthrough();

const saveDataSourceSchema = z
    .object({
        name: z.string().min(1),
        query: z.string().min(1),
        semantic_description: z.string().default(''),
    })
    .passthrough();

const runInSandboxSchema = z
    .object({
        code: z.string().min(1),
    })
    .passthrough();

const saveMarkdownActionSchema = z
    .object({
        template: z.string().min(1),
    })
    .passthrough();

const validateEchartsSchema = z
    .object({
        option: z.record(z.string(), z.unknown()),
    })
    .passthrough();

const askUserSchema = z
    .object({
        // `question` is conceptually required (the prompt says so) but kept
        // optional at the validator boundary as defence-in-depth: the model
        // in log1.txt emitted ask_user with no `question` field and the
        // resulting Zod throw broke the turn entirely. The executor
        // synthesizes a generic fallback when the model omits it (F5
        // regression guard).
        question: z.string().optional(),
        options: z
            .array(
                z.object({
                    id: z.string().min(1),
                    label: z.string().min(1),
                    hint: z.string().optional(),
                }),
            )
            .min(2)
            .max(6),
        allowFreeText: z.boolean().default(true),
    })
    .passthrough();

/**
 * Schemas describe what each tool does *mechanically*. No domain context —
 * the model must infer what the data represents from the names it discovers.
 */
export const agentTools = {
    propose_plan: tool({
        description:
            'Propose a plan after exploring the schema with list_tables / describe_table, but BEFORE any data_sample or save_query call. The plan must reference real table and column names you have already verified — do not propose plans against guessed names. The user reviews the plan and either approves (the tool then returns {approved:true}) or cancels.',
        inputSchema: planSchema,
    }),
    list_tables: tool({
        description:
            'List the names and types (table/view) of every user object in the SQLite database. No domain context is provided — the model infers what the data represents from names.',
        inputSchema: emptyInputSchema,
    }),
    describe_table: tool({
        description:
            'Return the columns (name, type, nullability, primary-key flag) and foreign-key relationships of one table. Columns detected as low-cardinality (categorical) carry a `low_card_values` field listing their complete set of distinct values from the live data — use it to write correct WHERE/CASE clauses against real category names instead of guessing or sampling. These are real values, not the aliased placeholders data_sample returns; absence of the field means the column is high-cardinality (ids, free text, etc.) or the object is a view.',
        inputSchema: describeTableSchema,
    }),
    data_sample: tool({
        description:
            'Run a read-only SELECT/WITH/EXPLAIN and return at most 20 rows. The row cap is enforced regardless of LIMIT in the SQL. Returned rows are PERTURBED: high-cardinality text is length-preserving masked, dates generalized to month, high-cardinality numerics noised and clamped to the observed range, low-cardinality text is ALIASED to generic identifiers (A, B, C, …), low-cardinality numeric values are preserved, the distribution of every low-cardinality column is FLATTENED to uniform, and each column is shuffled independently — values on the same returned row are NOT from the same source record, the visible category vocabulary is synthetic, and frequencies/proportions are mathematically meaningless. Use ONLY to confirm column types, null pattern, value-format patterns, and that the SQL parses/joins. Never report sampled values, category names, row-level associations, frequencies, or sampled aggregates as findings; the final saved query runs on the real data.',
        inputSchema: dataSampleSchema,
    }),
    save_query: tool({
        description:
            'Capture a deterministic SQL query as a final artifact. The query is NOT executed here — it will be re-run later against the full dataset to display results to the user. Save once per final SQL.',
        inputSchema: saveQuerySchema,
    }),
    work_on_action: tool({
        description:
            "Start or iterate on an Action — a re-usable bundle of data sources plus a code step. The runtime explores the schema, drafts SQL data sources, and produces a code step that renders the answer; on iteration it reuses what already works and updates only what needs to change. The `name` field is a short, human-readable English title for the sidebar (e.g. 'Top customers by revenue', 'Q1 churn breakdown') — NOT an identifier-style name like 'topCustomersByRevenue' or 'q1_churn'. Keep it under 50 characters. The `intent` is the user's question in their own words; the runtime picks the output shape (text vs ECharts dashboard) from the intent.",
        inputSchema: workOnActionSchema,
    }),
    save_data_source: tool({
        description:
            'Planner-only. Save ONE candidate SQL query as a data source for the action. Call once per query — iterate freely (sample with data_sample first if you need to verify shape, then save). The runtime validates the SQL, runs it against the seeded data, derives a zod schema, and stores the draft. Re-calling with the same `name` overwrites the previous draft. When you have saved everything the action needs, simply RESPOND WITH TEXT (no further tool calls) and the runtime will hand the full draft set off to the Coder — there is no separate finalize tool and no user approval step.',
        inputSchema: saveDataSourceSchema,
    }),
    run_in_sandbox: tool({
        description:
            'Coder-only. Submits a candidate code step for the Action. The runtime: (1) runs the JS inside a QuickJS sandbox with the data sources bound as named globals; (2) if it throws, returns the error + your code listing so you can fix and retry; (3) if it runs without throwing, the runtime AUTOMATICALLY presents the code to the user for approval (Execute / Save+Execute / Cancel). On user Cancel you may revise and call again. Input: `code` (a string of JS). Compose the answer from blocks and finalize with the `present(...)` global: `md(text)` for markdown prose/headings (NOT tables), `chart(option)` for an ECharts chart, and `table(rows, { columns?, title?, caption? })` for ANY tabular data — `table()` renders as an interactive virtualized grid (sort/filter/search/CSV/Excel) and is the ONLY table surface, never a markdown/HTML table, at any size. Adjacent `chart()` blocks form one coordinated dashboard. The sandbox is stateless between calls.',
        inputSchema: runInSandboxSchema,
    }),
    save_markdown_action: tool({
        description:
            'Coder-only. Final ANSWER for textual analyses. Submits a markdown TEMPLATE — plain markdown with JS-template-literal `${expr}` interpolations against the bound data sources. Cheaper than `run_in_sandbox` when the answer is mostly prose/tables with a few computed values: no code wrapping, no per-line JS. The runtime: (1) wraps your template as `__output = \\`<template>\\`` and runs it inside QuickJS to validate every `${expr}`; (2) if it throws, returns the error so you can fix and retry; (3) if it runs without throwing, the runtime AUTOMATICALLY presents the code to the user for approval (Execute / Save+Execute / Cancel). Choose THIS tool over `run_in_sandbox` whenever the user asked for a textual/markdown answer and the computation is light (a few totals, counts, percentages) with NO table. Do NOT build tables here — the moment the answer includes any rows × columns data, use `run_in_sandbox` with `table(rows)` instead. Use `run_in_sandbox` for charts (ECharts), any table, heavy data manipulation, or anything that needs multi-line logic. Input: `template` (string of markdown with `${...}` interpolations, NOT wrapped in backticks — you write the literal markdown). Available globals inside `${...}`: every data source name from the kickoff manifest, bound as `Array<{...}>`.',
        inputSchema: saveMarkdownActionSchema,
    }),
    validate_echarts: tool({
        description:
            'Coder-only (chart mode). Validates a candidate ECharts option JSON by instantiating a hidden ECharts chart on the host (SSR mode, no DOM) and calling setOption. Returns {ok:true, warnings} on success or {ok:false, error, warnings} listing the first schema/typing problem. Call this BEFORE run_in_sandbox to iterate cheaply on shape — axes, grid indices, series→axis bindings, component types. Cheap and stateless; call as many times as needed.',
        inputSchema: validateEchartsSchema,
    }),
    ask_user: tool({
        description:
            'Ask the user a structured multi-option question. Use this whenever the user\'s request is too vague to commit to a single Action — for example, an open-ended verb ("analyze X", "explore Y") with no specifics about WHICH metrics, WHICH breakdowns, or WHICH output shape. Present 2-6 concrete, mutually-exclusive options derived from what you can infer about their goal; the user clicks one (or types free text if `allowFreeText: true`). The tool returns `{ choiceId, freeText }` — use that to construct a more focused `intent` for the subsequent `work_on_action` call. Do NOT use this for confirmations ("is this correct?") or yes/no questions — those belong to the existing confirmation cards. Required: `question` (one sentence), `options` (2-6 items, each `{id, label, hint?}`), `allowFreeText` (default true).',
        inputSchema: askUserSchema,
    }),
} satisfies ToolSet;

export {
    workOnActionSchema,
    saveDataSourceSchema,
    runInSandboxSchema,
    saveMarkdownActionSchema,
    validateEchartsSchema,
    askUserSchema,
};

export type AgentToolName = keyof typeof agentTools;

/**
 * Per-agent tool subsets. Each agent's prompt + AI-SDK validation see only its
 * own slice. The full `agentTools` object remains as the registry the validator
 * type-checks against.
 */
// The orchestrator is intentionally restricted to action-producing tools.
// Schema exploration / SQL drafting belongs to the Planner sub-agent (see
// `plannerTools`); chat itself can only create or iterate on Actions.
export const orchestratorTools: ToolSet = {
    work_on_action: agentTools.work_on_action,
    ask_user: agentTools.ask_user,
};

export const plannerTools: ToolSet = {
    list_tables: agentTools.list_tables,
    describe_table: agentTools.describe_table,
    data_sample: agentTools.data_sample,
    save_data_source: agentTools.save_data_source,
};

export const coderTools: ToolSet = {
    run_in_sandbox: agentTools.run_in_sandbox,
    save_markdown_action: agentTools.save_markdown_action,
    validate_echarts: agentTools.validate_echarts,
};

export type ToolResult = { ok: true; value: unknown } | { ok: false; error: string };

export type ListTablesResult = { tables: Array<{ name: string; type: string }> };

/**
 * A column in `describe_table` output. Extends the engine's `ColumnInfo`
 * with the optional categorical value set (present only for columns detected
 * as low-cardinality).
 */
export type DescribeColumn = ColumnInfo & {
    /**
     * The complete set of distinct non-null values for a low-cardinality
     * column, fetched from the live data at describe time and sorted.
     * Omitted for high-cardinality columns and for views.
     */
    low_card_values?: Array<string | number>;
    /**
     * Present (true) when this column has an on-device semantic index, so the
     * planner can match it by meaning via `vector_search(...)` (see the
     * table-level `semantic_search` hint) instead of `LIKE`.
     */
    semantic_search?: true;
};

export type DescribeTableResult = {
    table: string;
    type: 'table' | 'view';
    columns: DescribeColumn[];
    foreign_keys: ForeignKey[];
    /**
     * Present only when one or more columns have a semantic index. Lists those
     * columns and the exact SQL shape to use them. Surfaced so the planner
     * reaches for meaning-based matching when the user's intent is fuzzy.
     */
    semantic_search?: { columns: string[]; usage: string };
};

export type DataSampleResult = QueryResult & {
    sql: string;
    /**
     * Always `true` for results returned to the LLM: values are synthetic.
     * Surfaced so the UI and the model can mark/treat sampled rows accordingly.
     */
    sanitized: true;
};

export type ProposePlanResult = { approved: boolean };

export type SaveQueryResult = { saved: SavedQuery };

/**
 * Dispatcher for tool execution. Returns a structured result that the loop
 * appends to the conversation as a `tool` message. `propose_plan` is handled
 * separately by the loop (it waits for user approval), so it's not dispatched
 * here.
 */
export async function executeAgentTool(
    name: string,
    input: unknown,
    sourceId?: string,
): Promise<ToolResult> {
    try {
        switch (name) {
            case 'list_tables':
                return { ok: true, value: await runListTables(sourceId) };
            case 'describe_table': {
                const parsed = describeTableSchema.parse(input);
                return {
                    ok: true,
                    value: await runDescribeTable(parsed.table, sourceId),
                };
            }
            case 'data_sample': {
                const parsed = dataSampleSchema.parse(input);
                return {
                    ok: true,
                    value: await runDataSample(parsed.sql, parsed.limit, sourceId),
                };
            }
            case 'save_query': {
                const parsed = saveQuerySchema.parse(input);
                return { ok: true, value: await runSaveQuery(parsed, sourceId) };
            }
            default:
                return { ok: false, error: `Unknown tool: ${name}` };
        }
    } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
}

async function getDb(sourceId?: string) {
    return await resolveDb(sourceId);
}

async function runListTables(sourceId?: string): Promise<ListTablesResult> {
    const db = await getDb(sourceId);
    const schema = (await db.getSchema()) as TableSchema[];
    return {
        tables: schema
            .filter((t) => !isMetaTable(t.name))
            .map((t) => ({ name: t.name, type: t.type })),
    };
}

async function runDescribeTable(table: string, sourceId?: string): Promise<DescribeTableResult> {
    const db = await getDb(sourceId);
    const schema = (await db.getSchema()) as TableSchema[];
    const entry = schema.find((t) => t.name === table);
    if (!entry || isMetaTable(entry.name)) {
        throw new Error(`No such table or view: ${table}`);
    }
    const foreignKeys =
        entry.type === 'table' ? ((await db.getForeignKeys(table)) as ForeignKey[]) : [];

    // Enumerate the live distinct values of categorical columns so the planner
    // sees real category vocabularies (e.g. status IN ('cancelled', …)). The
    // verdict is computed lazily on first describe — straight off the data, so
    // it works for demos and pre-existing tables, not just file imports — and
    // cached per column. Restricted to base tables: analyzing a view would
    // re-run its (possibly expensive) query once per column.
    let lowCard = new Set<string>();
    if (entry.type === 'table') {
        await ensureCardinalityAnalyzed(
            db,
            table,
            entry.columns.map((c) => c.name),
        );
        lowCard = new Set(await getLowCardColumns(db, table));
    }
    // Columns with an on-device semantic index (built by semantic-index.ts and
    // recorded in _rhvec_search_map). Lets the planner match by meaning via
    // vector_search() rather than LIKE.
    const searchable =
        entry.type === 'table' ? await getSemanticSearchColumns(db, table) : new Set<string>();

    const columns: DescribeColumn[] = [];
    for (const col of entry.columns) {
        const out: DescribeColumn = lowCard.has(col.name)
            ? { ...col, low_card_values: await fetchDistinctValues(db, table, col.name) }
            : { ...col };
        if (searchable.has(col.name)) out.semantic_search = true;
        columns.push(out);
    }

    return {
        table,
        type: entry.type,
        columns,
        foreign_keys: foreignKeys,
        ...(searchable.size > 0
            ? { semantic_search: { columns: [...searchable], usage: SEMANTIC_SEARCH_USAGE } }
            : {}),
    };
}

/**
 * One-line-per-clause instruction telling the planner how to use the semantic
 * index. Returned alongside a table that has searchable columns.
 */
const SEMANTIC_SEARCH_USAGE =
    "Match rows by MEANING (not substring) with vector_search('<table>','<column>','<phrase>', k), " +
    'a table-valued function returning (rowid, distance) for the k nearest rows. ' +
    "JOIN it back on rowid, e.g.: SELECT t.* FROM vector_search('product','name','dogs',20) v " +
    'JOIN product t ON t.rowid = v.rowid ORDER BY v.distance. ' +
    "Lower distance = more relevant. Prefer this over LIKE '%…%' for fuzzy / conceptual queries " +
    '(it finds e.g. "puppy chow" for "dogs"); the phrase is whatever the user is asking about.';

/**
 * Columns of `table` that carry a semantic index, read from the extension's
 * `_rhvec_search_map`. Tolerates the map table not existing (nothing indexed).
 */
async function getSemanticSearchColumns(
    db: Awaited<ReturnType<typeof getDb>>,
    table: string,
): Promise<Set<string>> {
    try {
        const t = table.replace(/'/g, "''");
        const r = await db.execRaw(
            `SELECT base_col FROM _rhvec_search_map WHERE base_tbl='${t}'`,
            500,
        );
        return new Set(r.rows.map((row) => String(row.base_col)));
    } catch {
        return new Set();
    }
}

/**
 * All semantically-indexed columns of the database, in ONE read of
 * `_rhvec_search_map` (vs per-table). Returns table → set of searchable
 * columns. Tolerates the map table not existing (nothing indexed → empty).
 */
async function getAllSemanticSearchMap(
    db: Awaited<ReturnType<typeof getDb>>,
): Promise<Map<string, Set<string>>> {
    const out = new Map<string, Set<string>>();
    try {
        const r = await db.execRaw('SELECT base_tbl, base_col FROM _rhvec_search_map', 1000);
        for (const row of r.rows) {
            const tbl = String(row.base_tbl);
            const col = String(row.base_col);
            if (!out.has(tbl)) out.set(tbl, new Set());
            out.get(tbl)!.add(col);
        }
    } catch {
        // No map table yet → nothing searchable.
    }
    return out;
}

// Front-loaded schema is tiered: a small schema gets full structure
// (columns + types + keys + searchable markers); a large one degrades to a
// table-name list (+ the always-present searchable manifest) so a 200-table
// warehouse doesn't blow the planner's context every turn. low_card_values are
// NEVER front-loaded — that scan stays lazy in describe_table.
const MANIFEST_TABLE_LIMIT = 30;
const MANIFEST_COLUMN_LIMIT = 250;

/**
 * Build the compact schema manifest the orchestrator prepends to the Planner
 * kickoff so it sees the structure — and which columns are semantically
 * searchable — WITHOUT having to call list_tables/describe_table first (the
 * `semantic_search` marker is otherwise undiscoverable unless the model
 * happens to describe the right table). Cheap: sqlite_master + per-table
 * foreign_key_list + one `_rhvec_search_map` read; no value enumeration.
 * Returns '' when the source has no user objects (or can't be read).
 */
export async function buildPlannerSchemaManifest(sourceId?: string): Promise<string> {
    const db = await getDb(sourceId);
    const schema = (await db.getSchema()) as TableSchema[];
    const objects = schema.filter((t) => !isMetaTable(t.name));
    if (objects.length === 0) return '';
    const tables = objects.filter((t) => t.type === 'table');
    const views = objects.filter((t) => t.type === 'view');
    const searchMap = await getAllSemanticSearchMap(db);

    const lines: string[] = [];

    // Searchable columns: ALWAYS front-loaded (tiny + otherwise undiscoverable).
    const searchableList: string[] = [];
    for (const [tbl, cols] of searchMap) {
        for (const col of cols) searchableList.push(`${tbl}.${col}`);
    }
    if (searchableList.length > 0) {
        lines.push(
            `Semantic search is available — match these columns by MEANING (not LIKE): ${searchableList.join(', ')}.`,
        );
        lines.push(SEMANTIC_SEARCH_USAGE);
        lines.push('');
    }

    const totalCols = tables.reduce((n, t) => n + t.columns.length, 0);
    const full = tables.length <= MANIFEST_TABLE_LIMIT && totalCols <= MANIFEST_COLUMN_LIMIT;

    if (full) {
        lines.push('Tables:');
        for (const t of tables) {
            const fks = (await db.getForeignKeys(t.name)) as ForeignKey[];
            const fkByCol = new Map(fks.map((f) => [f.column, `${f.refTable}.${f.refColumn}`]));
            const searchableCols = searchMap.get(t.name);
            const cols = t.columns.map((c) => {
                const parts = [`${c.name}:${c.type || '?'}`];
                if (c.pk) parts.push('PK');
                const fk = fkByCol.get(c.name);
                if (fk) parts.push(`→${fk}`);
                if (searchableCols?.has(c.name)) parts.push('[search]');
                return parts.join(' ');
            });
            lines.push(`  ${t.name}(${cols.join(', ')})`);
        }
    } else {
        lines.push(
            `Tables (${tables.length}) — large schema, names only; call describe_table for columns:`,
        );
        lines.push(`  ${tables.map((t) => t.name).join(', ')}`);
    }
    if (views.length > 0) {
        lines.push('');
        lines.push(
            `Views: ${views.map((v) => v.name).join(', ')} (call describe_table for columns).`,
        );
    }
    lines.push('');
    lines.push(
        "Call describe_table(<table>) for a column's real category values (low_card_values) before writing WHERE/CASE against them.",
    );
    return lines.join('\n');
}

/**
 * Read the distinct non-null values of one (already known to be
 * low-cardinality) column, sorted. Capped at `LOW_CARD_MAX_DISTINCT` as a
 * defensive bound — by construction a marked column has at most that many.
 */
async function fetchDistinctValues(
    db: Awaited<ReturnType<typeof getDb>>,
    table: string,
    column: string,
): Promise<Array<string | number>> {
    const t = table.replace(/"/g, '""');
    const c = column.replace(/"/g, '""');
    // execFull (not execQuery): read-only, but without execQuery's hard 20-row
    // cap — a low-cardinality column can hold up to LOW_CARD_MAX_DISTINCT values.
    const res = await db.execFull(
        `SELECT DISTINCT "${c}" AS v FROM "${t}" WHERE "${c}" IS NOT NULL ORDER BY "${c}"`,
        LOW_CARD_MAX_DISTINCT,
    );
    return res.rows
        .map((r) => r.v)
        .filter((v): v is string | number => typeof v === 'string' || typeof v === 'number');
}

async function runDataSample(
    sql: string,
    limit?: number,
    sourceId?: string,
): Promise<DataSampleResult> {
    const db = await getDb(sourceId);
    const raw = (await db.execQuery(sql, limit ?? 20)) as QueryResult;
    // Rename non-identifier / reserved-word column names to `colN` BEFORE
    // sanitization. The Planner sees the same names here that it will see
    // in the save_data_source result and in the Coder's bound globals.
    const normalized = normalizeQueryResultColumns(raw);
    const sanitized = getActiveSanitizer().sanitize(normalized);
    return { ...sanitized, sql, sanitized: true };
}

async function runSaveQuery(input: SavedQuery, sourceId?: string): Promise<SaveQueryResult> {
    const db = await getDb(sourceId);
    const validation = await db.validateQuery(input.sql);
    if (!validation.ok) {
        throw new Error(`Refusing to save invalid SQL: ${validation.error}`);
    }
    return { saved: input };
}

/**
 * Shape the plan input passed into `propose_plan` for UI rendering.
 */
export function planFromToolInput(input: unknown): PlanInput {
    return planSchema.parse(input);
}

export function savedQueryFromToolInput(input: unknown): SavedQuery {
    return saveQuerySchema.parse(input);
}
