import { SEMANTIC_LAYER_MARKER, currentDateLine } from '../prompt';
import { resolveAgentModelId } from '../models';
import { executeAgentTool, plannerTools, saveDataSourceSchema, type AgentToolName } from '../tools';
import type { AgentDefinition, AgentRunCtx, OnIdleTurn, ToolExecutor } from '../agent-def';
import type { SavedDataSourcePreview } from '@/lib/types';
import { resolveDb } from '@/lib/data-sources/resolver';
import { getActiveSanitizer } from '../sample-sanitizer';
import {
    normalizeQueryResultColumns,
    toPascalCase,
    tsFromQueryResult,
} from '@/lib/sqlite/ts-from-columns';
import type { QueryResult } from '@/lib/wa-sqlite/types';
import { pushDataSources } from '@/lib/runtime/state/drafts';

const STATE_KEY = 'planner';

type PlannerState = {
    drafts: SavedDataSourcePreview[];
    draftId?: string;
    /**
     * True when the kickoff seeded the run with previous data sources
     * from a rejected draft. The idle-turn hook uses this to decide
     * whether "I touched nothing" is a valid hand-off (rework: yes, the
     * existing set still answers some part of the intent) or a silent
     * failure (cold start: no — the model needs a nudge).
     */
    seededFromPriorDraft: boolean;
    /**
     * Counter for the "no drafts saved yet" idle-turn nudges. Capped so
     * a model stuck in text-only mode eventually exits cleanly instead
     * of looping forever.
     */
    emptyIdleRetries: number;
};

function getPlannerState(ctx: AgentRunCtx): PlannerState {
    const existing = ctx.runState[STATE_KEY] as PlannerState | undefined;
    if (existing) return existing;
    const kickoff = ctx.runState.kickoff as
        | {
              draftId?: string;
              existingPreviews?: SavedDataSourcePreview[];
          }
        | undefined;
    const existingPreviews = kickoff?.existingPreviews ?? [];
    // Pre-seed the drafts with the existing previews from the rejected
    // draft. The model can then overwrite a source by re-saving its
    // name (the executor dedupes by name) or leave it untouched to
    // keep it in the hand-off. This is what makes a replan an EXTEND
    // operation rather than a cold restart.
    const fresh: PlannerState = {
        drafts: existingPreviews.map((p) => ({ ...p })),
        draftId: kickoff?.draftId,
        seededFromPriorDraft: existingPreviews.length > 0,
        emptyIdleRetries: 0,
    };
    ctx.runState[STATE_KEY] = fresh;
    return fresh;
}

/**
 * The orchestrator stuffs the action's `dataSourceId` into the planner's
 * kickoff context. We read it here so every DB call inside the planner
 * (and its wrapped tools) is scoped to the right source.
 */
function activeSourceId(ctx: AgentRunCtx): string | undefined {
    const kickoff = ctx.runState.kickoff as { dataSourceId?: string } | undefined;
    return kickoff?.dataSourceId;
}

const saveDataSourceExecutor: ToolExecutor = async (input, ctx) => {
    const parsed = saveDataSourceSchema.parse(input);
    try {
        const sourceId = activeSourceId(ctx);
        const db = await resolveDb(sourceId);
        const validation = await db.validateQuery(parsed.query);
        if (!validation.ok) {
            throw new Error(validation.error ?? 'invalid SQL');
        }
        const raw = (await db.execQuery(parsed.query, 20)) as QueryResult;
        // Rename non-identifier / reserved-word column names to `colN`
        // BEFORE sanitization + type generation, so the persisted preview,
        // the type declaration the Coder sees, and the rows it receives at
        // runtime all use the same keys. Without this, an unaliased
        // expression like `AVG(foo)` would produce a TS field
        // `"AVG(foo)": number` that the Coder can only access via bracket
        // notation, while the sandbox global is bound the same way.
        const normalized = normalizeQueryResultColumns(raw);
        const sanitized = getActiveSanitizer().sanitize(normalized);
        const ts = tsFromQueryResult(sanitized, toPascalCase(parsed.name), parsed.name);
        const preview: SavedDataSourcePreview = {
            name: parsed.name,
            query: parsed.query,
            semanticDescription: parsed.semantic_description,
            typeDeclaration: ts.source,
            sampleColumns: sanitized.columns,
            sampleRows: sanitized.rows,
            truncated: sanitized.truncated,
        };
        const state = getPlannerState(ctx);
        const idx = state.drafts.findIndex((d) => d.name === preview.name);
        if (idx >= 0) state.drafts[idx] = preview;
        else state.drafts.push(preview);
        ctx.controls.updatePart(ctx.stepId, ctx.toolCallId, {
            status: 'ok',
            preview,
        });
        if (state.draftId) {
            pushDataSources(state.draftId, [...state.drafts]);
        }
        const rowsReturned = sanitized.rows.length;
        const warning =
            rowsReturned === 0
                ? 'WARNING: this SQL returned ZERO rows against the seeded data. Your WHERE clauses, JOINs, or filter values are likely wrong. Revise the SQL and call save_data_source again with the same `name` to overwrite.'
                : undefined;
        return {
            ok: true,
            value: {
                saved: true,
                name: preview.name,
                columns: sanitized.columns,
                rowsReturnedByQuery: rowsReturned,
                truncatedAt20: sanitized.truncated,
                typeDeclaration: ts.source,
                next_action:
                    'Save more sources if the action needs them, or respond with a short text to hand the current set off to the Coder.',
                ...(warning ? { warning } : {}),
            },
        };
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        ctx.controls.updatePart(ctx.stepId, ctx.toolCallId, {
            status: 'error',
            error: message,
        });
        return { ok: false, error: message };
    }
};

const wrap =
    (name: AgentToolName): ToolExecutor =>
    async (input, ctx) =>
        executeAgentTool(name, input, activeSourceId(ctx));

const MAX_EMPTY_IDLE_RETRIES = 2;

/**
 * Fires when the LLM responds with text and no tool calls. Treats that as
 * "I'm done planning." The drafts are handed off to the Coder directly —
 * there's no user gate. If a draft has zero rows we force a revision pass.
 *
 * Empty-drafts handling:
 *  - Cold start (no prior draft seeded into the kickoff): nudge the model
 *    once or twice before giving up. The previous "exit silently on
 *    drafts.length === 0" behavior caused a real failure where the model
 *    called list_tables once, then produced a non-tool text turn (often
 *    an explanation/refusal), and the run terminated with no diagnostic.
 *    A nudge converts that into either real work or an explicit ABORT.
 *  - Replan from a seeded draft: empty drafts means the model decided not
 *    to touch ANY existing source. That's a legitimate hand-off — the
 *    previous set already answers the new intent — and we exit cleanly,
 *    handing the seeded set off to the Coder.
 */
const onIdleTurn: OnIdleTurn = async (ctx) => {
    const state = getPlannerState(ctx);
    if (state.drafts.length === 0) {
        if (state.emptyIdleRetries >= MAX_EMPTY_IDLE_RETRIES) {
            // Give up — the model isn't going to save anything. The
            // spawner reports `planner-empty` and the orchestrator
            // tells the user via ask_user.
            return { continue: false };
        }
        state.emptyIdleRetries += 1;
        return {
            continue: true,
            feedbackForLLM:
                "You responded with text but have not saved any data source yet. Call `list_tables` / `describe_table` to explore the schema, then `save_data_source({name, query, semantic_description})` for each candidate. If the schema genuinely cannot support the user's intent, respond with text beginning with `ABORT:` followed by one short sentence and the run will exit cleanly.",
        };
    }
    const zeroRow = state.drafts.filter((d) => d.sampleRows.length === 0);
    if (zeroRow.length > 0) {
        return {
            continue: true,
            feedbackForLLM: `Cannot hand off the data sources: ${zeroRow
                .map((d) => `\`${d.name}\``)
                .join(
                    ', ',
                )} returned ZERO rows. Either revise the SQL by calling save_data_source again with the same name, or drop the source. After fixing, respond with text again to retry hand-off.`,
        };
    }
    ctx.runState.finalResult = state.drafts;
    return { continue: false };
};

export function plannerAgent(): AgentDefinition {
    return {
        id: 'planner',
        name: 'Data Planner',
        systemPrompt: buildPlannerPrompt(),
        modelId: resolveAgentModelId('planner'),
        tools: plannerTools,
        toolExecutors: {
            list_tables: wrap('list_tables'),
            describe_table: wrap('describe_table'),
            data_sample: wrap('data_sample'),
            save_data_source: saveDataSourceExecutor,
        },
        onIdleTurn,
    };
}

function buildPlannerPrompt(): string {
    return `${currentDateLine()}

You are the Data Source Planner. Your job is to turn the user's intent into a small set of named, deterministic SQL queries that another agent will later run against the real database. You have NO prior knowledge of what the data represents — infer the domain entirely from table and column names returned by the tools.

You can — and often SHOULD — produce MORE THAN ONE data source. The Coder receives every source you save as a separate array of rows bound on globalThis, and can correlate them in JS (joins, lookups, ratios) and render them as separate cards in a multi-chart dashboard. There is no penalty for additional sources: the user sees them as named building blocks and they make the Action easier to refine later.

Default to one source per distinct SHAPE / GRAIN / DIMENSIONALITY, rather than one giant query. Concrete cues that you should SPLIT into multiple sources:
- The answer needs more than two dimensions to be meaningful (e.g. revenue by month AND by region AND by product) — emit one source per breakdown instead of cross-joining everything into a single wide table with combinatorial rows. Wide cross-joins inflate result size, lose the natural grain of each breakdown, and force the Coder to un-pivot before it can chart anything.
- The user wants both an aggregate and a breakdown (e.g. "total revenue this quarter, and top 10 customers within it") — that's two sources: one scalar/summary, one ranked list.
- The user wants different metrics with different natural grains (e.g. daily order counts AND per-customer lifetime value) — two sources.
- The user wants a headline number AND a trend AND a breakdown — three sources, each tight and focused.
- You're tempted to UNION two queries with different column meanings, or to GROUP BY several unrelated dimensions at once via \`GROUPING SETS\` / \`ROLLUP\` — almost always cleaner as separate sources.

Prefer narrow, focused queries: each source answers one question at one grain, with stable column names. Avoid stuffing every possible filter, every possible aggregate, and every possible breakdown into one mega-query "just in case" — that produces an awkward shape the Coder has to unwrap, and obscures the user's mental model of what data was actually fetched.

When in doubt, lean toward MORE sources rather than fewer.

${SEMANTIC_LAYER_MARKER}

TOOL CALLING
Use the function-calling tools provided by the runtime.

WORKFLOW
1. **Read the schema in your kickoff.** Your kickoff message lists every table, its columns/types/keys, and which columns are semantically searchable — so you do NOT need \`list_tables\`. Call \`describe_table(<table>)\` only when you need a column's real category values (\`low_card_values\`) to write a correct WHERE/CASE, or for a table that a large-schema manifest listed by name only.
2. **Optionally test queries with \`data_sample\`.** It runs a read-only SELECT and returns up to 20 PERTURBED rows so you can verify column types, joins, and shape before committing — category names are synthetic aliases, frequencies are flattened, numerics are noised, and columns are independently shuffled, so never reason about values, frequencies, or row-level associations. Use it when uncertain — not for every candidate.
3. **Save each candidate with \`save_data_source({name, query, semantic_description})\`.** Iterate as needed: you can save sources one at a time, in any order, and re-save with the same name to overwrite. The runtime validates the SQL, runs it against the seeded data to verify shape, and stores a draft.
4. **When you're done saving, simply respond with a short text message** (no more tool calls). The runtime takes that as your "I'm done" signal and hands the full draft set straight to the Coder. There is NO separate finalize tool to call and NO user approval step.
5. If the runtime feeds back a problem (e.g. a draft with zero rows), revise (save_data_source again, then respond with text again).

REPLAN MODE (when the kickoff message lists existing data sources)
- The kickoff will EXPLICITLY label itself a REPLAN and show you the existing sources (name, columns, SQL) plus the previous code step. The user rejected a previous candidate and asked for something the existing sources cannot answer — read the new intent for what is still MISSING.
- The existing sources are ALREADY seeded into your drafts. If you do nothing they will be handed off to the Coder unchanged. So: only \`save_data_source\` to ADD a new source, or to REPLACE one (re-save with the same name and a different SQL).
- Reuse names where the SQL is unchanged. The Coder's previous code references those names — keeping them stable lets the Coder edit minimally instead of rewriting from scratch.
- Skip schema exploration for tables you already used in the existing sources — those columns are known from the previous run. Only call \`list_tables\` / \`describe_table\` for new tables you need.
- Hand off promptly. Once the new intent is covered, respond with a short text message. Do not re-justify the existing set.

SEMANTIC SEARCH — match free text by meaning, not by substring
Sampled values of high-cardinality TEXT columns are MASKED: you cannot read them or verify a text filter from a sample, so never permute \`LIKE '%…%'\` to "find" matches. When \`describe_table\` marks a column \`"semantic_search": true\`, match it with \`vector_search\`, not \`LIKE\`:

  -- conceptual match (finds "puppy chow" for "dogs") — NOT  WHERE name LIKE '%dog%'
  SELECT t.* FROM vector_search('product','name','dogs',20) v
  JOIN product t ON t.rowid = v.rowid ORDER BY v.distance;

\`vector_search(table, col, phrase, k)\` returns \`(rowid, distance)\`, lower = more relevant. You CAN read \`distance\` even though the matched text stays masked — trust the ranking and hand off.

RULES
- Source names MUST be unique within an action AND valid JavaScript identifiers (snake_case, no leading digit).
- Every output column must be a valid JS identifier (and not a reserved word). Computed columns without an alias — e.g. \`AVG(x)\`, \`x+1\`, \`COUNT(*)\` — are auto-renamed to \`col0\`, \`col1\`, … in the saved type. Use \`AS alias\` whenever you want a stable, meaningful name the Coder can reference.
- Each query MUST be deterministic and complete on its own — no placeholders, no references between queries.
- Zero rows = wrong query. \`save_data_source\` warns when a query returns 0 rows. The runtime will block hand-off while any draft has 0 rows — revise or drop those sources before responding with text.
- If you genuinely have no usable queries (e.g. the requested data doesn't exist in this schema), respond with text beginning with \`ABORT:\` followed by a one-line reason; the run will exit cleanly and the orchestrator surfaces the message to the user.
`;
}
