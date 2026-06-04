/**
 * Shared helpers for the agent-loop integration tests. The test file
 * installs module mocks at its top via `vi.mock`; this file holds pure
 * utilities the tests compose to drive the agent loop programmatically.
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WaSqliteDb } from '@/lib/wa-sqlite/db';
import type { Message, MessagePart, SubAgentRun } from '@/lib/types';
import type { AgentControls } from '@/lib/agent/loop';
import type { ConfirmationResponse } from '@/lib/agent/confirmation';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NORTHWIND_PATH = resolve(__dirname, '../../../../public/demo/northwind.sqlite');

/**
 * Load the Northwind SQLite fixture into an in-process `:memory:` engine.
 * Same path as `db.test.ts` — proven to work in vitest's Node env.
 */
export async function seedNorthwindDb(): Promise<WaSqliteDb> {
    const bytes = await readFile(NORTHWIND_PATH);
    const db = new WaSqliteDb();
    await db.init();
    await db.loadFile(new Uint8Array(bytes));
    // Warm-up call: `loadFile` mallocs ~24 MB, which triggers
    // `WebAssembly.Memory.grow`. The runtime's cached HEAPU8 view becomes
    // detached; the first downstream call that lands in
    // `getValue`/`setValue` (e.g. the Planner's `list_tables` →
    // `getSchema`) throws "Cannot perform DataView constructor on a
    // detached ArrayBuffer". A throwaway `getSchema()` here forces the
    // heap views to refresh before the agent loop touches the DB.
    await db.getSchema().catch(() => {});
    return db;
}

/**
 * Decision handler: called when the agent loop blocks on a confirmation
 * with this rendererId. Returns the approve/reject decision the production
 * UI would normally produce on a user click.
 */
export type ApprovalHandler = (args: {
    rendererId: string;
    payload: unknown;
    toolCallId: string;
}) => ConfirmationResponse | Promise<ConfirmationResponse>;

/**
 * Ordered queue of approval handlers, matched by rendererId in arrival
 * order. A test pushes handlers via `next(rendererId, handler)`; the
 * controls' `waitForApproval` pulls them in order.
 *
 * Throws if a confirmation arrives for which no handler was queued —
 * making "the model produced an unexpected card" a test failure rather
 * than a hang.
 */
export class ApprovalScript {
    private queue: Map<string, ApprovalHandler[]> = new Map();
    private counts: Map<string, number> = new Map();

    next(rendererId: string, handler: ApprovalHandler): this {
        const list = this.queue.get(rendererId) ?? [];
        list.push(handler);
        this.queue.set(rendererId, list);
        return this;
    }

    async handle(args: {
        rendererId: string;
        payload: unknown;
        toolCallId: string;
    }): Promise<ConfirmationResponse> {
        const list = this.queue.get(args.rendererId);
        if (!list || list.length === 0) {
            throw new Error(
                `ApprovalScript: no handler queued for rendererId="${args.rendererId}". ` +
                    `Queue: ${JSON.stringify([...this.queue.entries()].map(([k, v]) => [k, v.length]))}`,
            );
        }
        const handler = list.shift()!;
        if (list.length === 0) this.queue.delete(args.rendererId);
        else this.queue.set(args.rendererId, list);
        this.counts.set(args.rendererId, (this.counts.get(args.rendererId) ?? 0) + 1);
        return await handler(args);
    }

    timesCalledWith(rendererId: string): number {
        return this.counts.get(rendererId) ?? 0;
    }
}

export function approve(response?: unknown): ConfirmationResponse {
    return { approved: true, response };
}

export function rejectWithFeedback(freeText: string): ConfirmationResponse {
    return { approved: false, response: { freeText } };
}

export function cancel(): ConfirmationResponse {
    return { approved: false, response: undefined };
}

/**
 * Programmatic AgentControls — replaces the production
 * `buildRuntimeControls` so tests can run without a real
 * sessions/tickets/IDB stack.
 *
 * Messages live in a plain array on `state.messages`; sub-agent runs
 * nest their messages on the parent `sub-agent` part. Approvals route
 * through the script.
 */
export function makeProgrammaticControls(script: ApprovalScript): {
    controls: AgentControls;
    messages: Message[];
    /** All parts ever added across the top-level chat, in arrival order. */
    allParts(): MessagePart[];
    /** All parts ever added under sub-agent runs, flattened. */
    allSubAgentParts(): MessagePart[];
} {
    const messages: Message[] = [];

    function findMessage(stepId: string): Message | undefined {
        return messages.find((m) => m.id === stepId);
    }

    function appendToLastText(parts: MessagePart[], delta: string): void {
        // Find the most recent text part and append; create one if none.
        for (let i = parts.length - 1; i >= 0; i--) {
            const p = parts[i]!;
            if (p.kind === 'text') {
                (p as { text: string }).text += delta;
                return;
            }
            if (p.kind === 'tool-call' || p.kind === 'confirmation') break;
        }
        parts.push({
            kind: 'text',
            id: crypto.randomUUID().slice(0, 8),
            text: delta,
        });
    }

    function appendToLastReasoning(parts: MessagePart[], delta: string): void {
        for (let i = parts.length - 1; i >= 0; i--) {
            const p = parts[i]!;
            if (p.kind === 'reasoning') {
                (p as { text: string }).text += delta;
                return;
            }
            if (p.kind === 'tool-call' || p.kind === 'text') break;
        }
        parts.push({
            kind: 'reasoning',
            id: crypto.randomUUID().slice(0, 8),
            text: delta,
        });
    }

    const topControls: AgentControls = {
        beginStep(agent) {
            const id = crypto.randomUUID();
            const msg: Message = {
                id,
                role: 'assistant',
                content: '',
                parts: [],
                createdAt: Date.now(),
                agent,
            };
            messages.push(msg);
            return id;
        },
        appendText(stepId, delta) {
            const m = findMessage(stepId);
            if (!m) return;
            m.parts ??= [];
            appendToLastText(m.parts, delta);
        },
        appendReasoning(stepId, delta) {
            const m = findMessage(stepId);
            if (!m) return;
            m.parts ??= [];
            appendToLastReasoning(m.parts, delta);
        },
        addPart(stepId, part) {
            const m = findMessage(stepId);
            if (!m) return;
            m.parts ??= [];
            m.parts.push(part);
        },
        updatePart(stepId, toolCallId, patch) {
            const m = findMessage(stepId);
            if (!m?.parts) return;
            const part = m.parts.find(
                (p) =>
                    (p.kind === 'tool-call' ||
                        p.kind === 'confirmation' ||
                        p.kind === 'saved-data-source' ||
                        p.kind === 'saved-query') &&
                    'toolCallId' in p &&
                    p.toolCallId === toolCallId,
            );
            if (part) Object.assign(part, patch);
        },
        sweepUnresolved(stepId, reason) {
            const m = findMessage(stepId);
            if (!m?.parts) return;
            for (const p of m.parts) {
                if (p.kind === 'tool-call' && (p.status === 'pending' || p.status === 'running')) {
                    p.status = 'error';
                    (p as { error?: string }).error = reason;
                }
            }
        },
        async waitForApproval(stepId, toolCallId) {
            const m = findMessage(stepId);
            const part = m?.parts?.find(
                (p): p is Extract<MessagePart, { kind: 'confirmation' }> =>
                    p.kind === 'confirmation' && p.toolCallId === toolCallId,
            );
            if (!part) {
                throw new Error(
                    `waitForApproval: no confirmation part found for toolCallId=${toolCallId} on step=${stepId}`,
                );
            }
            return script.handle({
                rendererId: part.rendererId,
                payload: part.payload,
                toolCallId,
            });
        },
        updateSubAgentRun(stepId, runId, patch) {
            const m = findMessage(stepId);
            if (!m?.parts) return;
            const part = m.parts.find(
                (p): p is Extract<MessagePart, { kind: 'sub-agent' }> =>
                    p.kind === 'sub-agent' && p.runId === runId,
            );
            if (part) Object.assign(part.run, patch);
        },
        readSubAgentRun(stepId, runId) {
            const m = findMessage(stepId);
            if (!m?.parts) return undefined;
            const part = m.parts.find(
                (p): p is Extract<MessagePart, { kind: 'sub-agent' }> =>
                    p.kind === 'sub-agent' && p.runId === runId,
            );
            return part?.run;
        },
        makeSubAgentControls(stepId, runId) {
            return buildChildControls(stepId, runId);
        },
        getMessagesSnapshot() {
            return structuredClone(messages);
        },
    };

    function buildChildControls(rootStepId: string, runId: string): AgentControls {
        function getRun(): SubAgentRun | undefined {
            return topControls.readSubAgentRun(rootStepId, runId);
        }
        function findChildMessage(stepId: string): Message | undefined {
            return getRun()?.messages.find((m) => m.id === stepId);
        }
        return {
            beginStep(agent) {
                const id = crypto.randomUUID();
                const msg: Message = {
                    id,
                    role: 'assistant',
                    content: '',
                    parts: [],
                    createdAt: Date.now(),
                    agent,
                };
                const run = getRun();
                if (run) run.messages.push(msg);
                return id;
            },
            appendText(stepId, delta) {
                const m = findChildMessage(stepId);
                if (!m) return;
                m.parts ??= [];
                appendToLastText(m.parts, delta);
            },
            appendReasoning(stepId, delta) {
                const m = findChildMessage(stepId);
                if (!m) return;
                m.parts ??= [];
                appendToLastReasoning(m.parts, delta);
            },
            addPart(stepId, part) {
                const m = findChildMessage(stepId);
                if (!m) return;
                m.parts ??= [];
                m.parts.push(part);
            },
            updatePart(stepId, toolCallId, patch) {
                const m = findChildMessage(stepId);
                if (!m?.parts) return;
                const part = m.parts.find(
                    (p) =>
                        (p.kind === 'tool-call' ||
                            p.kind === 'confirmation' ||
                            p.kind === 'saved-data-source' ||
                            p.kind === 'saved-query') &&
                        'toolCallId' in p &&
                        p.toolCallId === toolCallId,
                );
                if (part) Object.assign(part, patch);
            },
            sweepUnresolved(stepId, reason) {
                const m = findChildMessage(stepId);
                if (!m?.parts) return;
                for (const p of m.parts) {
                    if (
                        p.kind === 'tool-call' &&
                        (p.status === 'pending' || p.status === 'running')
                    ) {
                        p.status = 'error';
                        (p as { error?: string }).error = reason;
                    }
                }
            },
            async waitForApproval(stepId, toolCallId) {
                const m = findChildMessage(stepId);
                const part = m?.parts?.find(
                    (p): p is Extract<MessagePart, { kind: 'confirmation' }> =>
                        p.kind === 'confirmation' && p.toolCallId === toolCallId,
                );
                if (!part) {
                    throw new Error(
                        `waitForApproval (child): no confirmation part found for toolCallId=${toolCallId}`,
                    );
                }
                return script.handle({
                    rendererId: part.rendererId,
                    payload: part.payload,
                    toolCallId,
                });
            },
            updateSubAgentRun() {
                throw new Error('Nested sub-agents are not supported.');
            },
            readSubAgentRun() {
                return undefined;
            },
            makeSubAgentControls() {
                throw new Error('Nested sub-agents are not supported.');
            },
            getMessagesSnapshot() {
                return structuredClone(messages);
            },
        };
    }

    function flattenSubAgentParts(): MessagePart[] {
        const out: MessagePart[] = [];
        for (const m of messages) {
            if (!m.parts) continue;
            for (const p of m.parts) {
                if (p.kind !== 'sub-agent') continue;
                for (const sm of p.run.messages) {
                    if (sm.parts) out.push(...sm.parts);
                }
            }
        }
        return out;
    }

    function flattenAllParts(): MessagePart[] {
        const out: MessagePart[] = [];
        for (const m of messages) if (m.parts) out.push(...m.parts);
        return out;
    }

    return {
        controls: topControls,
        messages,
        allParts: flattenAllParts,
        allSubAgentParts: flattenSubAgentParts,
    };
}

/**
 * Utility: find the first MessagePart of `kind` anywhere in the
 * (possibly nested) message tree that matches an optional predicate.
 */
export function findPart<K extends MessagePart['kind']>(
    parts: MessagePart[],
    kind: K,
    predicate?: (part: Extract<MessagePart, { kind: K }>) => boolean,
): Extract<MessagePart, { kind: K }> | undefined {
    for (const p of parts) {
        if (p.kind !== kind) continue;
        const typed = p as Extract<MessagePart, { kind: K }>;
        if (!predicate || predicate(typed)) return typed;
    }
    return undefined;
}

/**
 * Count MessageParts matching kind + optional predicate.
 */
export function countParts<K extends MessagePart['kind']>(
    parts: MessagePart[],
    kind: K,
    predicate?: (part: Extract<MessagePart, { kind: K }>) => boolean,
): number {
    let n = 0;
    for (const p of parts) {
        if (p.kind !== kind) continue;
        const typed = p as Extract<MessagePart, { kind: K }>;
        if (!predicate || predicate(typed)) n += 1;
    }
    return n;
}
