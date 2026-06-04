import { afterEach, describe, expect, it } from 'vitest';
import { streamText, tool } from 'ai';
import { z } from 'zod';
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from '@ai-sdk/provider';
import {
    buildToolCallSchema,
    convertPrompt,
    createChromeAi,
    parseToolDecision,
    pumpTextStream,
} from './provider';
import type { ChromeAiMessage, ChromeAiPromptOptions } from './types';

// --- fake Prompt API global ---------------------------------------------

interface FakeOpts {
    /** What `prompt()` resolves to (used for tool turns + non-streaming). */
    promptReply?: string;
    /** Chunks `promptStreaming()` yields (cumulative or delta). */
    streamChunks?: string[];
    /** Captures the last prompt() input + options for assertions. */
    onPrompt?: (input: string | ChromeAiMessage[], opts?: ChromeAiPromptOptions) => void;
}

function installFakeLanguageModel(opts: FakeOpts): void {
    const streamFrom = (chunks: string[]) =>
        new ReadableStream<string>({
            start(controller) {
                for (const c of chunks) controller.enqueue(c);
                controller.close();
            },
        });

    (globalThis as Record<string, unknown>).LanguageModel = {
        availability: async () => 'available',
        create: async () => ({
            prompt: async (
                input: string | ChromeAiMessage[],
                promptOpts?: ChromeAiPromptOptions,
            ) => {
                opts.onPrompt?.(input, promptOpts);
                return opts.promptReply ?? '';
            },
            promptStreaming: (
                input: string | ChromeAiMessage[],
                promptOpts?: ChromeAiPromptOptions,
            ) => {
                opts.onPrompt?.(input, promptOpts);
                return streamFrom(opts.streamChunks ?? []);
            },
            destroy: () => {},
        }),
    };
}

function uninstallFakeLanguageModel(): void {
    delete (globalThis as Record<string, unknown>).LanguageModel;
}

async function drainStream(
    stream: ReadableStream<LanguageModelV3StreamPart>,
): Promise<LanguageModelV3StreamPart[]> {
    const out: LanguageModelV3StreamPart[] = [];
    const reader = stream.getReader();
    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        out.push(value);
    }
    return out;
}

function arrayStream(chunks: string[]): ReadableStream<string> {
    return new ReadableStream<string>({
        start(controller) {
            for (const c of chunks) controller.enqueue(c);
            controller.close();
        },
    });
}

afterEach(() => uninstallFakeLanguageModel());

// --- convertPrompt ------------------------------------------------------

describe('convertPrompt', () => {
    it('lifts system messages and flattens user/assistant text', () => {
        const { system, messages } = convertPrompt([
            { role: 'system', content: 'You are helpful.' },
            { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
            { role: 'assistant', content: [{ type: 'text', text: 'Hi there' }] },
        ]);
        expect(system).toBe('You are helpful.');
        expect(messages).toEqual([
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi there' },
        ]);
    });

    it('renders tool calls + tool results as readable text and merges runs', () => {
        const { messages } = convertPrompt([
            { role: 'user', content: [{ type: 'text', text: 'List tables' }] },
            {
                role: 'assistant',
                content: [
                    {
                        type: 'tool-call',
                        toolCallId: 'c1',
                        toolName: 'list_tables',
                        input: { foo: 1 },
                    },
                ],
            },
            {
                role: 'tool',
                content: [
                    {
                        type: 'tool-result',
                        toolCallId: 'c1',
                        toolName: 'list_tables',
                        output: { type: 'json', value: { tables: ['a', 'b'] } },
                    },
                ],
            },
            {
                role: 'tool',
                content: [
                    {
                        type: 'tool-result',
                        toolCallId: 'c2',
                        toolName: 'describe',
                        output: { type: 'text', value: 'cols' },
                    },
                ],
            },
        ]);
        expect(messages[0]).toEqual({ role: 'user', content: 'List tables' });
        expect(messages[1]?.content).toContain('called tool "list_tables"');
        // Two consecutive tool results collapse into one user turn.
        expect(messages[2]?.role).toBe('user');
        expect(messages[2]?.content).toContain('Result of tool "list_tables"');
        expect(messages[2]?.content).toContain('Result of tool "describe"');
        expect(messages).toHaveLength(3);
    });
});

// --- buildToolCallSchema ------------------------------------------------

describe('buildToolCallSchema', () => {
    type ToolNameSchema = { properties: { tool_name: { enum: string[] } } };
    const toolEnum = (allowNoTool: boolean, names: string[]): string[] =>
        (buildToolCallSchema(names, allowNoTool) as unknown as ToolNameSchema).properties.tool_name
            .enum;

    it('includes the no-tool sentinel only when allowed', () => {
        const enumWith = toolEnum(true, ['a', 'b']);
        expect(enumWith).toContain('a');
        expect(enumWith).toContain('b');
        expect(enumWith).toHaveLength(3); // a, b, __final_answer__

        expect(toolEnum(false, ['a'])).toEqual(['a']);
    });
});

// --- parseToolDecision --------------------------------------------------

describe('parseToolDecision', () => {
    const valid = ['list_tables', 'work_on_action'];

    it('parses a tool call', () => {
        const d = parseToolDecision(
            JSON.stringify({ tool_name: 'list_tables', tool_arguments: { x: 1 } }),
            valid,
        );
        expect(d.kind).toBe('tool-call');
        expect(d.toolName).toBe('list_tables');
        expect(JSON.parse(d.input!)).toEqual({ x: 1 });
    });

    it('treats the sentinel as a text answer', () => {
        const d = parseToolDecision(
            JSON.stringify({ tool_name: '__final_answer__', message_to_user: 'Done.' }),
            valid,
        );
        expect(d.kind).toBe('text');
        expect(d.text).toBe('Done.');
    });

    it('treats an unknown tool name as text', () => {
        const d = parseToolDecision(
            JSON.stringify({ tool_name: 'nope', message_to_user: 'hi' }),
            valid,
        );
        expect(d.kind).toBe('text');
    });

    it('strips markdown fences before parsing', () => {
        const d = parseToolDecision(
            '```json\n{"tool_name":"work_on_action","tool_arguments":{}}\n```',
            valid,
        );
        expect(d.kind).toBe('tool-call');
        expect(d.toolName).toBe('work_on_action');
    });

    it('falls back to raw text when the output is not JSON', () => {
        const d = parseToolDecision('just a plain answer', valid);
        expect(d.kind).toBe('text');
        expect(d.text).toBe('just a plain answer');
    });
});

// --- pumpTextStream -----------------------------------------------------

describe('pumpTextStream', () => {
    it('forwards incremental deltas as-is', async () => {
        const deltas: string[] = [];
        await pumpTextStream(arrayStream(['Hel', 'lo ', 'world']), (d) => deltas.push(d));
        expect(deltas.join('')).toBe('Hello world');
        expect(deltas).toEqual(['Hel', 'lo ', 'world']);
    });

    it('recovers true deltas from cumulative chunks', async () => {
        const deltas: string[] = [];
        await pumpTextStream(arrayStream(['Hel', 'Hello', 'Hello world']), (d) => deltas.push(d));
        expect(deltas.join('')).toBe('Hello world');
        expect(deltas).toEqual(['Hel', 'lo', ' world']);
    });
});

// --- doStream / doGenerate end-to-end -----------------------------------

const baseOptions = (over: Partial<LanguageModelV3CallOptions>): LanguageModelV3CallOptions => ({
    prompt: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: [{ type: 'text', text: 'go' }] },
    ],
    ...over,
});

describe('Chrome AI provider: doStream', () => {
    it('emits a tool-call part for a tool turn', async () => {
        installFakeLanguageModel({
            promptReply: JSON.stringify({
                tool_name: 'work_on_action',
                tool_arguments: { question: 'q' },
            }),
        });
        const model = createChromeAi().chat();
        const { stream } = await model.doStream(
            baseOptions({
                tools: [
                    {
                        type: 'function',
                        name: 'work_on_action',
                        description: 'do work',
                        inputSchema: { type: 'object' },
                    },
                ],
                toolChoice: { type: 'auto' },
            }),
        );
        const parts = await drainStream(stream);
        const call = parts.find((p) => p.type === 'tool-call');
        expect(call).toBeTruthy();
        expect((call as { toolName: string }).toolName).toBe('work_on_action');
        const finish = parts.find((p) => p.type === 'finish') as {
            finishReason: { unified: string };
        };
        expect(finish.finishReason.unified).toBe('tool-calls');
        // includes a constraint on the prompt call
    });

    it('streams text deltas when there are no tools', async () => {
        installFakeLanguageModel({ streamChunks: ['Hel', 'lo'] });
        const model = createChromeAi().chat();
        const { stream } = await model.doStream(baseOptions({}));
        const parts = await drainStream(stream);
        const text = parts
            .filter(
                (p): p is Extract<LanguageModelV3StreamPart, { type: 'text-delta' }> =>
                    p.type === 'text-delta',
            )
            .map((p) => p.delta)
            .join('');
        expect(text).toBe('Hello');
        expect(parts.some((p) => p.type === 'text-start')).toBe(true);
        expect(parts.some((p) => p.type === 'text-end')).toBe(true);
    });

    it('passes a responseConstraint to prompt() on tool turns', async () => {
        let seen: ChromeAiPromptOptions | undefined;
        installFakeLanguageModel({
            promptReply: JSON.stringify({ tool_name: '__final_answer__', message_to_user: 'ok' }),
            onPrompt: (_input, o) => {
                seen = o;
            },
        });
        const model = createChromeAi().chat();
        const { stream } = await model.doStream(
            baseOptions({
                tools: [
                    {
                        type: 'function',
                        name: 'list_tables',
                        description: '',
                        inputSchema: { type: 'object' },
                    },
                ],
                toolChoice: { type: 'auto' },
            }),
        );
        await drainStream(stream);
        expect(seen?.responseConstraint).toBeTruthy();
    });
});

describe('Chrome AI provider: doGenerate', () => {
    it('returns tool-call content for a tool turn', async () => {
        installFakeLanguageModel({
            promptReply: JSON.stringify({ tool_name: 'list_tables', tool_arguments: {} }),
        });
        const model = createChromeAi().chat();
        const result = await model.doGenerate(
            baseOptions({
                tools: [
                    {
                        type: 'function',
                        name: 'list_tables',
                        description: '',
                        inputSchema: { type: 'object' },
                    },
                ],
                toolChoice: { type: 'auto' },
            }),
        );
        expect(result.content[0]?.type).toBe('tool-call');
        expect(result.finishReason.unified).toBe('tool-calls');
    });

    it('returns plain text when no tools are passed', async () => {
        installFakeLanguageModel({ promptReply: 'hello there' });
        const model = createChromeAi().chat();
        const result = await model.doGenerate(baseOptions({}));
        expect(result.content).toEqual([{ type: 'text', text: 'hello there' }]);
        expect(result.finishReason.unified).toBe('stop');
    });
});

// The strongest check: the provider feeds the SAME `streamText` path the
// agent loop uses. This confirms our stream parts reconstruct into
// `result.toolCalls` (with Zod-validated input) and `result.text`.
describe('integration with ai.streamText (the agent loop path)', () => {
    it('surfaces an emulated tool call with validated input', async () => {
        installFakeLanguageModel({
            promptReply: JSON.stringify({
                tool_name: 'list_tables',
                tool_arguments: { db: 'sales' },
            }),
        });
        const result = streamText({
            model: createChromeAi().chat(),
            tools: {
                list_tables: tool({
                    description: 'list tables',
                    inputSchema: z.object({ db: z.string() }),
                }),
            },
            prompt: 'list the tables',
        });
        const calls = await result.toolCalls;
        expect(calls).toHaveLength(1);
        expect(calls[0]!.toolName).toBe('list_tables');
        expect(calls[0]!.input).toEqual({ db: 'sales' });
    });

    it('streams a text answer through streamText', async () => {
        installFakeLanguageModel({ streamChunks: ['Hello ', 'world'] });
        const result = streamText({
            model: createChromeAi().chat(),
            prompt: 'say hi',
        });
        expect(await result.text).toBe('Hello world');
    });
});
