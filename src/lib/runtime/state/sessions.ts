import {
    ZERO_USAGE,
    type ChatUsage,
    type Message,
    type MessagePart,
    type SubAgentRun,
} from '@/lib/types';
import type { ChatSession, SessionPatch } from '@/lib/runtime/api';
import { publish, publishLocal } from './broadcast';

/**
 * Tab-owned chat sessions.
 *
 * Two mutation idioms here:
 *
 * 1. **Bulk patches** (hydration, inflight/error toggles, removal) use
 *    `emit({ kind: 'session-patch', patch })`. These ship the
 *    materially-changed leaf only — never the whole messages array.
 * 2. **Fine-grained streaming** (LLM token deltas, tool-call updates,
 *    sub-agent messages) uses dedicated event kinds that carry just
 *    the delta. The Solid mirror applies each with a path-specific
 *    setStore so only the affected leaf re-renders and `<For each>`
 *    keeps every existing row's DOM node intact.
 *
 * Internal state is mutated in place (no structuredClone, no array
 * rebuild) — the writing tab owns the only authoritative copy here,
 * so referential preservation matters only over the wire.
 */

const sessions = new Map<string, ChatSession>();
const aborts = new Map<string, AbortController>();

function emitBulk(actionId: string, patch: SessionPatch): void {
    publish({ kind: 'session-patch', actionId, patch });
}

export function getSession(actionId: string): ChatSession | undefined {
    return sessions.get(actionId);
}

export function listSessions(): ChatSession[] {
    return Array.from(sessions.values());
}

export function ensureSession(actionId: string): ChatSession {
    let s = sessions.get(actionId);
    if (!s) {
        s = {
            actionId,
            messages: [],
            inflightId: null,
            error: null,
            usage: { ...ZERO_USAGE },
        };
        sessions.set(actionId, s);
        emitBulk(actionId, {
            messages: [],
            inflightId: null,
            error: null,
            usage: { ...ZERO_USAGE },
        });
    }
    return s;
}

/**
 * Bulk set messages — hydration only (loading a persisted chatLog when
 * opening an action). Streaming never uses this. Local-only: peer tabs
 * are independent authorities for their own sessions and would lose
 * in-flight state if this tab's hydration clobbered them.
 */
export function setMessages(actionId: string, messages: Message[]): void {
    let s = sessions.get(actionId);
    if (!s) {
        s = {
            actionId,
            messages: [],
            inflightId: null,
            error: null,
            usage: { ...ZERO_USAGE },
        };
        sessions.set(actionId, s);
    }
    s.messages = messages;
    publishLocal({ kind: 'session-patch', actionId, patch: { messages } });
}

export function appendMessage(actionId: string, msg: Message): void {
    const s = ensureSession(actionId);
    s.messages.push(msg);
    publish({ kind: 'session-message-appended', actionId, message: msg });
}

function findMessage(actionId: string, stepId: string): Message | undefined {
    return sessions.get(actionId)?.messages.find((m) => m.id === stepId);
}

export function appendTextDelta(actionId: string, stepId: string, delta: string): void {
    const msg = findMessage(actionId, stepId);
    if (!msg) return;
    const parts = msg.parts ?? (msg.parts = []);
    const last = parts[parts.length - 1];
    if (last && last.kind === 'text') {
        last.text += delta;
    } else {
        parts.push({
            kind: 'text',
            id: crypto.randomUUID().slice(0, 8),
            text: delta,
        });
    }
    publish({
        kind: 'session-text-append',
        actionId,
        stepId,
        delta,
    });
}

export function appendReasoningDelta(actionId: string, stepId: string, delta: string): void {
    const msg = findMessage(actionId, stepId);
    if (!msg) return;
    const parts = msg.parts ?? (msg.parts = []);
    const last = parts[parts.length - 1];
    if (last && last.kind === 'reasoning') {
        last.text += delta;
    } else {
        parts.push({
            kind: 'reasoning',
            id: crypto.randomUUID().slice(0, 8),
            text: delta,
        });
    }
    publish({
        kind: 'session-reasoning-append',
        actionId,
        stepId,
        delta,
    });
}

export function addPart(actionId: string, stepId: string, part: MessagePart): void {
    const msg = findMessage(actionId, stepId);
    if (!msg) return;
    (msg.parts ?? (msg.parts = [])).push(part);
    publish({ kind: 'session-part-added', actionId, stepId, part });
}

export function updateToolCallPart(
    actionId: string,
    stepId: string,
    toolCallId: string,
    patch: Partial<MessagePart>,
): void {
    const msg = findMessage(actionId, stepId);
    if (!msg?.parts) return;
    for (const p of msg.parts) {
        if ('toolCallId' in p && p.toolCallId === toolCallId) {
            Object.assign(p, patch);
            publish({
                kind: 'session-part-updated',
                actionId,
                stepId,
                toolCallId,
                patch,
            });
            return;
        }
    }
}

/**
 * Stamp a decision onto a still-pending confirmation part, found by its id
 * across all messages in the session. Used to settle a confirmation card
 * whose in-memory ticket Deferred was lost (tab reload, or a different tab
 * ran the loop) — the same `{ approved, response, decidedAt }` patch the
 * live `requestConfirmation` path applies once `waitForApproval` resolves.
 * Marking it resolved stops it from blocking the composer (`pendingChatInput`
 * only matches `approved === null`) and renders the card as answered.
 * Returns true when a pending confirmation part was found and updated.
 */
export function resolveConfirmationPart(
    actionId: string,
    partId: string,
    decision: { approved: boolean; response?: unknown },
): boolean {
    const s = sessions.get(actionId);
    if (!s) return false;
    for (const msg of s.messages) {
        if (!msg.parts) continue;
        for (const p of msg.parts) {
            if (p.kind === 'confirmation' && p.toolCallId === partId && p.approved === null) {
                const patch: Partial<MessagePart> = {
                    approved: decision.approved,
                    response: decision.response,
                    decidedAt: Date.now(),
                };
                Object.assign(p, patch);
                publish({
                    kind: 'session-part-updated',
                    actionId,
                    stepId: msg.id,
                    toolCallId: partId,
                    patch,
                });
                return true;
            }
        }
    }
    return false;
}

/**
 * Find a confirmation part by its id across all messages in the session,
 * regardless of decided state. Read-only sibling of `resolveConfirmationPart`,
 * used by the host to learn an orphaned card's `rendererId` so it can route a
 * button decision (commit / reject an `analysis-review`) after a reload.
 */
export function findConfirmationPart(
    actionId: string,
    partId: string,
): Extract<MessagePart, { kind: 'confirmation' }> | undefined {
    const s = sessions.get(actionId);
    if (!s) return undefined;
    for (const msg of s.messages) {
        for (const p of msg.parts ?? []) {
            if (p.kind === 'confirmation' && p.toolCallId === partId) return p;
        }
    }
    return undefined;
}

export function sweepUnresolvedParts(actionId: string, stepId: string, reason: string): void {
    const msg = findMessage(actionId, stepId);
    if (!msg?.parts) return;
    for (const p of msg.parts) {
        if (p.kind === 'tool-call' && (p.status === 'pending' || p.status === 'running')) {
            p.status = 'error';
            p.error = p.error ?? reason;
        }
    }
    publish({ kind: 'session-sweep-unresolved', actionId, stepId, reason });
}

function findSubAgentRun(actionId: string, stepId: string, runId: string): SubAgentRun | undefined {
    const msg = findMessage(actionId, stepId);
    if (!msg?.parts) return undefined;
    for (const p of msg.parts) {
        if (p.kind === 'sub-agent' && p.runId === runId) return p.run;
    }
    return undefined;
}

export function mutateSubAgentRun(
    actionId: string,
    stepId: string,
    runId: string,
    mut: (run: SubAgentRun) => void,
): void {
    const run = findSubAgentRun(actionId, stepId, runId);
    if (!run) return;
    // Capture changed fields by comparing before/after — keeps the
    // wire payload small even though we only know the mutator
    // function, not the patch shape.
    const before: Partial<SubAgentRun> = {
        status: run.status,
        result: run.result,
        error: run.error,
        inflightId: run.inflightId,
    };
    mut(run);
    const patch: Partial<SubAgentRun> = {};
    if (run.status !== before.status) patch.status = run.status;
    if (run.result !== before.result) patch.result = run.result;
    if (run.error !== before.error) patch.error = run.error;
    if (run.inflightId !== before.inflightId) patch.inflightId = run.inflightId;
    // If the mutator pushed a new child message, the
    // `mutateChildMessage` family below handles that. Generic patches
    // here cover metadata.
    if (Object.keys(patch).length > 0) {
        publish({
            kind: 'session-sub-agent-patch',
            actionId,
            stepId,
            runId,
            patch,
        });
    }
}

export function readSubAgentRun(
    actionId: string,
    stepId: string,
    runId: string,
): SubAgentRun | undefined {
    return findSubAgentRun(actionId, stepId, runId);
}

/**
 * Child controls: append a brand-new message to a sub-agent run's
 * nested messages array.
 */
export function appendSubAgentMessage(
    actionId: string,
    stepId: string,
    runId: string,
    message: Message,
): void {
    const run = findSubAgentRun(actionId, stepId, runId);
    if (!run) return;
    run.messages.push(message);
    run.inflightId = message.id;
    publish({
        kind: 'session-sub-agent-message-appended',
        actionId,
        stepId,
        runId,
        message,
    });
}

export function appendSubAgentTextDelta(
    actionId: string,
    stepId: string,
    runId: string,
    childStepId: string,
    delta: string,
): void {
    const run = findSubAgentRun(actionId, stepId, runId);
    if (!run) return;
    const msg = run.messages.find((m) => m.id === childStepId);
    if (!msg) return;
    const parts = msg.parts ?? (msg.parts = []);
    const last = parts[parts.length - 1];
    if (last && last.kind === 'text') {
        last.text += delta;
    } else {
        parts.push({
            kind: 'text',
            id: crypto.randomUUID().slice(0, 8),
            text: delta,
        });
    }
    publish({
        kind: 'session-sub-agent-message-mutated',
        actionId,
        stepId,
        runId,
        childStepId,
        op: { kind: 'text-append', delta },
    });
}

export function appendSubAgentReasoningDelta(
    actionId: string,
    stepId: string,
    runId: string,
    childStepId: string,
    delta: string,
): void {
    const run = findSubAgentRun(actionId, stepId, runId);
    if (!run) return;
    const msg = run.messages.find((m) => m.id === childStepId);
    if (!msg) return;
    const parts = msg.parts ?? (msg.parts = []);
    const last = parts[parts.length - 1];
    if (last && last.kind === 'reasoning') {
        last.text += delta;
    } else {
        parts.push({
            kind: 'reasoning',
            id: crypto.randomUUID().slice(0, 8),
            text: delta,
        });
    }
    publish({
        kind: 'session-sub-agent-message-mutated',
        actionId,
        stepId,
        runId,
        childStepId,
        op: { kind: 'reasoning-append', delta },
    });
}

export function addSubAgentPart(
    actionId: string,
    stepId: string,
    runId: string,
    childStepId: string,
    part: MessagePart,
): void {
    const run = findSubAgentRun(actionId, stepId, runId);
    if (!run) return;
    const msg = run.messages.find((m) => m.id === childStepId);
    if (!msg) return;
    (msg.parts ?? (msg.parts = [])).push(part);
    publish({
        kind: 'session-sub-agent-message-mutated',
        actionId,
        stepId,
        runId,
        childStepId,
        op: { kind: 'part-added', part },
    });
}

export function updateSubAgentToolCallPart(
    actionId: string,
    stepId: string,
    runId: string,
    childStepId: string,
    toolCallId: string,
    patch: Partial<MessagePart>,
): void {
    const run = findSubAgentRun(actionId, stepId, runId);
    if (!run) return;
    const msg = run.messages.find((m) => m.id === childStepId);
    if (!msg?.parts) return;
    for (const p of msg.parts) {
        if ('toolCallId' in p && p.toolCallId === toolCallId) {
            Object.assign(p, patch);
            publish({
                kind: 'session-sub-agent-message-mutated',
                actionId,
                stepId,
                runId,
                childStepId,
                op: { kind: 'part-updated', toolCallId, patch },
            });
            return;
        }
    }
}

export function sweepSubAgentUnresolvedParts(
    actionId: string,
    stepId: string,
    runId: string,
    childStepId: string,
    reason: string,
): void {
    const run = findSubAgentRun(actionId, stepId, runId);
    if (!run) return;
    const msg = run.messages.find((m) => m.id === childStepId);
    if (!msg?.parts) return;
    for (const p of msg.parts) {
        if (p.kind === 'tool-call' && (p.status === 'pending' || p.status === 'running')) {
            p.status = 'error';
            p.error = p.error ?? reason;
        }
    }
    publish({
        kind: 'session-sub-agent-message-mutated',
        actionId,
        stepId,
        runId,
        childStepId,
        op: { kind: 'sweep-unresolved', reason },
    });
}

export function markMessageAborted(actionId: string, msgId: string): void {
    const msg = findMessage(actionId, msgId);
    if (!msg) return;
    msg.aborted = true;
    publish({ kind: 'session-message-aborted', actionId, msgId });
}

export function setInflightId(actionId: string, id: string | null): void {
    const s = ensureSession(actionId);
    s.inflightId = id;
    emitBulk(actionId, { inflightId: id });
}

export function setError(actionId: string, err: string | null): void {
    const s = ensureSession(actionId);
    s.error = err;
    emitBulk(actionId, { error: err });
}

/**
 * Replace the session's usage tally — hydration only (loading a
 * persisted `usage` field when opening an action). Local-only for the
 * same reason as setMessages above.
 */
export function setUsage(actionId: string, usage: ChatUsage): void {
    let s = sessions.get(actionId);
    if (!s) {
        s = {
            actionId,
            messages: [],
            inflightId: null,
            error: null,
            usage: { ...ZERO_USAGE },
        };
        sessions.set(actionId, s);
    }
    s.usage = { ...usage };
    publishLocal({
        kind: 'session-patch',
        actionId,
        patch: { usage: { ...usage } },
    });
}

/** Increment the running tally by a step's reported deltas. Emits the
 * resulting absolute total so tabs don't have to track a running sum
 * themselves. */
export function addUsage(actionId: string, delta: ChatUsage): void {
    const s = ensureSession(actionId);
    s.usage = {
        inputTokens: s.usage.inputTokens + delta.inputTokens,
        outputTokens: s.usage.outputTokens + delta.outputTokens,
        reasoningTokens: s.usage.reasoningTokens + delta.reasoningTokens,
        cachedInputTokens: s.usage.cachedInputTokens + delta.cachedInputTokens,
        costUsd: s.usage.costUsd + delta.costUsd,
    };
    emitBulk(actionId, { usage: { ...s.usage } });
}

export function setAbortController(actionId: string, ac: AbortController | null): void {
    if (ac) aborts.set(actionId, ac);
    else aborts.delete(actionId);
}

export function abortSession(actionId: string): void {
    aborts.get(actionId)?.abort();
}

export function clearSession(actionId: string): void {
    abortSession(actionId);
    aborts.delete(actionId);
    sessions.delete(actionId);
    emitBulk(actionId, { removed: true });
}

export function snapshotSessions(): Record<string, ChatSession> {
    const out: Record<string, ChatSession> = {};
    for (const [k, v] of sessions) out[k] = v;
    return out;
}
