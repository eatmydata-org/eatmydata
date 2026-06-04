import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { resolveDb } from '@/lib/data-sources/resolver';
import { isMetaTable } from '@/lib/data-sources/db';
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
            'Return the columns (name, type, nullability, primary-key flag) and foreign-key relationships of one table.',
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
            'Coder-only. Submits a candidate code step for the Action. The runtime: (1) runs the JS inside a QuickJS sandbox with the data sources bound as named globals; (2) if it throws, returns the error + your code listing so you can fix and retry; (3) if it runs without throwing, the runtime AUTOMATICALLY presents the code to the user for approval (Execute / Save+Execute / Cancel). On user Cancel you may revise and call again. Input: `code` (a string of JS that assigns the final value to `__output`). The output format (markdown, JSON, ECharts spec) is inferred from the shape of `__output` at execution time — do not specify it. The sandbox is stateless between calls.',
        inputSchema: runInSandboxSchema,
    }),
    save_markdown_action: tool({
        description:
            'Coder-only. Final ANSWER for textual analyses. Submits a markdown TEMPLATE — plain markdown with JS-template-literal `${expr}` interpolations against the bound data sources. Cheaper than `run_in_sandbox` when the answer is mostly prose/tables with a few computed values: no code wrapping, no per-line JS. The runtime: (1) wraps your template as `__output = \\`<template>\\`` and runs it inside QuickJS to validate every `${expr}`; (2) if it throws, returns the error so you can fix and retry; (3) if it runs without throwing, the runtime AUTOMATICALLY presents the code to the user for approval (Execute / Save+Execute / Cancel). Choose THIS tool over `run_in_sandbox` whenever the user asked for a textual/markdown answer and the computation is light (a few totals, counts, percentages). Use `run_in_sandbox` for charts (ECharts), heavy data manipulation, or anything that needs multi-line logic. Input: `template` (string of markdown with `${...}` interpolations, NOT wrapped in backticks — you write the literal markdown). Available globals inside `${...}`: every data source name from the kickoff manifest, bound as `Array<{...}>`.',
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

export type DescribeTableResult = {
    table: string;
    type: 'table' | 'view';
    columns: ColumnInfo[];
    foreign_keys: ForeignKey[];
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
    return {
        table,
        type: entry.type,
        columns: entry.columns,
        foreign_keys: foreignKeys,
    };
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
