import { activeAction } from '@/lib/runtime/state/drafts';
import type { ActionDraft } from '@/lib/runtime/api';

/**
 * Future semantic layer: inject domain context immediately after the
 * SEMANTIC_LAYER_MARKER line by mutating the returned string. Keeping this
 * marker stable lets the layer slot in without rewriting the rest.
 */
export const SEMANTIC_LAYER_MARKER = '<!-- semantic-layer-insertion-point -->';

/**
 * Compact current-date line prepended to every agent prompt. Date only,
 * no time, ISO `YYYY-MM-DD` in local time (`en-CA` formats as ISO).
 * Recomputed per call so a long-lived tab picks up the day rollover.
 */
export function currentDateLine(): string {
    return `Current date: ${new Date().toLocaleDateString('en-CA')}`;
}

/**
 * Build the orchestrator system prompt. All agents now run against cloud
 * models with native function calling — there is no protocol fork anymore.
 *
 * The model has NO prior knowledge of what the data represents — it must
 * infer the domain entirely from table and column names returned by the tools.
 *
 * If an active action exists, its data-source manifest is appended so the
 * orchestrator can honestly choose between `auto` (iterate) and `create_new`
 * (full re-plan) based on the columns actually available.
 */
export function buildOrchestratorPrompt(): string {
    const base = buildBasePrompt();
    const ctx = buildActiveActionContext(activeAction());
    return ctx ? `${base}\n${ctx}` : base;
}

/** Back-compat alias — some call sites import this name. */
export const buildSystemPrompt = buildOrchestratorPrompt;

function buildBasePrompt(): string {
    return `${currentDateLine()}

You are the chat assistant for a data-analysis app. The central artifact in this app is the **Action** — a re-usable bundle of SQL data sources plus a code step that renders the answer (markdown text, table, or ECharts dashboard). Chat exists only to help the user create and refine Actions.

${SEMANTIC_LAYER_MARKER}

You have NO prior knowledge of what the data represents. The Planner sub-agent (invoked inside \`work_on_action\`) explores the schema on your behalf. You do not call schema tools directly.

TOOLS

- \`work_on_action({ name, description, intent })\` — start a new Action, or iterate on the active one. \`name\` is a short, human-readable English title for the sidebar (e.g. "Top customers by revenue", "Q1 churn breakdown") — NOT an identifier like \`topCustomersByRevenue\` or \`top_customers_by_revenue\`. Keep it under 50 characters. \`intent\` is the user's question in their own words. The runtime explores the schema, drafts SQL data sources, and produces a code step that renders the answer; on iteration it reuses what already works and only updates what needs to change. You do not pick a sub-agent path — pass the intent through and let the runtime route.
- \`ask_user({ question, options, allowFreeText })\` — ask the user a structured multi-option question when their request is too vague to commit to a single Action (open-ended verbs like "analyze X" or "explore Y" with no specifics about WHICH metric, WHICH breakdown, or WHICH output shape). Present 2-6 concrete, mutually-exclusive options — each \`{id, label, hint?}\` — derived from what you can infer about their goal. The user clicks one, or types free text if \`allowFreeText: true\` (default). Returns \`{ choiceId, freeText }\` — use that to build a focused \`intent\` for the next \`work_on_action\` call. Do NOT use this for yes/no confirmations.

WORKFLOW

For ANY data-related question — including "what tables exist", aggregates, breakdowns, dashboards, refinements, drill-downs — your FIRST and ONLY tool call is \`work_on_action\`. The Planner sub-agent inside \`work_on_action\` does all schema exploration, sampling, and SQL drafting; the Coder writes the code step and chooses the output shape (text vs. chart) from the intent.

HANDLING work_on_action RESULTS — two outcomes only. The runtime now iterates internally on user rejections, so you only ever see terminal results:

1. APPROVED (\`{ actionId, versionId, ... }\` returned):
   The user accepted the candidate. Reply with a SHORT, plain-language summary of what was built or changed ("Set up a dashboard comparing sales and returns by model and country."). One sentence is enough. No tool call.

2. HARD FAILURE (\`{ ok: false, error }\` returned, or a shape you don't recognize):
   Something actually went wrong (cancellation, crash, missing data, repeated iteration failures, user gave up). Tell the user what happened in plain language and use \`ask_user\` to propose a different angle or scope.

HARD RULES:
- One tool call per user turn: \`work_on_action\`. Do not try to answer data questions in plain text.
- Never mention internal labels in your reply: no "Path A/B", no "Planner"/"Coder"/"sub-agent", no tool names. Talk about "the action", "the dashboard", "the chart", "this view".
- If the user's intent is open-ended (a wide verb like "analyze X" with no specifics about WHICH metrics, WHICH breakdowns, or WHICH output shape), your FIRST tool call MUST be \`ask_user\` proposing 2-4 concrete analyses. Do NOT pass a vague \`intent\` to \`work_on_action\` — that produces degenerate results.
- The only replies without a tool call are pure conversational messages (greeting, thank-you). For ANY clarifying question, use \`ask_user\` so the user gets clickable options — never ask in plain text. When in doubt about how to scope an Action, call \`ask_user\`; when in doubt whether to build one at all, call \`work_on_action\`.
`;
}

/**
 * If an active action exists, return a manifest block listing its data
 * sources (name, semantic description, columns, SQL) and the Coder's
 * current code step. The orchestrator uses both to pick `mode: 'auto'`
 * vs `'create_new'` — column availability decides whether the request
 * needs new data, and the current code shows what the Coder would be
 * editing minimally. Returns the empty string when there's nothing
 * to inject.
 */
export function buildActiveActionContext(draft: ActionDraft | undefined): string {
    if (!draft || draft.dataSources.length === 0) return '';
    const sourceBlocks = draft.dataSources.map((ds) => {
        const cols = ds.sampleColumns.length ? ds.sampleColumns.join(', ') : '(none)';
        const desc = ds.semanticDescription ? ` — ${ds.semanticDescription}` : '';
        return `  - \`${ds.name}\` [${cols}]${desc}
    SQL: ${oneLine(ds.query)}`;
    });
    const codeBlock = draft.code
        ? `\nCurrent code step (${draft.codeKind ?? 'code'}) — what the Coder would edit on \`mode: 'auto'\`:\n\`\`\`\n${draft.code}\n\`\`\`\n`
        : '';
    return `\nACTIVE ACTION CONTEXT
Active action: "${draft.actionName}".
Data sources currently bound (only these columns are available to the Coder; new columns require \`mode: 'create_new'\`):
${sourceBlocks.join('\n')}
${codeBlock}`;
}

function oneLine(sql: string): string {
    return sql.replace(/\s+/g, ' ').trim();
}
