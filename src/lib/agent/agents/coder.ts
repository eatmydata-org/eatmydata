import { SEMANTIC_LAYER_MARKER, currentDateLine } from '../prompt';
import { resolveAgentModelId } from '../models';
import { coderTools, runInSandboxSchema, saveMarkdownActionSchema } from '../tools';
import type { AgentDefinition, AgentRunCtx, OnIdleTurn, ToolExecutor } from '../agent-def';
import type { SavedDataSourcePreview } from '@/lib/types';
import { runInSandbox } from '@/lib/sandbox/runtime';
import { wrapMarkdownTemplate } from '@/lib/actions/executor';
import { validateEchartsOption } from '../echarts-validate';
import { ECHARTS_TOP_LEVEL_KEYS } from '@/lib/echarts/shape';
import { pushCode } from '@/lib/runtime/state/drafts';

const STATE_KEY = 'coder';

type CoderState = {
    dataSources: SavedDataSourcePreview[];
    draftId?: string;
};

function getCoderState(ctx: AgentRunCtx): CoderState {
    const existing = ctx.runState[STATE_KEY] as CoderState | undefined;
    if (existing) return existing;
    const kickoff = ctx.runState.kickoff as
        | { dataSources?: SavedDataSourcePreview[]; draftId?: string }
        | undefined;
    const fresh: CoderState = {
        dataSources: kickoff?.dataSources ?? [],
        draftId: kickoff?.draftId,
    };
    ctx.runState[STATE_KEY] = fresh;
    return fresh;
}

function buildSandboxGlobals(state: CoderState): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const ds of state.dataSources) {
        out[ds.name] = ds.sampleRows;
    }
    return out;
}

/**
 * Code finalization path. The Coder writes JS that assigns to `__output`;
 * the runtime validates it under QuickJS using the data-source samples,
 * then returns the candidate to the orchestrator. The user's thumbs-up /
 * thumbs-down review now happens at the orchestrator layer once the
 * candidate has been executed against real data — there is no per-tool
 * approval card here.
 */
const runInSandboxExecutor: ToolExecutor = async (input, ctx) => {
    const parseResult = runInSandboxSchema.safeParse(input);
    if (!parseResult.success) {
        return {
            ok: false,
            error: formatInputError(
                'run_in_sandbox',
                input,
                parseResult.error.issues,
                'Required: `code` (string of JS that assigns the final value to `__output`). No other fields.',
            ),
        };
    }
    const parsed = parseResult.data;
    const state = getCoderState(ctx);
    if (state.dataSources.length === 0) {
        return {
            ok: false,
            error: 'No data sources are available in the Coder run state; the planner kickoff did not seed any.',
        };
    }

    const result = await runInSandbox({
        code: parsed.code,
        globals: buildSandboxGlobals(state),
    });
    if (!result.ok) {
        if (state.draftId) {
            pushCode(state.draftId, parsed.code, 'rejected', 'code');
        }
        return {
            ok: false,
            error: formatSandboxError(result, parsed.code),
        };
    }

    if (state.draftId) {
        pushCode(state.draftId, parsed.code, 'approved', 'code');
    }
    ctx.runState.finalResult = {
        kind: 'code',
        code: parsed.code,
    };
    return {
        ok: true,
        value: { finalized: true },
        terminate: true,
    };
};

/**
 * Markdown finalization path. The model submits a markdown template; the
 * runtime wraps it as `__output = \`<template>\`;` and runs it through the
 * SAME QuickJS sandbox so every `${expr}` is validated against the real
 * data-source globals. On success the candidate is returned to the
 * orchestrator for thumbs-up review.
 */
const saveMarkdownActionExecutor: ToolExecutor = async (input, ctx) => {
    const parseResult = saveMarkdownActionSchema.safeParse(input);
    if (!parseResult.success) {
        return {
            ok: false,
            error: formatInputError(
                'save_markdown_action',
                input,
                parseResult.error.issues,
                'Required: `template` (a markdown string; you may embed `${expr}` interpolations referencing the data-source globals). No other fields.',
            ),
        };
    }
    const parsed = parseResult.data;
    const state = getCoderState(ctx);
    if (state.dataSources.length === 0) {
        return {
            ok: false,
            error: 'No data sources are available in the Coder run state; the planner kickoff did not seed any.',
        };
    }

    const wrapped = wrapMarkdownTemplate(parsed.template);

    const result = await runInSandbox({
        code: wrapped,
        globals: buildSandboxGlobals(state),
    });
    if (!result.ok) {
        if (state.draftId) {
            pushCode(state.draftId, parsed.template, 'rejected', 'markdown');
        }
        return {
            ok: false,
            error: formatSandboxError(result, wrapped),
        };
    }

    if (state.draftId) {
        pushCode(state.draftId, parsed.template, 'approved', 'markdown');
    }
    ctx.runState.finalResult = {
        kind: 'markdown',
        template: parsed.template,
    };
    return {
        ok: true,
        value: { finalized: true },
        terminate: true,
    };
};

/**
 * Accept either `{ option: <obj|array> }` (the documented shape) or the
 * option fields at the top level (some models drop the wrapper), or a bare
 * array of options (the multi-chart dashboard form). Returns null when the
 * input isn't usable. Empty `{}` is accepted on purpose — the model was
 * burning ~10 retries on the same input_validation_error; passing it
 * through gives ECharts a chance to return a more actionable signal.
 */
function unwrapEchartsOption(
    input: unknown,
): Record<string, unknown> | Array<Record<string, unknown>> | null {
    if (Array.isArray(input)) {
        return isOptionArray(input) ? input : null;
    }
    if (!input || typeof input !== 'object') return null;
    const obj = input as Record<string, unknown>;
    const wrapped = obj.option;
    if (Array.isArray(wrapped)) {
        return isOptionArray(wrapped) ? wrapped : null;
    }
    if (wrapped && typeof wrapped === 'object' && !Array.isArray(wrapped)) {
        return wrapped as Record<string, unknown>;
    }
    const hasTopLevelOptionKeys = Object.keys(obj).some((k) => ECHARTS_TOP_LEVEL_KEYS.has(k));
    if (hasTopLevelOptionKeys || Object.keys(obj).length === 0) {
        return obj;
    }
    return null;
}

function isOptionArray(arr: unknown[]): arr is Array<Record<string, unknown>> {
    if (arr.length === 0) return false;
    return arr.every((el) => !!el && typeof el === 'object' && !Array.isArray(el));
}

const validateEchartsExecutor: ToolExecutor = async (input) => {
    const option = unwrapEchartsOption(input);
    if (!option) {
        return {
            ok: false,
            error: formatInputError(
                'validate_echarts',
                input,
                [
                    {
                        path: ['option'],
                        message: 'expected an ECharts option object or an array of option objects',
                    },
                ],
                'Required: an ECharts option object OR an array of option objects (one per chart in a multi-chart dashboard). You may pass it as `{ option: { xAxis, yAxis, series } }`, `{ option: [{...}, {...}] }`, send the option fields at the top level, or send a bare array.',
            ),
        };
    }
    const result = await validateEchartsOption(option);
    if (!result.ok) {
        // Surface the ECharts error verbatim plus any collected warnings.
        // The model needs the exact wording to fix its option shape.
        const warningLines = result.warnings.map((w) => `  - ${oneLine(w)}`).join('\n');
        const warnings = result.warnings.length ? `\nwarnings:\n${warningLines}` : '';
        return {
            ok: false,
            error: `echarts_validation_error: ${oneLine(result.error)}${warnings}`,
        };
    }
    return {
        ok: true,
        value: { warnings: result.warnings },
    };
};

type SandboxFailure = Extract<Awaited<ReturnType<typeof runInSandbox>>, { ok: false }>;

/**
 * LLM-friendly error formatter. Outputs a small structured header (parseable
 * if needed) followed by a focused code snippet rather than the full source.
 * Distinguishes between phases so the LLM can tell whether its code is at
 * fault.
 */
function formatSandboxError(result: SandboxFailure, code: string): string {
    if (result.phase === 'parse') {
        return [
            'sandbox_error:',
            `  phase: parse`,
            `  message: ${result.error}`,
            '',
            'Your code has a SYNTAX error QuickJS could not recover from (unterminated string, missing brace, etc.). Reread the code character-by-character before retrying. Your code:',
            withGutter(code),
        ].join('\n');
    }

    // user-code runtime error
    const lineNum = result.line;
    const window = lineNum ? sliceWindow(code, lineNum, 4) : withGutter(code);
    const header = [
        'sandbox_error:',
        `  phase: user-code`,
        `  message: ${result.error}`,
        lineNum ? `  line: ${lineNum}` : `  line: (unknown)`,
    ];
    if (result.stack) header.push(`  stack: ${oneLine(result.stack)}`);
    return [
        ...header,
        '',
        lineNum ? `Code around the throwing line (>>> marks line ${lineNum}):` : 'Your code:',
        window,
        '',
        'Fix the line that threw and call run_in_sandbox again.',
    ].join('\n');
}

function withGutter(code: string): string {
    return code
        .split('\n')
        .map((line, i) => `${String(i + 1).padStart(4, ' ')} | ${line}`)
        .join('\n');
}

function sliceWindow(code: string, line: number, radius: number): string {
    const lines = code.split('\n');
    const start = Math.max(0, line - 1 - radius);
    const end = Math.min(lines.length, line + radius);
    return lines
        .slice(start, end)
        .map((src, i) => {
            const ln = start + i + 1;
            const marker = ln === line ? '>>>' : '   ';
            return `${marker} ${String(ln).padStart(4, ' ')} | ${src}`;
        })
        .join('\n');
}

function oneLine(s: string): string {
    return s.replace(/\s+/g, ' ').trim().slice(0, 240);
}

type ZodIssue = { path: PropertyKey[]; message: string };

/**
 * Format a tool-input validation failure into a focused message the LLM can
 * act on. The raw ZodError JSON is too noisy and tends to repeat itself — we
 * lead with what's missing and remind the model of the schema.
 */
function formatInputError(
    toolName: string,
    input: unknown,
    issues: ZodIssue[],
    schemaReminder: string,
): string {
    const summarized = issues
        .slice(0, 5)
        .map((iss) => {
            const path = iss.path.length ? iss.path.join('.') : '(root)';
            return `  - ${path}: ${iss.message}`;
        })
        .join('\n');
    return [
        `input_validation_error: ${toolName} received malformed input.`,
        'issues:',
        summarized,
        '',
        schemaReminder,
        '',
        `Received: ${safeStringify(input)}`,
        '',
        'Retry the call with all required fields populated.',
    ].join('\n');
}

function safeStringify(x: unknown): string {
    try {
        const s = JSON.stringify(x);
        return s.length > 240 ? `${s.slice(0, 237)}...` : s;
    } catch {
        return String(x);
    }
}

export type CoderKickoffContext = {
    dataSources: SavedDataSourcePreview[];
    intent: string;
};

const MAX_IDLE_RETRIES = 2;

/**
 * Fires when the Coder model responds with text and no tool calls. The Coder
 * has no "I'm done" signal — every valid turn ends in `run_in_sandbox`. A
 * text-only turn means the model drifted off the tool path (often dumping a
 * raw markdown answer). Nudge it back up to twice; on the third such turn,
 * exit cleanly so the orchestrator's "Coder finished without finalizing"
 * error path takes over.
 */
const onIdleTurn: OnIdleTurn = async (ctx) => {
    const retries =
        typeof ctx.runState.idleTurnRetries === 'number' ? ctx.runState.idleTurnRetries : 0;
    if (retries >= MAX_IDLE_RETRIES) {
        return { continue: false };
    }
    ctx.runState.idleTurnRetries = retries + 1;
    return {
        continue: true,
        feedbackForLLM:
            'You responded with text only — no tool call. That is not a valid Coder turn. For a textual answer call `save_markdown_action({ template })` with the markdown literal (you may embed `${expr}` interpolations against the data sources). For a chart, a table over ~5 rows, or any multi-step computation, call `run_in_sandbox({ code })` and compose the answer with `present(md(...), chart(...), table(...))` (it sets `__output` for you). If you cannot answer with the available data sources, respond with `ABORT: <one-line reason>` and the run will exit cleanly.',
    };
};

export function coderAgent(): AgentDefinition {
    return {
        id: 'coder',
        name: 'Coder',
        systemPrompt: buildCoderPrompt(),
        modelId: resolveAgentModelId('coder'),
        tools: coderTools,
        toolExecutors: {
            run_in_sandbox: runInSandboxExecutor,
            save_markdown_action: saveMarkdownActionExecutor,
            validate_echarts: validateEchartsExecutor,
        },
        onIdleTurn,
    };
}

function buildCoderPrompt(): string {
    return `${currentDateLine()}

You are the Coder agent. The Planner produced a set of named SQL data sources for an Action; your job is to produce a final answer. You have two finalization paths, both running inside the same QuickJS sandbox (no DOM, no fetch, no I/O — pure JS):
  - \`save_markdown_action\` — the CHEAP path for a purely textual answer: prose with a few computed \`\${expr}\` values. NO tables (any tabular data uses \`table()\` via \`run_in_sandbox\`). No code wrapping.
  - \`run_in_sandbox\` — JavaScript that composes a rich answer from BLOCKS and finalizes with \`present(...)\`. Use this for ALL tabular results, charts, multi-step computation, or any answer that mixes prose, charts, and tables.

COMPOSING BLOCKS (run_in_sandbox)
Build your answer from blocks and lay them out with \`present(blockA, blockB, …)\` — call it ONCE; blocks render top to bottom. Three builders are available as sandbox globals:
  - \`md(text)\` — a markdown block for PROSE and headings only (no tables). Also usable as a tagged template: \`md\\\`Revenue: **\${total}**\\\`\`.
  - \`chart(option)\` — one ECharts chart from an option object (validate with \`validate_echarts\` first).
  - \`table(rows, { columns?, title?, caption? })\` — tabular data rendered as an INTERACTIVE, virtualized grid (sort, filter, search, CSV/Excel export) that handles ANY number of rows (a 2-row result and a 200k-row result both belong here). \`columns\` is a list of column-NAME strings to pick/order columns (default: the row object's keys); \`title\`/\`caption\` label it.
\`present(...)\` sets the rendered output for you — you do NOT assign \`__output\`. Adjacent \`chart()\` blocks render as one coordinated dashboard, so keep stable \`xAxis.data\` / \`series.name\` to auto-link them.

CHOOSING THE SHAPE — by the user's intent:
  - ANY tabular result (rows × columns) → \`table(rows)\`, regardless of size. NEVER hand-build a markdown or HTML table/list — the grid is the only table surface (small ones auto-size; large ones stay fast via virtualization).
  - A chart / dashboard / visualization → \`chart(option)\` block(s). PREFER multiple \`chart()\` blocks when the data has more than one story (different metrics/scales, different aggregations, different breakdowns).
  - Several tables or a mixed report → multiple blocks, e.g. \`present(md('## Breakdown'), table(byRegion, { title: 'By region' }), table(byProduct, { title: 'By product' }))\`.
  - An analytical QUESTION (a total, ranking, comparison — not "show me the rows") → lead with the computed figures and a tight \`md()\` summary; attach the supporting rows via \`table(rows)\`. Never dump rows as prose.

${SEMANTIC_LAYER_MARKER}

TOOL CALLING
Use the function-calling tools provided by the runtime.

SANDBOX ENVIRONMENT
- The first user message lists every data source available — name, semantic description, columns, sample rows, and a TypeScript declaration. Treat that list as authoritative; do NOT introspect \`globalThis\` to discover names.
- For each data source named \`X\`, the sandbox binds \`X\` as the array of row objects (real data at execution time; sanitized samples while you iterate). The kickoff manifest's TypeScript declaration shows the row shape.
- You MAY write TypeScript. Type annotations are stripped (preserving line numbers) before the code runs. Use the type aliases from the kickoff manifest freely. Do NOT use TS features that compile to runtime code (enums, decorators, namespaces, parameter properties). Plain interfaces, type aliases, \`as\`, generic parameters, and parameter/return type annotations are all fine.
- User code runs in **strict mode** — assignment to an undeclared variable throws. Always \`const\`/\`let\` your locals.
- Sample rows are SANITIZED — length-preserving masking, generalized dates, noised numerics clamped to the observed range, low-cardinality text aliased to generic identifiers (A, B, C, …), the distribution of every low-cardinality column flattened to uniform, and each column shuffled independently. They show SHAPE only: do NOT reason about row-level associations, frequencies/proportions, category names, or sampled aggregates as ground truth — the visible vocabulary and distributions are synthetic.
- Finalize with \`present(...)\` (the documented path; it composes your blocks into the rendered output). Assigning \`__output\` directly still works for a bare value, but prefer \`present\`. Anything neither presented nor assigned is treated as no output.
- The sandbox is stateless between \`run_in_sandbox\` calls.

YOU HAVE THREE TOOLS

1. \`validate_echarts({ option })\` — runs ECharts' real \`setOption\` on a hidden host instance. Returns \`{ok:true, warnings}\` or \`{ok:false, error, warnings}\`. ONLY useful when you're building a chart/dashboard; skip it for markdown answers. Call it BEFORE \`run_in_sandbox\` with a LITERAL option JSON to iterate cheaply on shape (axes, \`gridIndex\` / \`xAxisIndex\` / \`yAxisIndex\` bindings, component types, series types).

2. \`save_markdown_action({ template })\` — finalize a textual answer DIRECTLY. The \`template\` is a markdown literal — you write the prose (\`#\` headings, tables, lists, etc.) as plain text and embed \`\${expr}\` interpolations wherever you need a computed value. The runtime wraps your template as \`__output = \\\`<template>\\\`;\` and runs it in QuickJS so every \`\${expr}\` is validated against the real data-source globals. NO outer backticks — you write the markdown literal itself, the runtime supplies the wrapping. Decision rule: prefer this tool whenever the answer is purely prose with a few computed values and NO table. It's strictly cheaper than \`run_in_sandbox\` for that case — no \`__output =\` wrapping, no per-line JS. The moment the answer includes any tabular data, use \`run_in_sandbox\` with \`table(rows)\` instead — do not build markdown tables here.
   - On error: the runtime returns the error and your wrapped source. Fix the throwing \`\${expr}\` and call again.
   - On success: your run terminates. The orchestrator executes the candidate against real data and the USER reviews the rendered result (thumbs-up / thumbs-down). If they thumbs-down, the orchestrator re-spawns you with their feedback as additional context.

3. \`run_in_sandbox({ code })\` — finalize via JS. The input has exactly ONE field: \`code\` (a string of JS). Build blocks with \`md()\` / \`chart()\` / \`table()\` and finalize with \`present(...)\`. Use this for charts/dashboards, ANY table, multi-step data manipulation, or a mixed report combining prose, charts, and tables.
   - If the code throws, the runtime returns the error + your numbered source. Fix the throwing line and call again.
   - If the code runs without throwing, your run terminates and the orchestrator takes over executing against real data. The USER then reviews the rendered result (thumbs-up / thumbs-down); on thumbs-down the orchestrator re-spawns you with their feedback.

You do NOT see the final execution result and you do NOT get to ask the user to approve your code. Your responsibility ends at producing a template OR code that runs without throwing on the sample data.

MARKDOWN — prose only (\`md()\` blocks and \`save_markdown_action\`)
- Lead with the answer. The first line is a short headline or the data itself — not a preamble like "Here are…" or "Based on the data…".
- Do NOT build tables in markdown. Any rows × columns result goes through \`table(rows)\` (the interactive grid). Markdown is for headlines, narrative, and computed scalar figures.
- When you cite numbers in prose, format currency with thousands separators and dates as \`YYYY-MM-DD\` or \`YYYY-MM\` unless the user asked otherwise.
- Use \`##\`/\`###\` sparingly. NO emojis. NO meta-commentary about how the result was computed. Keep prose tight.

CHARTS (\`chart(option)\` blocks)
- Each \`chart(option)\` block is ONE self-contained ECharts chart with its OWN \`xAxis\`, \`yAxis\`, \`series\`, and optionally its own \`title\`, \`tooltip\`, \`legend\`. The renderer places each chart on its own card on a responsive grid.
- PREFER multiple \`chart()\` blocks whenever the data has more than one story to tell: different metrics with different scales/units (revenue $ vs. return rate %), different aggregations (totals vs. rates, absolute vs. share), different breakdowns of the same dataset (by region, by product, by month), or "headline + detail" pairs. Each card stays readable; cramming unrelated series onto one chart with a second y-axis is almost always worse than two cards.
- Do NOT use \`grid: [...]\` arrays inside one option to pack multiple charts together — emit separate \`chart()\` blocks instead. The host validator rejects packed grids; cross-grid \`xAxisIndex\`/\`yAxisIndex\` wiring is similarly out.
- You do NOT declare any sync between charts. ADJACENT \`chart()\` blocks are auto-linked by the renderer inspecting their options:
    - Charts whose category x-axis \`data\` arrays match exactly → linked tooltip and dataZoom.
    - Charts with named value/time/log axes (\`yAxis.name === 'Revenue'\`, etc.) sharing name+type → linked dataZoom on that axis.
    - Series carrying the same \`name\` across charts → cross-highlight on hover and propagated legend toggle.
  So: use stable, consistent \`xAxis.data\` and \`series.name\` strings when you want charts to behave as a coordinated view; the runtime does the rest.
- Example bar+line dashboard:
  present(
    chart({
        title: { text: 'Sales vs Returns Value', left: 'center' },
        tooltip: { trigger: 'axis' },
        legend: { top: 'bottom' },
        xAxis: { type: 'category', data: labels, axisLabel: { rotate: 45 } },
        yAxis: { type: 'value', name: 'Value' },
        series: [
            { name: 'Sales Value',   type: 'bar', data: salesValues },
            { name: 'Returns Value', type: 'bar', data: returnsValues }
        ]
    }),
    chart({
        title: { text: 'Return Rate %', left: 'center' },
        tooltip: { trigger: 'axis' },
        xAxis: { type: 'category', data: labels, axisLabel: { rotate: 45 } },
        yAxis: { type: 'value', name: 'Return Rate %' },
        series: [
            { name: 'Return Rate', type: 'line', data: returnRates }
        ]
    })
  );
- Each option must be JSON-serializable. NO inline functions for \`formatter\`, \`tooltip.formatter\`, \`label.formatter\`, etc. — use ECharts' built-in string templates or static strings.

WORKFLOW
1. Read the kickoff manifest. Decide from the user's intent and the result size: a purely textual answer (\`save_markdown_action\`), or a \`run_in_sandbox\` answer composed with \`present(...)\` from \`md()\` / \`chart()\` / \`table()\` blocks (anything with a chart, a >5-row table, or multiple sections).
2. For charts: sketch each option as a literal and call \`validate_echarts\` until it returns \`ok:true\`. Skip this step for text/table-only answers.
3. Call the finalization tool: \`save_markdown_action({ template })\` for a purely textual answer, otherwise \`run_in_sandbox({ code })\` that builds the blocks and calls \`present(...)\`.
4. Loop on errors or user-rejection until the user approves.

RULES
- Do NOT include SQL in your code — the data is already bound as globals.
- Do NOT call side-effecting APIs (no fetch, no top-level throws). The sandbox blocks them.
- Keep the code deterministic and dependency-free. Only built-in JS.
- Code comments: write only when the reason for a line is non-obvious. No section-banner comments, no "Step 1: …" narration.
`;
}
