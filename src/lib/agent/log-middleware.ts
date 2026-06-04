import type {
    LanguageModelV3,
    LanguageModelV3Prompt,
    LanguageModelV3StreamPart,
} from '@ai-sdk/provider';
import { debugLog } from '@/lib/debug-log';

/**
 * Wrap a LanguageModelV3 so each `doStream` call logs:
 *   - one "request" block containing the serialized prompt as a transcript,
 *   - one "response" block that grows in real-time as deltas arrive.
 *
 * Logging is gated by `debugLog.enabled` so the cost is zero when off.
 */
export function withDebugLogging(model: LanguageModelV3, stepId: string): LanguageModelV3 {
    return {
        ...model,
        async doGenerate(options) {
            if (!debugLog.enabled) return model.doGenerate(options);
            const reqId = debugLog.open('request', stepId, serializePromptForLog(options.prompt));
            debugLog.close(reqId);
            const result = await model.doGenerate(options);
            const respId = debugLog.open('response', stepId, summariseGenerateResult(result));
            debugLog.close(respId);
            return result;
        },
        async doStream(options) {
            if (!debugLog.enabled) return model.doStream(options);
            const reqId = debugLog.open('request', stepId, serializePromptForLog(options.prompt));
            debugLog.close(reqId);

            const upstream = await model.doStream(options);
            const respId = debugLog.open('response', stepId, '');

            const stream = upstream.stream.pipeThrough(makeTeeTransform(respId));
            return { ...upstream, stream };
        },
    };
}

function makeTeeTransform(
    respId: string,
): TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart> {
    let openToolName: string | null = null;
    return new TransformStream({
        transform(part, controller) {
            switch (part.type) {
                case 'text-delta':
                    if (openToolName) {
                        // Interleaved text after a tool-call burst — separator.
                        debugLog.append(respId, '\n');
                        openToolName = null;
                    }
                    debugLog.append(respId, part.delta);
                    break;
                case 'tool-input-start':
                    debugLog.append(respId, `\n<<TOOL_CALL ${part.toolName}>>\n`);
                    openToolName = part.toolName;
                    break;
                case 'tool-input-delta':
                    debugLog.append(respId, part.delta);
                    break;
                case 'tool-input-end':
                    debugLog.append(respId, `\n<<END_TOOL_CALL>>\n`);
                    openToolName = null;
                    break;
                case 'tool-call':
                    // Some providers skip tool-input-* and only emit tool-call.
                    if (openToolName !== part.toolName) {
                        debugLog.append(
                            respId,
                            `\n<<TOOL_CALL ${part.toolName}>>\n${String(
                                part.input ?? '',
                            )}\n<<END_TOOL_CALL>>\n`,
                        );
                    }
                    openToolName = null;
                    break;
                case 'error':
                    debugLog.append(respId, `\n[stream error: ${formatStreamError(part.error)}]\n`);
                    break;
                case 'finish':
                    debugLog.close(respId);
                    break;
                default:
                    break;
            }
            controller.enqueue(part);
        },
        flush() {
            debugLog.close(respId);
        },
    });
}

/**
 * Stream errors arrive in three shapes: `Error` instances, plain strings,
 * and provider-shaped objects like `{code, message, metadata:{error_type}}`
 * (Anthropic SSE injections, 429s, etc.). `String(obj)` on that third case
 * yields `[object Object]`, which is what the UI surfaced. Extract the
 * useful fields when present.
 */
export function formatStreamError(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (typeof err === 'string') return err;
    if (err && typeof err === 'object') {
        const o = err as {
            message?: unknown;
            code?: unknown;
            metadata?: { error_type?: unknown };
        };
        const msg = typeof o.message === 'string' ? o.message : undefined;
        const code = o.code != null ? String(o.code) : undefined;
        const type =
            o.metadata && typeof o.metadata.error_type === 'string'
                ? o.metadata.error_type
                : undefined;
        const meta = [code, type].filter(Boolean).join(' ');
        if (msg && meta) return `${msg} (${meta})`;
        if (msg) return msg;
        if (meta) return meta;
        try {
            return JSON.stringify(err);
        } catch {
            return String(err);
        }
    }
    return String(err);
}

function serializePromptForLog(prompt: LanguageModelV3Prompt): string {
    const sections: string[] = [];
    for (const m of prompt) {
        if (m.role === 'system') {
            sections.push(`=== SYSTEM ===\n${m.content}`);
            continue;
        }
        if (m.role === 'user') {
            const text = m.content.map((p) => (p.type === 'text' ? p.text : '')).join('');
            sections.push(`=== USER ===\n${text}`);
            continue;
        }
        if (m.role === 'assistant') {
            const out: string[] = [];
            for (const p of m.content) {
                if (p.type === 'text') {
                    out.push(p.text);
                } else if (p.type === 'tool-call') {
                    out.push(
                        `\n<<TOOL_CALL ${p.toolName}>>\n${stringifyAny(
                            p.input,
                        )}\n<<END_TOOL_CALL>>\n`,
                    );
                }
            }
            sections.push(`=== ASSISTANT ===\n${out.join('')}`);
            continue;
        }
        if (m.role === 'tool') {
            const lines: string[] = [];
            for (const p of m.content) {
                if (p.type !== 'tool-result') continue;
                const output = (p as { output?: unknown }).output;
                lines.push(
                    `<<TOOL_RESULT ${p.toolName}>>\n${stringifyAny(output)}\n<<END_TOOL_RESULT>>`,
                );
            }
            sections.push(`=== TOOL ===\n${lines.join('\n')}`);
        }
    }
    return sections.join('\n\n');
}

function stringifyAny(v: unknown): string {
    if (typeof v === 'string') return v;
    try {
        return JSON.stringify(v, null, 2);
    } catch {
        return String(v);
    }
}

function summariseGenerateResult(result: {
    content: Array<{ type: string; text?: string }>;
}): string {
    const out: string[] = [];
    for (const part of result.content) {
        if (part.type === 'text' && part.text) out.push(part.text);
        else if (part.type === 'tool-call') {
            const tc = part as unknown as {
                toolName: string;
                input: unknown;
            };
            out.push(`<<TOOL_CALL ${tc.toolName}>>\n${stringifyAny(tc.input)}\n<<END_TOOL_CALL>>`);
        }
    }
    return out.join('\n');
}
