import {
    streamText,
    type LanguageModelUsage,
    type ModelMessage,
    type ToolResultPart,
    type TypedToolCall,
    type ToolSet,
} from 'ai';
import type { AgentId, Message, MessagePart, SubAgentRun } from '@/lib/types';
import { planFromToolInput, savedQueryFromToolInput } from './tools';
import { createModel } from './models';
import { formatStreamError, withDebugLogging } from './log-middleware';
import { debugLog } from '@/lib/debug-log';
import type { AgentDefinition, AgentRunCtx, SubAgentKickoff, SubAgentResult } from './agent-def';
import { agentRegistry } from './agents';

// MAX_TOTAL_STEPS is a hard safety bound against runaway loops, not a budget
// the model should plan around. Kept generous; if a turn legitimately needs
// more we should investigate the prompt rather than raise this.
const MAX_TOTAL_STEPS = 40;

/**
 * Opt-in console mirroring of API/HTTP errors and tool-error events.
 * Off by default — production renders these into the chat tree only.
 * Integration tests flip the env var so transient OpenRouter failures
 * (429s, SSE error injections, network blips) surface visibly in
 * stderr alongside the AssertionError that ultimately fails the test.
 */
const LOG_API_ERRORS = typeof process !== 'undefined' && process.env?.AGENT_LOG_API_ERRORS === '1';

function logApiError(context: string, err: unknown): void {
    if (!LOG_API_ERRORS) return;
    const o = err as
        | (Error & {
              statusCode?: number;
              status?: number;
              code?: unknown;
              metadata?: { error_type?: unknown };
              cause?: unknown;
          })
        | { code?: unknown; message?: unknown; metadata?: { error_type?: unknown } }
        | undefined;
    const status =
        (o as { statusCode?: number; status?: number })?.statusCode ??
        (o as { statusCode?: number; status?: number })?.status;
    const code = (o as { code?: unknown })?.code;
    const type = (o as { metadata?: { error_type?: unknown } })?.metadata?.error_type;
    // eslint-disable-next-line no-console
    console.error(
        `[agent-loop] ${context} — ${formatStreamError(err)}` +
            (status !== undefined ? ` [http=${status}]` : '') +
            (code !== undefined ? ` [code=${String(code)}]` : '') +
            (type !== undefined ? ` [type=${String(type)}]` : ''),
    );
}

export type AgentControls = {
    /** Allocate a new assistant message for the upcoming step. Returns id. */
    beginStep(agent?: AgentId): string;
    /** Append text to the active text part on the given step. */
    appendText(stepId: string, text: string): void;
    /** Append text to the active reasoning part on the given step. */
    appendReasoning(stepId: string, text: string): void;
    /** Add a structured part to the step. */
    addPart(stepId: string, part: MessagePart): void;
    /** Update an existing part identified by toolCallId. */
    updatePart(stepId: string, toolCallId: string, patch: Partial<MessagePart>): void;
    /**
     * Mark any tool-call parts in the step that are still 'pending' or
     * 'running' as 'error' with the given reason. Called whenever the agent
     * loop exits a step without driving every streamed tool-call to a
     * terminal state — e.g. duplicate ids, validation failures the provider
     * silently dropped, or hitting the step cap.
     */
    sweepUnresolved(stepId: string, reason: string): void;
    /**
     * Resolve when the user approves or cancels a confirmation card. The
     * optional `response` carries structured data a renderer chose to pass
     * back (e.g. an edited payload); plain approve/reject renderers omit it.
     */
    waitForApproval(
        stepId: string,
        toolCallId: string,
    ): Promise<{ approved: boolean; response?: unknown }>;
    /**
     * Mutate a SubAgentRun's metadata (status, result, error) without
     * touching its messages array.
     */
    updateSubAgentRun(stepId: string, runId: string, patch: Partial<SubAgentRun>): void;
    /**
     * Read a SubAgentRun's current state from the store (synchronous,
     * non-reactive). Used by the spawn helper to compute the summary text
     * the parent agent sees after the child finishes.
     */
    readSubAgentRun(stepId: string, runId: string): SubAgentRun | undefined;
    /**
     * Build a child controls object that writes into the given sub-agent
     * run's nested message stream instead of the top-level chat.
     */
    makeSubAgentControls(stepId: string, runId: string): AgentControls;
    /**
     * Snapshot of all top-level chat messages at call time. Used by tools
     * that need to persist the conversation alongside their artifacts (e.g.
     * `work_on_action` stores it on the Action for later replay). Sub-agent
     * controls share the parent's chat — calling this from a child returns
     * the same snapshot as calling it from the root.
     */
    getMessagesSnapshot(): Message[];
};

export type RunAgentArgs = {
    definition: AgentDefinition;
    userText: string;
    history: Message[];
    controls: AgentControls;
    signal: AbortSignal;
    /** Model selection id (see AVAILABLE_MODELS in models.ts). */
    modelId: string;
    /**
     * Per-run scratch space passed to every tool executor as `ctx.runState`.
     * If omitted, a fresh object is allocated. Pass a caller-owned object when
     * you need to read tool-deposited results after the run completes (e.g.
     * `spawnSubAgent` does this to read the Planner's finalized data sources).
     */
    runState?: Record<string, unknown>;
    /**
     * Fires after each `streamText` step with the provider-reported token
     * usage and the fully-qualified model id (`providerId:modelId`) actually
     * used (a sub-agent definition may override the parent's). Sub-agents
     * forward the same callback so orchestrator + Planner + Coder all roll up
     * into one tally.
     */
    onStepUsage?: (usage: LanguageModelUsage, modelId: string) => void;
};

type ToolCallEvent = TypedToolCall<ToolSet>;

export async function runAgent(args: RunAgentArgs): Promise<void> {
    const modelId = args.definition.modelId ?? args.modelId;
    const model = createModel(modelId);
    const messages = buildInitialMessages(args.history, args.userText);
    const runState: Record<string, unknown> = args.runState ?? {};

    for (let step = 0; step < MAX_TOTAL_STEPS; step++) {
        if (args.signal.aborted) return;
        const stepId = args.controls.beginStep(args.definition.id);
        const { calls, usage } = await runOneStep({
            model,
            definition: args.definition,
            messages,
            stepId,
            controls: args.controls,
            signal: args.signal,
        });
        if (usage && args.onStepUsage) {
            args.onStepUsage(usage, modelId);
        }

        if (calls.length === 0) {
            // Stream may have added pending tool-call parts that the provider
            // never surfaced via `result.toolCalls` (e.g. validation failed
            // silently). Don't leave them hanging in the UI.
            args.controls.sweepUnresolved(stepId, 'tool call not resolved by the model');

            // Let the agent react to "no more tool calls". This is how the
            // Planner converts a text-only turn into the user-approval card
            // (no separate finalize tool to forget). Hookless agents exit.
            const idleHook = args.definition.onIdleTurn;
            if (idleHook) {
                const idleCtx: AgentRunCtx = {
                    controls: args.controls,
                    stepId,
                    toolCallId: crypto.randomUUID(),
                    signal: args.signal,
                    runState,
                    spawn: () =>
                        Promise.resolve({
                            ok: false,
                            error: 'onIdleTurn cannot spawn sub-agents',
                        }),
                };
                const outcome = await idleHook(idleCtx);
                if (outcome.continue) {
                    if (outcome.feedbackForLLM) {
                        messages.push({
                            role: 'user',
                            content: outcome.feedbackForLLM,
                        });
                    }
                    continue;
                }
            }
            return;
        }

        const results: ToolResultPart[] = [];
        let terminate = false;
        // Defensive dedupe of identical tool calls within a single step. Some
        // models (notably GPT-OSS) occasionally emit the same call twice in one
        // turn despite "one tool call per user turn" in the prompt; executing
        // both produces duplicate work, duplicate sub-agent spawns, double
        // draft initialization, etc. Scoped per step so identical calls across
        // different steps remain valid.
        const seenCallKeys = new Map<string, string>();
        for (const c of calls) {
            const dedupeKey = `${c.toolName}::${formatJson(c.input)}`;
            const firstCallId = seenCallKeys.get(dedupeKey);
            if (firstCallId !== undefined) {
                const error = `Duplicate tool call: identical to ${firstCallId}; ignored.`;
                args.controls.updatePart(stepId, c.toolCallId, {
                    status: 'error',
                    error,
                });
                logToolDispatch(stepId, c.toolName, c.input, {
                    ok: false,
                    error: 'duplicate',
                });
                results.push({
                    type: 'tool-result',
                    toolCallId: c.toolCallId,
                    toolName: c.toolName,
                    output: {
                        type: 'error-text',
                        value: 'Duplicate tool call ignored — identical input to a tool call already executed in this turn. One tool call per user turn.',
                    },
                });
                continue;
            }
            seenCallKeys.set(dedupeKey, c.toolCallId);
            const ctx: AgentRunCtx = {
                controls: args.controls,
                stepId,
                toolCallId: c.toolCallId,
                signal: args.signal,
                runState,
                spawn: (childId, kickoff) =>
                    spawnSubAgent({
                        parentControls: args.controls,
                        parentStepId: stepId,
                        childId,
                        kickoff,
                        signal: args.signal,
                        modelId: args.modelId,
                        onStepUsage: args.onStepUsage,
                    }),
            };
            const executor = args.definition.toolExecutors[c.toolName];
            if (!executor) {
                const error = `Unknown tool: ${c.toolName}`;
                args.controls.updatePart(stepId, c.toolCallId, {
                    status: 'error',
                    error,
                });
                logToolDispatch(stepId, c.toolName, c.input, {
                    ok: false,
                    error,
                });
                results.push({
                    type: 'tool-result',
                    toolCallId: c.toolCallId,
                    toolName: c.toolName,
                    output: { type: 'error-text', value: error },
                });
                continue;
            }
            // Tools whose stream-side part is NOT the generic 'tool-call'
            // card (propose_plan, save_query, save_data_source, spawn_*)
            // skip the status pending→running→ok transition; their custom
            // card owns its own visual state.
            const hasGenericCard =
                c.toolName !== 'propose_plan' &&
                c.toolName !== 'save_query' &&
                c.toolName !== 'save_data_source' &&
                !isSpawnTool(c.toolName);
            if (hasGenericCard) {
                args.controls.updatePart(stepId, c.toolCallId, {
                    status: 'running',
                });
            }
            let res: Awaited<ReturnType<typeof executor>>;
            try {
                res = await executor(c.input, ctx);
            } catch (e) {
                // Executors should return {ok:false, error} rather than throw,
                // but synchronous Zod parse failures or unexpected runtime
                // errors slip through. Convert to a tool result so the LLM
                // can self-correct on the next turn instead of crashing the
                // sub-agent.
                const error = e instanceof Error ? e.message : String(e);
                res = { ok: false, error };
            }
            logToolDispatch(stepId, c.toolName, c.input, res);
            if (hasGenericCard) {
                args.controls.updatePart(stepId, c.toolCallId, {
                    status: res.ok ? 'ok' : 'error',
                    result: res.ok ? res.value : undefined,
                    error: res.ok ? undefined : res.error,
                });
            }
            results.push({
                type: 'tool-result',
                toolCallId: c.toolCallId,
                toolName: c.toolName,
                output: res.ok
                    ? { type: 'json', value: res.value as never }
                    : { type: 'error-text', value: res.error },
            });
            if (res.terminate) terminate = true;
        }
        messages.push({ role: 'tool', content: results });
        // Catch any tool-call parts that streamed in but had no matching
        // entry in `calls` (e.g. duplicate ids in fence mode). The for-loop
        // above only updates the first match per id.
        args.controls.sweepUnresolved(stepId, 'tool call not dispatched');
        if (terminate) return;
    }
}

async function runOneStep(params: {
    model: ReturnType<typeof createModel>;
    definition: AgentDefinition;
    messages: ModelMessage[];
    stepId: string;
    controls: AgentControls;
    signal: AbortSignal;
}): Promise<{ calls: ToolCallEvent[]; usage: LanguageModelUsage | undefined }> {
    const loggedModel = withDebugLogging(params.model, params.stepId);
    const systemPrompt =
        typeof params.definition.systemPrompt === 'function'
            ? params.definition.systemPrompt()
            : params.definition.systemPrompt;
    const result = streamText({
        model: loggedModel,
        tools: params.definition.tools,
        system: systemPrompt,
        messages: params.messages,
        abortSignal: params.signal,
    });

    for await (const part of result.fullStream) {
        switch (part.type) {
            case 'text-start':
                params.controls.addPart(params.stepId, {
                    kind: 'text',
                    id: part.id,
                    text: '',
                });
                break;
            case 'text-delta':
                params.controls.appendText(params.stepId, part.text);
                break;
            case 'reasoning-start':
                params.controls.addPart(params.stepId, {
                    kind: 'reasoning',
                    id: part.id,
                    text: '',
                });
                break;
            case 'reasoning-delta':
                params.controls.appendReasoning(params.stepId, part.text);
                break;
            case 'reasoning-end':
                // Nothing to finalize — the part already carries its text.
                break;
            case 'tool-call':
                addToolCallPart(params.controls, params.stepId, params.definition.id, part);
                break;
            case 'tool-error': {
                // The SDK already auto-appends a tool-result for this failure
                // to responseMessages, so the model sees the error on its
                // next turn and can self-correct. Our job here is the UI:
                // surface the failure on whichever card was already added
                // when the tool call streamed in.
                //
                // Specialized cards (saved-data-source, saved-query) own
                // their own status field — patch them in place so the user
                // sees ONE failed card, not the original "pending" card +
                // a duplicate generic tool-call error card.
                const id = (part as { toolCallId?: string }).toolCallId ?? '';
                const name = (part as { toolName?: string }).toolName ?? '?';
                const errAny = (part as { error?: unknown }).error;
                const message =
                    errAny instanceof Error
                        ? errAny.message
                        : typeof errAny === 'string'
                          ? errAny
                          : JSON.stringify(errAny);
                logApiError(`tool-error step=${params.stepId} tool=${name}`, errAny);
                if (name === 'save_data_source') {
                    params.controls.updatePart(params.stepId, id, {
                        status: 'error',
                        error: message,
                    });
                } else {
                    params.controls.addPart(params.stepId, {
                        kind: 'tool-call',
                        toolCallId: id,
                        toolName: name,
                        input: undefined,
                        status: 'error',
                        error: message,
                    });
                }
                break;
            }
            case 'error':
                logApiError(
                    `stream error step=${params.stepId} agent=${params.definition.id}`,
                    part.error,
                );
                params.controls.addPart(params.stepId, {
                    kind: 'text',
                    id: crypto.randomUUID().slice(0, 8),
                    text: `\n[stream error: ${formatStreamError(part.error)}]\n`,
                });
                break;
            default:
                break;
        }
    }

    let responseMessages: ModelMessage[] = [];
    let calls: ToolCallEvent[] = [];
    let usage: LanguageModelUsage | undefined;
    try {
        responseMessages = (await result.response).messages;
        calls = (await result.toolCalls) as ToolCallEvent[];
        // `totalUsage` is a PromiseLike that auto-consumes the stream — by
        // this point both `response` and `toolCalls` have already drained
        // it, so this resolves immediately.
        usage = await result.totalUsage;
    } catch (e) {
        // Validation or other downstream failure — surface but don't crash.
        logApiError(`response error step=${params.stepId} agent=${params.definition.id}`, e);
        params.controls.addPart(params.stepId, {
            kind: 'text',
            id: crypto.randomUUID().slice(0, 8),
            text: `\n[response error: ${formatStreamError(e)}]\n`,
        });
    }
    // Strip any tool-result messages the SDK auto-appended for failed
    // validations. We deliver our own (better-formatted) tool-results from
    // the executor's safeParse downstream — keeping the SDK's verbose Zod
    // dump just clutters the model's context with duplicates.
    const filtered = responseMessages.filter((m) => m.role !== 'tool');
    params.messages.push(...filtered);
    return { calls, usage };
}

function addToolCallPart(
    controls: AgentControls,
    stepId: string,
    agentId: AgentId,
    call: { toolCallId: string; toolName: string; input: unknown },
) {
    if (call.toolName === 'propose_plan') {
        controls.addPart(stepId, {
            kind: 'confirmation',
            toolCallId: call.toolCallId,
            agent: agentId,
            rendererId: 'plan',
            payload: planFromToolInput(call.input),
            approved: null,
        });
        return;
    }
    if (call.toolName === 'save_query') {
        controls.addPart(stepId, {
            kind: 'saved-query',
            toolCallId: call.toolCallId,
            query: savedQueryFromToolInput(call.input),
        });
        return;
    }
    if (call.toolName === 'save_data_source') {
        // Planner-side: emit the rich card up front; the executor fills in
        // `preview` and flips `status` once validation + sampling finish.
        controls.addPart(stepId, {
            kind: 'saved-data-source',
            toolCallId: call.toolCallId,
            status: 'validating',
            preview: {
                name: (call.input as { name?: string }).name ?? '(pending)',
                query: (call.input as { query?: string }).query ?? '',
                semanticDescription:
                    (call.input as { semantic_description?: string }).semantic_description ?? '',
                typeDeclaration: '',
                sampleColumns: [],
                sampleRows: [],
                truncated: false,
            },
        });
        return;
    }
    if (isSpawnTool(call.toolName)) {
        // The executor will append a 'sub-agent' part of its own; skip the
        // generic tool-call card to avoid a duplicate visual.
        return;
    }
    controls.addPart(stepId, {
        kind: 'tool-call',
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        input: call.input,
        status: 'pending',
    });
}

function isSpawnTool(name: string): boolean {
    return name.startsWith('spawn_');
}

/**
 * Emit a `system` debug block summarizing one tool dispatch: name, input,
 * and either the result value (on ok) or the error string. Render is a no-op
 * when the debug log is disabled (the store still grows, but the panel won't
 * be visible — call sites pay the JSON.stringify cost regardless).
 */
function logToolDispatch(
    stepId: string,
    toolName: string,
    input: unknown,
    result: { ok: true; value: unknown } | { ok: false; error: string },
) {
    const inputBlock = formatJson(input);
    const resultBlock = result.ok
        ? `→ ok\n${formatJson(result.value)}`
        : `→ error\n${result.error}`;
    debugLog.system(stepId, toolName, `input:\n${inputBlock}\n\n${resultBlock}`);
}

function formatJson(x: unknown): string {
    try {
        return JSON.stringify(x, null, 2);
    } catch {
        return String(x);
    }
}

type SpawnArgs = {
    parentControls: AgentControls;
    parentStepId: string;
    childId: AgentId;
    kickoff: SubAgentKickoff;
    signal: AbortSignal;
    modelId: string;
    onStepUsage?: (usage: LanguageModelUsage, modelId: string) => void;
};

async function spawnSubAgent(args: SpawnArgs): Promise<SubAgentResult> {
    const factory = agentRegistry[args.childId];
    if (!factory) {
        return { ok: false, error: `Unknown agent: ${args.childId}` };
    }
    const childDef = factory(args.kickoff.context);
    const runId = crypto.randomUUID();
    const run: SubAgentRun = {
        runId,
        agentId: childDef.id,
        agentName: childDef.name,
        kickoff: args.kickoff.instruction,
        messages: [],
        inflightId: null,
        status: 'running',
    };
    args.parentControls.addPart(args.parentStepId, {
        kind: 'sub-agent',
        runId,
        run,
    });
    const childControls = args.parentControls.makeSubAgentControls(args.parentStepId, runId);
    const childRunState: Record<string, unknown> = {};
    if (args.kickoff.context) {
        // Surfaces structured handoff data to the child's tools via
        // `ctx.runState.kickoff`. Agents that don't need it ignore the key.
        childRunState.kickoff = args.kickoff.context;
    }
    try {
        await runAgent({
            definition: childDef,
            userText: args.kickoff.instruction,
            history: [],
            controls: childControls,
            signal: args.signal,
            modelId: args.modelId,
            runState: childRunState,
            onStepUsage: args.onStepUsage,
        });
        const finalRun = args.parentControls.readSubAgentRun(args.parentStepId, runId);
        const summary = finalRun ? extractLastAssistantText(finalRun) : '';
        // F2 typed ABORT signal: if the sub-agent ended on a text turn
        // beginning with `ABORT:` (the convention documented in both the
        // Planner and Coder system prompts), promote that into a typed
        // outcome so the parent can route on it instead of treating an
        // empty `finalResult` as a generic crash. Both Planner and
        // Coder share the convention; the parent decides what to do.
        if (!childRunState.finalResult) {
            const abortMatch = summary.match(/^\s*(?:<<TOOL_CALL[^>]*>>\s*)?ABORT:\s*(.+)/m);
            if (abortMatch) {
                childRunState.finalResult = {
                    kind: 'aborted',
                    reason: abortMatch[1]!.trim(),
                };
            }
        }
        args.parentControls.updateSubAgentRun(args.parentStepId, runId, {
            status: args.signal.aborted ? 'cancelled' : 'done',
            result: summary,
            inflightId: null,
        });
        return {
            ok: true,
            summary,
            data: childRunState.finalResult,
        };
    } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        args.parentControls.updateSubAgentRun(args.parentStepId, runId, {
            status: 'error',
            error,
            inflightId: null,
        });
        return { ok: false, error };
    }
}

function extractLastAssistantText(run: SubAgentRun): string {
    for (let i = run.messages.length - 1; i >= 0; i--) {
        const m = run.messages[i];
        if (!m || m.role !== 'assistant') continue;
        const text = m.parts
            ? m.parts
                  .filter((p): p is Extract<MessagePart, { kind: 'text' }> => p.kind === 'text')
                  .map((p) => p.text)
                  .join('')
            : m.content;
        if (text) return text;
    }
    return '';
}

function buildInitialMessages(history: Message[], userText: string): ModelMessage[] {
    const out: ModelMessage[] = [];
    for (const m of history) {
        if (m.role === 'system') continue;
        if (m.role === 'user') {
            out.push({ role: 'user', content: m.content });
            continue;
        }
        // Assistant: extract plain text. Skip tool-calls/plans from history to
        // keep Nano's context lean; the deterministic SQL is preserved as a
        // saved-query artifact elsewhere.
        const text = m.parts
            ? m.parts
                  .filter((p): p is Extract<MessagePart, { kind: 'text' }> => p.kind === 'text')
                  .map((p) => p.text)
                  .join('')
            : m.content;
        if (text) out.push({ role: 'assistant', content: text });
    }
    out.push({ role: 'user', content: userText });
    return out;
}
