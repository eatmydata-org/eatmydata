/**
 * A `LanguageModelV3` implementation backed by Chrome's built-in Prompt API
 * (`globalThis.LanguageModel`, a.k.a. Gemini Nano running on-device).
 *
 * Why hand-rolled: the AI SDK has no maintained provider for the built-in
 * Prompt API at v3 (`@ai-sdk/provider` ^3). Implementing the V3 surface
 * directly lets the existing `streamText`-based agent loop drive Chrome AI
 * with no changes to the loop.
 *
 * The hard part — tool calling. Stable Chrome's Prompt API has NO native
 * function calling (only an experimental origin-trial branch). This whole
 * app's agent loop is tool-driven, so we EMULATE tool calls with structured
 * output: when the SDK passes `tools`, we (a) inject a JSON protocol into the
 * system prompt and (b) constrain decoding with `responseConstraint` to a
 * schema that yields either one tool call or a final text answer, then parse
 * that back into V3 stream parts (`tool-call`) / text. Argument shapes are
 * NOT constrained per-tool (the grammar can't express N disjoint arg schemas
 * reliably); the agent loop's Zod validation handles malformed args by
 * feeding a tool error back to the model, exactly as it does for OpenRouter.
 *
 * @see https://developer.chrome.com/docs/ai/prompt-api
 * @see https://developer.chrome.com/docs/ai/structured-output-for-prompt-api
 */

import type {
    LanguageModelV3,
    LanguageModelV3CallOptions,
    LanguageModelV3Content,
    LanguageModelV3FinishReason,
    LanguageModelV3FunctionTool,
    LanguageModelV3Prompt,
    LanguageModelV3StreamPart,
    LanguageModelV3ToolChoice,
    LanguageModelV3ToolResultOutput,
    LanguageModelV3Usage,
    SharedV3Warning,
} from '@ai-sdk/provider';
import { getChromeLanguageModel, type ChromeAiMessage, type ChromeAiSession } from './types';

export const CHROME_AI_PROVIDER = 'chrome-ai';
export const CHROME_AI_DEFAULT_MODEL = 'gemini-nano';

/** Sentinel tool name meaning "no tool — answer the user directly". */
const NO_TOOL = '__final_answer__';

/** Usage we can't measure from the Prompt API: report all-unknown (free model). */
const UNKNOWN_USAGE: LanguageModelV3Usage = {
    inputTokens: {
        total: undefined,
        noCache: undefined,
        cacheRead: undefined,
        cacheWrite: undefined,
    },
    outputTokens: { total: undefined, text: undefined, reasoning: undefined },
};

// --- prompt conversion --------------------------------------------------

interface ConvertedPrompt {
    system: string;
    /** Conversation turns to hand to `prompt()` / `promptStreaming()`. */
    messages: ChromeAiMessage[];
}

function renderToolOutput(output: LanguageModelV3ToolResultOutput): string {
    switch (output.type) {
        case 'text':
        case 'error-text':
            return output.value;
        case 'json':
        case 'error-json':
            return safeJson(output.value);
        case 'execution-denied':
            return `(execution denied${output.reason ? `: ${output.reason}` : ''})`;
        case 'content':
            return output.value.map((p) => (p.type === 'text' ? p.text : `[${p.type}]`)).join('\n');
        default:
            return safeJson(output);
    }
}

/**
 * Flatten the SDK's structured V3 prompt into a system string + a flat
 * user/assistant transcript. Tool calls and tool results have no native
 * representation in the Prompt API, so we render them as plain text the
 * model can read (`[called X with …]`, `Result of tool "X": …`).
 */
export function convertPrompt(prompt: LanguageModelV3Prompt): ConvertedPrompt {
    const systemParts: string[] = [];
    const messages: ChromeAiMessage[] = [];

    const push = (role: ChromeAiMessage['role'], content: string) => {
        if (!content) return;
        const last = messages[messages.length - 1];
        // Merge consecutive same-role turns — the Prompt API expects a
        // sensible alternation and our tool→user rewrites can produce runs.
        if (last && last.role === role) {
            last.content += `\n\n${content}`;
        } else {
            messages.push({ role, content });
        }
    };

    for (const m of prompt) {
        if (m.role === 'system') {
            systemParts.push(m.content);
            continue;
        }
        if (m.role === 'user') {
            push(
                'user',
                m.content.map((p) => (p.type === 'text' ? p.text : `[${p.type} omitted]`)).join(''),
            );
            continue;
        }
        if (m.role === 'assistant') {
            const chunks: string[] = [];
            for (const p of m.content) {
                if (p.type === 'text') chunks.push(p.text);
                else if (p.type === 'reasoning') chunks.push(p.text);
                else if (p.type === 'tool-call')
                    chunks.push(
                        `[called tool "${p.toolName}" with arguments ${safeJson(p.input)}]`,
                    );
            }
            push('assistant', chunks.join('\n'));
            continue;
        }
        // role === 'tool'
        const chunks: string[] = [];
        for (const p of m.content) {
            if (p.type === 'tool-result') {
                chunks.push(`Result of tool "${p.toolName}": ${renderToolOutput(p.output)}`);
            }
        }
        push('user', chunks.join('\n\n'));
    }

    return { system: systemParts.join('\n\n'), messages };
}

// --- tool-call emulation schema + parsing -------------------------------

function functionTools(tools: LanguageModelV3CallOptions['tools']): LanguageModelV3FunctionTool[] {
    return (tools ?? []).filter((t): t is LanguageModelV3FunctionTool => t.type === 'function');
}

/** Tool names the model is allowed to pick for this call, given `toolChoice`. */
function allowedToolNames(
    tools: LanguageModelV3FunctionTool[],
    toolChoice: LanguageModelV3ToolChoice | undefined,
): { names: string[]; allowNoTool: boolean } {
    if (toolChoice?.type === 'tool') {
        return { names: [toolChoice.toolName], allowNoTool: false };
    }
    if (toolChoice?.type === 'required') {
        return { names: tools.map((t) => t.name), allowNoTool: false };
    }
    return { names: tools.map((t) => t.name), allowNoTool: true };
}

/** JSON Schema handed to `responseConstraint` for the tool-call protocol. */
export function buildToolCallSchema(
    toolNames: string[],
    allowNoTool: boolean,
): Record<string, unknown> {
    const enumNames = allowNoTool ? [...toolNames, NO_TOOL] : [...toolNames];
    return {
        type: 'object',
        additionalProperties: false,
        properties: {
            tool_name: {
                type: 'string',
                enum: enumNames,
                description: allowNoTool
                    ? `The tool to call, or "${NO_TOOL}" to answer the user directly.`
                    : 'The tool to call.',
            },
            tool_arguments: {
                type: 'object',
                description: 'Arguments for the chosen tool ({} if it takes none).',
            },
            message_to_user: {
                type: 'string',
                description: `Your reply, used ONLY when tool_name is "${NO_TOOL}".`,
            },
        },
        required: ['tool_name'],
    };
}

/** The protocol instructions appended to the system prompt for tool turns. */
export function buildToolProtocol(
    tools: LanguageModelV3FunctionTool[],
    allowNoTool: boolean,
): string {
    const lines = tools.map((t) => {
        const schema = t.inputSchema ? ` Arguments JSON schema: ${safeJson(t.inputSchema)}` : '';
        return `- ${t.name}: ${t.description ?? '(no description)'}${schema}`;
    });
    return [
        '## Response format',
        'You do not have a native function-calling channel. You MUST reply with a SINGLE JSON object and nothing else, with these fields:',
        `- "tool_name": the name of exactly ONE tool to call from the list below${allowNoTool ? `, or "${NO_TOOL}" to answer the user directly without calling a tool` : ''}.`,
        '- "tool_arguments": an object holding that tool\'s arguments (use {} when the tool takes no arguments).',
        allowNoTool
            ? `- "message_to_user": your textual answer to the user, set ONLY when tool_name is "${NO_TOOL}".`
            : '- "message_to_user": leave empty; a tool call is required.',
        '',
        'Call exactly one tool per turn. Do not wrap the JSON in markdown fences or prose.',
        '',
        '## Available tools',
        ...lines,
    ].join('\n');
}

export interface ToolDecision {
    kind: 'tool-call' | 'text';
    /** present when kind === 'tool-call' */
    toolName?: string;
    /** stringified JSON arguments, present when kind === 'tool-call' */
    input?: string;
    /** present when kind === 'text' */
    text?: string;
}

/**
 * Parse the constrained JSON the model produced into a tool call or text.
 * Tolerant: strips accidental markdown fences, and falls back to treating the
 * raw output as a text answer when it isn't the expected shape.
 */
export function parseToolDecision(raw: string, validToolNames: string[]): ToolDecision {
    const cleaned = stripJsonFences(raw).trim();
    let obj: unknown;
    try {
        obj = JSON.parse(cleaned);
    } catch {
        // Not JSON at all — treat the whole thing as the model's answer.
        return { kind: 'text', text: raw.trim() };
    }
    if (!obj || typeof obj !== 'object') {
        return { kind: 'text', text: raw.trim() };
    }
    const rec = obj as Record<string, unknown>;
    const toolName = typeof rec.tool_name === 'string' ? rec.tool_name : NO_TOOL;
    if (toolName !== NO_TOOL && validToolNames.includes(toolName)) {
        const args =
            rec.tool_arguments && typeof rec.tool_arguments === 'object' ? rec.tool_arguments : {};
        return { kind: 'tool-call', toolName, input: safeJson(args) };
    }
    const text =
        typeof rec.message_to_user === 'string' && rec.message_to_user.length > 0
            ? rec.message_to_user
            : cleaned;
    return { kind: 'text', text };
}

// --- the model ----------------------------------------------------------

function getLanguageModelOrThrow() {
    const lm = getChromeLanguageModel();
    if (!lm) {
        throw new Error(
            'Chrome AI (Prompt API) is not available in this browser. Use a recent Chrome/Edge with the built-in model enabled.',
        );
    }
    return lm;
}

/** Collect warnings for V3 call settings the Prompt API can't honor. */
function unsupportedSettingWarnings(options: LanguageModelV3CallOptions): SharedV3Warning[] {
    const warnings: SharedV3Warning[] = [];
    const drop = (feature: string) =>
        warnings.push({
            type: 'unsupported',
            feature,
            details: 'ignored by the Chrome built-in Prompt API',
        });
    // temperature/topK are extension/origin-trial only and throw on stable web,
    // so we deliberately don't forward them; flag if the caller set them.
    if (options.temperature !== undefined) drop('temperature');
    if (options.topK !== undefined) drop('topK');
    if (options.topP !== undefined) drop('topP');
    if (options.frequencyPenalty !== undefined) drop('frequencyPenalty');
    if (options.presencePenalty !== undefined) drop('presencePenalty');
    if (options.seed !== undefined) drop('seed');
    if (options.stopSequences?.length) drop('stopSequences');
    return warnings;
}

interface PreparedCall {
    session: Promise<ChromeAiSession>;
    /** When set, decoding is constrained to this JSON Schema. */
    responseConstraint?: unknown;
    input: ChromeAiMessage[];
    /** tool names valid for this call (empty when not a tool turn) */
    validToolNames: string[];
    /** whether the model may decline to call a tool */
    expectToolDecision: boolean;
    promptOptions: { responseConstraint?: unknown; signal?: AbortSignal };
}

function prepareCall(options: LanguageModelV3CallOptions): PreparedCall {
    const lm = getLanguageModelOrThrow();
    const { system, messages } = convertPrompt(options.prompt);

    const tools = functionTools(options.tools);
    const wantsTools = tools.length > 0 && options.toolChoice?.type !== 'none';

    let systemFull = system;
    let responseConstraint: unknown;
    let validToolNames: string[] = [];

    if (wantsTools) {
        const { names, allowNoTool } = allowedToolNames(tools, options.toolChoice);
        validToolNames = names;
        const usable = tools.filter((t) => names.includes(t.name));
        systemFull = [system, buildToolProtocol(usable, allowNoTool)].filter(Boolean).join('\n\n');
        responseConstraint = buildToolCallSchema(names, allowNoTool);
    } else if (options.responseFormat?.type === 'json' && options.responseFormat.schema) {
        // Structured-output (no tools) path, e.g. generateObject.
        responseConstraint = options.responseFormat.schema;
    }

    const initialPrompts: ChromeAiMessage[] = systemFull
        ? [{ role: 'system', content: systemFull }]
        : [];

    const session = lm.create({
        signal: options.abortSignal,
        ...(initialPrompts.length ? { initialPrompts } : {}),
    });

    return {
        session,
        responseConstraint,
        input: messages,
        validToolNames,
        expectToolDecision: wantsTools,
        promptOptions: {
            ...(responseConstraint ? { responseConstraint } : {}),
            ...(options.abortSignal ? { signal: options.abortSignal } : {}),
        },
    };
}

function finishReason(kind: 'tool-call' | 'text'): LanguageModelV3FinishReason {
    return kind === 'tool-call'
        ? { unified: 'tool-calls', raw: 'tool-calls' }
        : { unified: 'stop', raw: 'stop' };
}

export function createChromeAi() {
    return {
        chat(modelId: string = CHROME_AI_DEFAULT_MODEL): LanguageModelV3 {
            return {
                specificationVersion: 'v3',
                provider: CHROME_AI_PROVIDER,
                modelId,
                supportedUrls: {},

                async doGenerate(options) {
                    const warnings = unsupportedSettingWarnings(options);
                    const prep = prepareCall(options);
                    const session = await prep.session;
                    try {
                        const raw = await session.prompt(prep.input, prep.promptOptions);
                        const content: LanguageModelV3Content[] = [];
                        let kind: 'tool-call' | 'text' = 'text';
                        if (prep.expectToolDecision) {
                            const decision = parseToolDecision(raw, prep.validToolNames);
                            kind = decision.kind;
                            if (decision.kind === 'tool-call') {
                                content.push({
                                    type: 'tool-call',
                                    toolCallId: crypto.randomUUID(),
                                    toolName: decision.toolName!,
                                    input: decision.input!,
                                });
                            } else if (decision.text) {
                                content.push({ type: 'text', text: decision.text });
                            }
                        } else if (raw) {
                            content.push({ type: 'text', text: raw });
                        }
                        return {
                            content,
                            finishReason: finishReason(kind),
                            usage: UNKNOWN_USAGE,
                            warnings,
                        };
                    } finally {
                        destroyQuietly(session);
                    }
                },

                async doStream(options) {
                    const warnings = unsupportedSettingWarnings(options);
                    const prep = prepareCall(options);

                    const stream = new ReadableStream<LanguageModelV3StreamPart>({
                        async start(controller) {
                            controller.enqueue({ type: 'stream-start', warnings });
                            let session: ChromeAiSession | undefined;
                            try {
                                session = await prep.session;
                                if (prep.expectToolDecision) {
                                    // Tool turns need the full JSON before we can
                                    // decide text-vs-tool-call, so generate then replay.
                                    const raw = await session.prompt(
                                        prep.input,
                                        prep.promptOptions,
                                    );
                                    const decision = parseToolDecision(raw, prep.validToolNames);
                                    if (decision.kind === 'tool-call') {
                                        controller.enqueue({
                                            type: 'tool-call',
                                            toolCallId: crypto.randomUUID(),
                                            toolName: decision.toolName!,
                                            input: decision.input!,
                                        });
                                    } else {
                                        emitText(controller, decision.text ?? '');
                                    }
                                    controller.enqueue({
                                        type: 'finish',
                                        usage: UNKNOWN_USAGE,
                                        finishReason: finishReason(decision.kind),
                                    });
                                } else {
                                    // Plain (or JSON-constrained) text: real streaming.
                                    const textId = 'txt-0';
                                    controller.enqueue({ type: 'text-start', id: textId });
                                    await pumpTextStream(
                                        session.promptStreaming(prep.input, prep.promptOptions),
                                        (delta) =>
                                            controller.enqueue({
                                                type: 'text-delta',
                                                id: textId,
                                                delta,
                                            }),
                                    );
                                    controller.enqueue({ type: 'text-end', id: textId });
                                    controller.enqueue({
                                        type: 'finish',
                                        usage: UNKNOWN_USAGE,
                                        finishReason: finishReason('text'),
                                    });
                                }
                                controller.close();
                            } catch (err) {
                                controller.enqueue({ type: 'error', error: err });
                                controller.enqueue({
                                    type: 'finish',
                                    usage: UNKNOWN_USAGE,
                                    finishReason: { unified: 'error', raw: 'error' },
                                });
                                controller.close();
                            } finally {
                                if (session) destroyQuietly(session);
                            }
                        },
                    });

                    return { stream };
                },
            };
        },
    };
}

// --- stream-text pump ---------------------------------------------------

function emitText(
    controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>,
    text: string,
) {
    const id = 'txt-0';
    controller.enqueue({ type: 'text-start', id });
    if (text) controller.enqueue({ type: 'text-delta', id, delta: text });
    controller.enqueue({ type: 'text-end', id });
}

/**
 * Read Chrome's text stream and forward true deltas. The Prompt API has
 * shipped both cumulative (early Chrome) and incremental (current) chunk
 * semantics; detect per-chunk so we work on either: a chunk that begins with
 * everything seen so far is cumulative (forward the suffix), otherwise it's a
 * delta (forward as-is).
 */
export async function pumpTextStream(
    stream: ReadableStream<string>,
    onDelta: (delta: string) => void,
): Promise<void> {
    const reader = stream.getReader();
    let acc = '';
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            const chunk = value ?? '';
            if (!chunk) continue;
            let delta: string;
            if (acc && chunk.startsWith(acc)) {
                delta = chunk.slice(acc.length);
                acc = chunk;
            } else {
                delta = chunk;
                acc += chunk;
            }
            if (delta) onDelta(delta);
        }
    } finally {
        reader.releaseLock();
    }
}

// --- small utils --------------------------------------------------------

function destroyQuietly(session: ChromeAiSession): void {
    try {
        session.destroy();
    } catch (e) {
        console.warn('[chrome-ai] session.destroy() failed:', e);
    }
}

function safeJson(x: unknown): string {
    try {
        return JSON.stringify(x);
    } catch {
        return String(x);
    }
}

/**
 * Strip a Markdown code fence around a JSON payload, returning the inner
 * body. Plain string scanning (indexOf/slice) rather than a regex, to avoid
 * super-linear backtracking on unterminated or whitespace-heavy model output
 * (the prior `/```(?:json)?\s*([\s\S]*?)\s*```/` was flagged by
 * sonarjs/slow-regex). Behavior matches the old regex: finds the first
 * fence, drops an optional `json` language tag, and returns the trimmed body
 * up to the next ``` — falling back to the original string if there is no
 * opening fence or no closing fence.
 */
function stripJsonFences(s: string): string {
    const open = s.indexOf('```');
    if (open === -1) return s;
    let body = s.slice(open + 3);
    // Optional language tag immediately after the opening fence — only the
    // literal `json` (case-insensitive), matching the previous pattern.
    if (body.slice(0, 4).toLowerCase() === 'json') body = body.slice(4);
    const close = body.indexOf('```');
    if (close === -1) return s; // unterminated fence — leave input untouched
    return body.slice(0, close).trim();
}
