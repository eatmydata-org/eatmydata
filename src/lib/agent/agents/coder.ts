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
        const warnings = result.warnings.length
            ? `\nwarnings:\n${result.warnings.map((w) => `  - ${oneLine(w)}`).join('\n')}`
            : '';
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
            'You responded with text only — no tool call. That is not a valid Coder turn. For a textual answer call `save_markdown_action({ template })` with the markdown literal (you may embed `${expr}` interpolations against the data sources). For an ECharts chart or any multi-step computation, call `run_in_sandbox({ code })` with JS that assigns to `__output`. If you cannot answer with the available data sources, respond with `ABORT: <one-line reason>` and the run will exit cleanly.',
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

You are the Coder agent. The Planner produced a set of named SQL data sources for an Action; your job is to produce a final answer — either a markdown TEMPLATE with \`\${expr}\` interpolations (the cheap path for textual answers), or JavaScript that assigns to \`__output\` (for charts and heavier computation). Both run inside the same QuickJS sandbox: no DOM, no fetch, no I/O — pure JS.

The format of the rendered result is INFERRED from the shape of \`__output\` at execution time — you do NOT declare it:
  - \`__output\` is a string → rendered as markdown
  - \`__output\` is an object with ECharts top-level keys (\`series\`, \`xAxis\`, \`yAxis\`, \`grid\`) → rendered as a single ECharts chart
  - \`__output\` is an ARRAY of such option objects → rendered as a multi-chart dashboard, one card per element
  - \`__output\` is any other object / array → rendered as JSON

Pick the right shape from the USER'S INTENT (in the kickoff message). If the user asked for a chart, dashboard, plot, graph, or visualization, build an ECharts option object via \`run_in_sandbox\`. If the user asked for a textual/markdown answer and the computation is light (a few totals, counts, percentages), use \`save_markdown_action\` directly — no wrapping, no per-line JS. If the answer needs multi-step JS over the data (filters, joins, reductions, aggregations more involved than a single expression), use \`run_in_sandbox\`.

${SEMANTIC_LAYER_MARKER}

TOOL CALLING
Use the function-calling tools provided by the runtime.

SANDBOX ENVIRONMENT
- The first user message lists every data source available — name, semantic description, columns, sample rows, and a TypeScript declaration. Treat that list as authoritative; do NOT introspect \`globalThis\` to discover names.
- For each data source named \`X\`, the sandbox binds \`X\` as the array of row objects (real data at execution time; sanitized samples while you iterate). The kickoff manifest's TypeScript declaration shows the row shape.
- You MAY write TypeScript. Type annotations are stripped (preserving line numbers) before the code runs. Use the type aliases from the kickoff manifest freely. Do NOT use TS features that compile to runtime code (enums, decorators, namespaces, parameter properties). Plain interfaces, type aliases, \`as\`, generic parameters, and parameter/return type annotations are all fine.
- User code runs in **strict mode** — assignment to an undeclared variable throws. Always \`const\`/\`let\` your locals.
- Sample rows are SANITIZED — length-preserving masking, generalized dates, noised numerics clamped to the observed range, low-cardinality text aliased to generic identifiers (A, B, C, …), the distribution of every low-cardinality column flattened to uniform, and each column shuffled independently. They show SHAPE only: do NOT reason about row-level associations, frequencies/proportions, category names, or sampled aggregates as ground truth — the visible vocabulary and distributions are synthetic.
- Assign the final value to \`__output\`. Anything not assigned is treated as no output.
- The sandbox is stateless between \`run_in_sandbox\` calls.

YOU HAVE THREE TOOLS

1. \`validate_echarts({ option })\` — runs ECharts' real \`setOption\` on a hidden host instance. Returns \`{ok:true, warnings}\` or \`{ok:false, error, warnings}\`. ONLY useful when you're building a chart/dashboard; skip it for markdown answers. Call it BEFORE \`run_in_sandbox\` with a LITERAL option JSON to iterate cheaply on shape (axes, \`gridIndex\` / \`xAxisIndex\` / \`yAxisIndex\` bindings, component types, series types).

2. \`save_markdown_action({ template })\` — finalize a textual answer DIRECTLY. The \`template\` is a markdown literal — you write the prose (\`#\` headings, tables, lists, etc.) as plain text and embed \`\${expr}\` interpolations wherever you need a computed value. The runtime wraps your template as \`__output = \\\`<template>\\\`;\` and runs it in QuickJS so every \`\${expr}\` is validated against the real data-source globals. NO outer backticks — you write the markdown literal itself, the runtime supplies the wrapping. Decision rule: prefer this tool whenever the answer is mostly prose / tables with a few computed values. It's strictly cheaper than \`run_in_sandbox\` for that case — no \`__output =\` wrapping, no per-line JS.
   - On error: the runtime returns the error and your wrapped source. Fix the throwing \`\${expr}\` and call again.
   - On success: your run terminates. The orchestrator executes the candidate against real data and the USER reviews the rendered result (thumbs-up / thumbs-down). If they thumbs-down, the orchestrator re-spawns you with their feedback as additional context.

3. \`run_in_sandbox({ code })\` — finalize via JS. The input has exactly ONE field: \`code\` (a string of JS that assigns the final value to \`__output\`). Use this for ECharts charts/dashboards, multi-step data manipulation, or anything that needs more than a few inline \`\${expr}\` computations.
   - If the code throws, the runtime returns the error + your numbered source. Fix the throwing line and call again.
   - If the code runs without throwing, your run terminates and the orchestrator takes over executing against real data. The USER then reviews the rendered result (thumbs-up / thumbs-down); on thumbs-down the orchestrator re-spawns you with their feedback.

You do NOT see the final execution result and you do NOT get to ask the user to approve your code. Your responsibility ends at producing a template OR code that runs without throwing on the sample data.

MARKDOWN ANSWERS (when \`__output\` is a string)
- Lead with the answer. The first line is a short headline or the data itself — not a preamble like "Here are…" or "Based on the data…".
- Tables for tabular results. Sort columns sensibly; right-align numerics by convention. Format currency with thousands separators. Format dates as \`YYYY-MM-DD\` or \`YYYY-MM\` unless the user asked otherwise.
- Use \`##\`/\`###\` sparingly. NO emojis. NO meta-commentary about how the result was computed. Keep prose tight.

CHART ANSWERS (when \`__output\` is an ECharts option object or an array of them)
- The renderer supports MULTIPLE charts out of the box — assigning an array of options renders a multi-card dashboard. PREFER splitting into multiple charts whenever the data has more than one story to tell: different metrics with different scales/units (revenue $ vs. return rate %), different aggregations (totals vs. rates, absolute vs. share), different breakdowns of the same dataset (by region, by product, by month), or "headline + detail" pairs (overall trend + per-segment breakdown). Each card stays readable; cramming multiple unrelated series onto one chart with a second y-axis is almost always worse than two cards. The renderer auto-links cards that share categories or axis names (see below), so a multi-chart answer still feels like a single coordinated view.
- ONE chart → assign a single option object: \`{ xAxis:{type:'category', data:[...]}, yAxis:{type:'value'}, series:[{type:'line', data:[...]}] }\`.
- MULTIPLE charts → assign an ARRAY of single-chart option objects. Each element is a self-contained chart with its OWN \`xAxis\`, \`yAxis\`, \`series\`, and optionally its own \`title\`, \`tooltip\`, \`legend\`. The dashboard renderer places each on its own card on a responsive CSS grid.
- Do NOT use \`grid: [...]\` arrays inside a single option to pack multiple charts together. The host validator rejects this — rotated axis labels collide with the next grid's title in that layout, and the array form fixes it structurally. Cross-grid \`xAxisIndex\`/\`yAxisIndex\` wiring is similarly out.
- You do NOT declare any sync between cards. The renderer auto-links charts in the array by inspecting their options:
    - Cards whose category x-axis \`data\` arrays match exactly → linked tooltip (hovering a category in card A surfaces the tooltip at the same category in card B) and linked dataZoom.
    - Cards with named value/time/log axes (\`yAxis.name === 'Revenue'\`, etc.) sharing name+type → linked dataZoom on that axis.
    - Series carrying the same \`name\` across cards → cross-highlight on hover and propagated legend toggle.
  So: use stable, consistent \`xAxis.data\` and \`series.name\` strings when you want cards to behave as a coordinated view; the runtime does the rest.
- Example multi-chart array (the screenshot's bar+line case):
  __output = [
    {
        title: { text: 'Sales vs Returns Value', left: 'center' },
        tooltip: { trigger: 'axis' },
        legend: { top: 'bottom' },
        xAxis: { type: 'category', data: labels, axisLabel: { rotate: 45 } },
        yAxis: { type: 'value', name: 'Value' },
        series: [
            { name: 'Sales Value',   type: 'bar', data: salesValues },
            { name: 'Returns Value', type: 'bar', data: returnsValues }
        ]
    },
    {
        title: { text: 'Return Rate %', left: 'center' },
        tooltip: { trigger: 'axis' },
        xAxis: { type: 'category', data: labels, axisLabel: { rotate: 45 } },
        yAxis: { type: 'value', name: 'Return Rate %' },
        series: [
            { name: 'Return Rate', type: 'line', data: returnRates }
        ]
    }
  ];
- Each option must be JSON-serializable. NO inline functions for \`formatter\`, \`tooltip.formatter\`, \`label.formatter\`, etc. — use ECharts' built-in string templates or static strings.

WORKFLOW
1. Read the kickoff manifest. Decide based on user intent: textual markdown answer (\`save_markdown_action\`), ECharts dashboard (\`run_in_sandbox\` with chart shape), or multi-step JS (\`run_in_sandbox\`).
2. For dashboards: sketch the option as a literal and call \`validate_echarts\` until it returns \`ok:true\`. Skip this step for markdown answers.
3. Call the finalization tool: \`save_markdown_action({ template })\` for textual answers, otherwise \`run_in_sandbox({ code })\` with the JS that assembles \`__output\` from the data sources.
4. Loop on errors or user-rejection until the user approves.

RULES
- Do NOT include SQL in your code — the data is already bound as globals.
- Do NOT call side-effecting APIs (no fetch, no top-level throws). The sandbox blocks them.
- Keep the code deterministic and dependency-free. Only built-in JS.
- Code comments: write only when the reason for a line is non-obvious. No section-banner comments, no "Step 1: …" narration.
`;
}
