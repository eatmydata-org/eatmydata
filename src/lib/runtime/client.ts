import { createStore, produce, reconcile, unwrap } from 'solid-js/store';
import type {
    ActionDraft,
    ActionListPatch,
    ChatSession,
    ConfirmationDecision,
    RuntimeEvent,
    Ticket,
} from './api';
import { ZERO_USAGE, type Message, type MessagePart } from '@/lib/types';
import type { Action } from '@/lib/actions/types';
import type { ActionExecution } from '@/lib/actions/executor';
import type { ModelEntry, Settings } from './state/settings-types';
import { defaultSettings, findModelEntryIn } from './state/settings-types';
import { setLocalListener, subscribePeerEvents, publishPeer } from './state/broadcast';
import * as host from './host';

// Unique id for this tab — used in snapshot-request/-response so the
// asking tab can filter responses meant for it.
const TAB_ID = crypto.randomUUID();

/**
 * Tab-side runtime client.
 *
 * No SharedWorker. The agent loop and state modules live in this tab
 * directly (see `./host.ts`). The Solid mirror below is updated from
 * two equivalent sources:
 *
 *   - local self-delivery, when this tab is the writer: state modules
 *     call `publish()`, which forwards to `applyEvent` here before
 *     posting on the BroadcastChannel.
 *   - cross-tab broadcasts, when a peer tab is the writer.
 *
 * Either way, `applyEvent` is the single point that mutates the Solid
 * store, so UI rendering is identical regardless of who authored the
 * change.
 */

type TabMirror = {
    sessions: Record<string, ChatSession>;
    drafts: Record<string, ActionDraft>;
    activeActionId: string | undefined;
    results: Record<string, ActionExecution>;
    tickets: Record<string, Ticket>;
    settings: Settings;
    recentActions: Action[];
    /** False until the initial host snapshot has merged. */
    hydrated: boolean;
};

const [mirror, setMirror] = createStore<TabMirror>({
    sessions: {},
    drafts: {},
    activeActionId: undefined,
    results: {},
    tickets: {},
    settings: defaultSettings(),
    recentActions: [],
    hydrated: false,
});

let hydrationPromise: Promise<void> | null = null;
let bootstrapped = false;

function bootstrap(): void {
    if (bootstrapped) return;
    bootstrapped = true;

    // Same-tab self-delivery: publish() calls this directly so the
    // Solid mirror updates from this tab's own state mutations.
    setLocalListener(applyEvent);

    // Cross-tab delivery: shares the single BroadcastChannel instance
    // owned by broadcast.ts. (Opening a second channel here on the same
    // name would double every event in this tab — see the comment in
    // broadcast.ts.)
    subscribePeerEvents(applyEvent);

    host.boot();

    hydrationPromise = (async () => {
        const snap = await host.getSnapshot();
        setMirror(
            produce((m) => {
                m.sessions = snap.sessions;
                m.drafts = snap.drafts;
                m.activeActionId = snap.activeActionId;
                m.results = snap.results;
                m.tickets = snap.tickets;
                m.hydrated = true;
            }),
        );
        for (const key of Object.keys(snap.settings) as (keyof Settings)[]) {
            if (key === 'providers' && Array.isArray(snap.settings.providers)) {
                // `key: 'id'` keys BOTH the providers array and each
                // provider's nested `models` array (both carry a unique
                // `id`), so untouched rows keep their object identity and
                // the model-selector listbox doesn't remount.
                setMirror(
                    'settings',
                    'providers',
                    reconcile(snap.settings.providers, { key: 'id' }),
                );
            } else {
                setMirror('settings', key, snap.settings[key] as never);
            }
        }
        try {
            const recent = await host.listRecentActions(50);
            setMirror('recentActions', recent);
        } catch (e) {
            console.warn('[runtime/client] listRecentActions failed', e);
        }
    })().catch((e) => {
        console.error('[runtime/client] hydration failed', e);
    });
}

/**
 * Apply a sub-agent child-message op in place. Mirrors the
 * top-level streaming ops but inside a sub-agent's nested messages.
 */
function applyChildOp(
    child: Message,
    op:
        | { kind: 'text-append'; delta: string }
        | { kind: 'reasoning-append'; delta: string }
        | { kind: 'part-added'; part: MessagePart }
        | {
              kind: 'part-updated';
              toolCallId: string;
              patch: Partial<MessagePart>;
          }
        | { kind: 'sweep-unresolved'; reason: string },
): void {
    switch (op.kind) {
        case 'text-append': {
            const parts = child.parts ?? (child.parts = []);
            const last = parts[parts.length - 1];
            if (last && last.kind === 'text') {
                last.text += op.delta;
            } else {
                parts.push({
                    kind: 'text',
                    id: crypto.randomUUID().slice(0, 8),
                    text: op.delta,
                });
            }
            return;
        }
        case 'reasoning-append': {
            const parts = child.parts ?? (child.parts = []);
            const last = parts[parts.length - 1];
            if (last && last.kind === 'reasoning') {
                last.text += op.delta;
            } else {
                parts.push({
                    kind: 'reasoning',
                    id: crypto.randomUUID().slice(0, 8),
                    text: op.delta,
                });
            }
            return;
        }
        case 'part-added': {
            (child.parts ?? (child.parts = [])).push(op.part);
            return;
        }
        case 'part-updated': {
            if (!child.parts) return;
            for (const p of child.parts) {
                if ('toolCallId' in p && p.toolCallId === op.toolCallId) {
                    Object.assign(p, op.patch);
                    return;
                }
            }
            return;
        }
        case 'sweep-unresolved': {
            if (!child.parts) return;
            for (const p of child.parts) {
                if (p.kind === 'tool-call' && (p.status === 'pending' || p.status === 'running')) {
                    p.status = 'error';
                    p.error = p.error ?? op.reason;
                }
            }
            return;
        }
    }
}

function applyEvent(event: RuntimeEvent): void {
    switch (event.kind) {
        case 'session-patch': {
            const { actionId, patch } = event;
            if (patch.removed) {
                setMirror(
                    produce((m) => {
                        delete m.sessions[actionId];
                    }),
                );
                break;
            }
            if (!mirror.sessions[actionId]) {
                setMirror('sessions', actionId, {
                    actionId,
                    messages: [],
                    inflightId: null,
                    error: null,
                    usage: { ...ZERO_USAGE },
                });
            }
            if (patch.messages !== undefined) {
                setMirror(
                    'sessions',
                    actionId,
                    'messages',
                    reconcile(patch.messages, { key: 'id' }),
                );
            }
            if (patch.inflightId !== undefined) {
                setMirror('sessions', actionId, 'inflightId', patch.inflightId);
            }
            if (patch.error !== undefined) {
                setMirror('sessions', actionId, 'error', patch.error);
            }
            if (patch.usage !== undefined) {
                setMirror('sessions', actionId, 'usage', patch.usage);
            }
            break;
        }
        case 'session-text-append': {
            const { actionId, stepId, delta } = event;
            setMirror(
                'sessions',
                actionId,
                'messages',
                (m: Message) => m.id === stepId,
                produce((m: Message) => {
                    const parts = m.parts ?? (m.parts = []);
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
                }),
            );
            break;
        }
        case 'session-reasoning-append': {
            const { actionId, stepId, delta } = event;
            setMirror(
                'sessions',
                actionId,
                'messages',
                (m: Message) => m.id === stepId,
                produce((m: Message) => {
                    const parts = m.parts ?? (m.parts = []);
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
                }),
            );
            break;
        }
        case 'session-part-added': {
            const { actionId, stepId, part } = event;
            setMirror(
                'sessions',
                actionId,
                'messages',
                (m: Message) => m.id === stepId,
                produce((m: Message) => {
                    (m.parts ?? (m.parts = [])).push(part);
                }),
            );
            break;
        }
        case 'session-part-updated': {
            const { actionId, stepId, toolCallId, patch } = event;
            setMirror(
                'sessions',
                actionId,
                'messages',
                (m: Message) => m.id === stepId,
                produce((m: Message) => {
                    if (!m.parts) return;
                    for (const p of m.parts) {
                        if ('toolCallId' in p && p.toolCallId === toolCallId) {
                            Object.assign(p, patch);
                            return;
                        }
                    }
                }),
            );
            break;
        }
        case 'session-message-appended': {
            const { actionId, message } = event;
            if (!mirror.sessions[actionId]) {
                setMirror('sessions', actionId, {
                    actionId,
                    messages: [],
                    inflightId: null,
                    error: null,
                    usage: { ...ZERO_USAGE },
                });
            }
            setMirror(
                'sessions',
                actionId,
                'messages',
                produce((arr: Message[]) => {
                    arr.push(message);
                }),
            );
            break;
        }
        case 'session-message-aborted': {
            const { actionId, msgId } = event;
            setMirror(
                'sessions',
                actionId,
                'messages',
                (m: Message) => m.id === msgId,
                'aborted',
                true,
            );
            break;
        }
        case 'session-sweep-unresolved': {
            const { actionId, stepId, reason } = event;
            setMirror(
                'sessions',
                actionId,
                'messages',
                (m: Message) => m.id === stepId,
                produce((m: Message) => {
                    if (!m.parts) return;
                    for (const p of m.parts) {
                        if (
                            p.kind === 'tool-call' &&
                            (p.status === 'pending' || p.status === 'running')
                        ) {
                            p.status = 'error';
                            p.error = p.error ?? reason;
                        }
                    }
                }),
            );
            break;
        }
        case 'session-sub-agent-patch': {
            const { actionId, stepId, runId, patch } = event;
            setMirror(
                'sessions',
                actionId,
                'messages',
                (m: Message) => m.id === stepId,
                produce((m: Message) => {
                    if (!m.parts) return;
                    for (const p of m.parts) {
                        if (p.kind === 'sub-agent' && p.runId === runId) {
                            Object.assign(p.run, patch);
                            return;
                        }
                    }
                }),
            );
            break;
        }
        case 'session-sub-agent-message-appended': {
            const { actionId, stepId, runId, message } = event;
            setMirror(
                'sessions',
                actionId,
                'messages',
                (m: Message) => m.id === stepId,
                produce((m: Message) => {
                    if (!m.parts) return;
                    for (const p of m.parts) {
                        if (p.kind === 'sub-agent' && p.runId === runId) {
                            p.run.messages.push(message);
                            p.run.inflightId = message.id;
                            return;
                        }
                    }
                }),
            );
            break;
        }
        case 'session-sub-agent-message-mutated': {
            const { actionId, stepId, runId, childStepId, op } = event;
            setMirror(
                'sessions',
                actionId,
                'messages',
                (m: Message) => m.id === stepId,
                produce((m: Message) => {
                    if (!m.parts) return;
                    for (const p of m.parts) {
                        if (p.kind !== 'sub-agent' || p.runId !== runId) continue;
                        const child = p.run.messages.find((c) => c.id === childStepId);
                        if (!child) return;
                        applyChildOp(child, op);
                        return;
                    }
                }),
            );
            break;
        }
        case 'draft-patch': {
            const { actionId, patch } = event;
            if (patch.removed) {
                setMirror(
                    produce((m) => {
                        delete m.drafts[actionId];
                    }),
                );
                break;
            }
            if (!mirror.drafts[actionId]) {
                setMirror('drafts', actionId, {
                    id: actionId,
                    actionName: patch.actionName ?? '',
                    intent: patch.intent ?? '',
                    action: patch.action,
                    dataSources: patch.dataSources ?? [],
                    code: patch.code,
                    codeKind: patch.codeKind,
                    codeStatus: patch.codeStatus,
                    latestResult: patch.latestResult,
                    versions: patch.versions ?? [],
                    currentVersionId: patch.currentVersionId,
                    inflight: patch.inflight ?? false,
                    pendingReview: patch.pendingReview,
                    viewing: patch.viewing,
                });
                break;
            }
            if (patch.actionName !== undefined) {
                setMirror('drafts', actionId, 'actionName', patch.actionName);
            }
            if (patch.intent !== undefined) {
                setMirror('drafts', actionId, 'intent', patch.intent);
            }
            if (patch.action !== undefined) {
                setMirror('drafts', actionId, 'action', patch.action);
            }
            if (patch.dataSources !== undefined) {
                setMirror(
                    'drafts',
                    actionId,
                    'dataSources',
                    reconcile(patch.dataSources, { key: 'name' }),
                );
            }
            if (patch.code !== undefined) {
                setMirror('drafts', actionId, 'code', patch.code);
            }
            if (patch.codeKind !== undefined) {
                setMirror('drafts', actionId, 'codeKind', patch.codeKind);
            }
            if (patch.codeStatus !== undefined) {
                setMirror('drafts', actionId, 'codeStatus', patch.codeStatus);
            }
            if (patch.latestResult !== undefined) {
                setMirror('drafts', actionId, 'latestResult', patch.latestResult);
            }
            if (patch.versions !== undefined) {
                setMirror('drafts', actionId, 'versions', reconcile(patch.versions, { key: 'id' }));
            }
            if (patch.currentVersionId !== undefined) {
                setMirror('drafts', actionId, 'currentVersionId', patch.currentVersionId);
            }
            if (patch.inflight !== undefined) {
                setMirror('drafts', actionId, 'inflight', patch.inflight);
            }
            // `in` (not `!== undefined`) so an explicit clear-to-undefined
            // patch from the host actually erases the slot — used on commit
            // and cancel of an analysis review.
            if ('pendingReview' in patch) {
                setMirror('drafts', actionId, 'pendingReview', patch.pendingReview);
            }
            if ('viewing' in patch) {
                setMirror('drafts', actionId, 'viewing', patch.viewing);
            }
            break;
        }
        case 'active-action': {
            setMirror('activeActionId', event.activeActionId);
            break;
        }
        case 'action-list-patch': {
            setMirror('recentActions', event.patch.actions);
            break;
        }
        case 'result-patch': {
            setMirror('results', event.resultId, event.result);
            break;
        }
        case 'settings-patch': {
            for (const key of Object.keys(event.patch) as (keyof Settings)[]) {
                if (key === 'providers' && Array.isArray(event.patch.providers)) {
                    setMirror(
                        'settings',
                        'providers',
                        reconcile(event.patch.providers, { key: 'id' }),
                    );
                } else {
                    setMirror('settings', key, event.patch[key] as never);
                }
            }
            break;
        }
        case 'ticket-opened': {
            setMirror('tickets', event.ticket.id, event.ticket);
            break;
        }
        case 'ticket-resolved': {
            setMirror(
                produce((m) => {
                    const t = m.tickets[event.ticketId];
                    if (!t) return;
                    t.state = 'resolved';
                    t.decision = event.decision;
                    t.resolvedAt = Date.now();
                }),
            );
            break;
        }
        case 'ticket-expired': {
            setMirror(
                produce((m) => {
                    const t = m.tickets[event.ticketId];
                    if (!t) return;
                    t.state = 'expired';
                    t.resolvedAt = Date.now();
                }),
            );
            break;
        }
        case 'runtime-restart': {
            location.reload();
            break;
        }
        case 'snapshot-request': {
            const { actionId, requesterId } = event;
            if (requesterId === TAB_ID) break;
            const session = mirror.sessions[actionId];
            if (!session) break;
            const hasInflight =
                session.inflightId !== null ||
                session.messages.some(
                    (m) => m.role === 'assistant' || (m.parts !== undefined && m.parts.length > 0),
                );
            if (!hasInflight) break;
            const draft = mirror.drafts[actionId];
            // Build the payload through JSON so it is guaranteed to be a
            // plain structured-cloneable object graph regardless of Solid
            // store wrapping or any opaque values in tool results.
            const rawSession = unwrap(session);
            const rawDraft = draft ? unwrap(draft) : undefined;
            let snapshotSession: ChatSession;
            let snapshotDraft: ActionDraft | undefined;
            try {
                snapshotSession = JSON.parse(JSON.stringify(rawSession));
                snapshotDraft = rawDraft ? JSON.parse(JSON.stringify(rawDraft)) : undefined;
            } catch (e) {
                console.error('[runtime/client] snapshot-request: JSON serialize failed', e);
                break;
            }
            try {
                publishPeer({
                    kind: 'snapshot-response',
                    actionId,
                    requesterId,
                    session: snapshotSession,
                    draft: snapshotDraft,
                });
            } catch (e) {
                console.error('[runtime/client] snapshot-response publishPeer threw', e);
            }
            break;
        }
        case 'snapshot-response': {
            const { actionId, requesterId, session, draft } = event;
            if (requesterId !== TAB_ID) break;
            setMirror('sessions', actionId, session);
            if (draft) setMirror('drafts', actionId, draft);
            break;
        }
    }
}

/**
 * Ask any peer tab that owns live state for this action to send a
 * snapshot. Called when this tab opens an action; if a peer responds,
 * the mirror is replaced with the peer's authoritative view.
 */
function requestSnapshot(actionId: string): void {
    publishPeer({
        kind: 'snapshot-request',
        actionId,
        requesterId: TAB_ID,
    });
}

// --- Public API ---------------------------------------------------------

/** Promise that resolves when the initial host snapshot has hydrated
 * the mirror. UI may render before this resolves; the mirrors just look
 * empty until then. */
export function whenHydrated(): Promise<void> {
    bootstrap();
    return hydrationPromise ?? Promise.resolve();
}

// Reactive accessors — call inside components / effects.

export function useSession(actionId: string | undefined): ChatSession | undefined {
    if (!actionId) return undefined;
    return mirror.sessions[actionId];
}

export function useDraft(actionId: string | undefined): ActionDraft | undefined {
    if (!actionId) return undefined;
    return mirror.drafts[actionId];
}

export function useActiveActionId(): string | undefined {
    return mirror.activeActionId;
}

export function useActiveDraft(): ActionDraft | undefined {
    const id = mirror.activeActionId;
    return id ? mirror.drafts[id] : undefined;
}

export function useRecentActions(): Action[] {
    return mirror.recentActions;
}

export function useSettings(): Settings {
    return mirror.settings;
}

/**
 * Look up a model entry by its fully-qualified id across all providers,
 * falling back to the first available model (or the compiled-in default)
 * when not found. Reads `mirror.settings.providers`, so call from inside a
 * tracking context if you want reactivity.
 */
export function findModelEntry(id: string): ModelEntry {
    return findModelEntryIn(mirror.settings.providers, id);
}

export function useTicket(ticketId: string): Ticket | undefined {
    return mirror.tickets[ticketId];
}

export function useResult(resultId: string | undefined): ActionExecution | undefined {
    if (!resultId) return undefined;
    return mirror.results[resultId];
}

const inflightResults = new Set<string>();

/** Reactive read with side-effect: if the mirror doesn't have this
 * result yet, kick off a fetch. The resulting `result-patch` broadcast
 * (self-delivered) populates the mirror and re-triggers the reader. */
export function getResult(id: string): ActionExecution | undefined {
    const cached = mirror.results[id];
    if (cached) return cached;
    if (!inflightResults.has(id)) {
        inflightResults.add(id);
        void runtime
            .fetchResult(id)
            .then((res) => {
                if (res) {
                    // host.getResult populates the cache but does not
                    // broadcast on a cache hit; mirror manually so the
                    // reactive reader picks it up.
                    setMirror('results', id, res);
                }
            })
            .catch((e) => {
                console.warn('[runtime/client] fetchResult failed', e);
            })
            .finally(() => {
                inflightResults.delete(id);
            });
    }
    return undefined;
}

export function isResultLoading(id: string): boolean {
    const cached = mirror.results[id];
    if (cached) return false;
    if (!inflightResults.has(id)) {
        getResult(id);
    }
    return true;
}

// Command shortcuts that route to the tab-local host.

export const runtime = {
    submit(
        actionId: string | undefined,
        text: string,
        modelId: string,
        dataSourceId?: string,
    ): Promise<{ actionId: string }> {
        bootstrap();
        return host.submitMessage(actionId, text, modelId, dataSourceId);
    },
    abort(actionId: string): Promise<void> {
        return host.abortSession(actionId);
    },
    newAction(): Promise<{ actionId: string }> {
        bootstrap();
        return host.newAction();
    },
    clearSession(actionId: string): Promise<void> {
        return host.clearSession(actionId);
    },
    resolveTicket(ticketId: string, decision: ConfirmationDecision): Promise<void> {
        return host.resolveTicket(ticketId, decision);
    },
    /**
     * Decide a button confirmation (`analysis-review` thumbs-up/down). Resolves
     * the live ticket when this tab owns the loop; otherwise (post-reload)
     * commits/rejects the persisted candidate directly. See
     * `host.decideConfirmation`.
     */
    decideConfirmation(
        actionId: string,
        ticketId: string,
        decision: ConfirmationDecision,
    ): Promise<void> {
        bootstrap();
        return host.decideConfirmation(actionId, ticketId, decision);
    },
    /**
     * Answer a chat-answered confirmation (ask_user "Other" / analysis-review
     * "Revise draft") with composer text. Resumes the live loop when this tab
     * owns it; otherwise (post-reload / different tab) restarts the turn from
     * the persisted chat log. See `host.answerPendingConfirmation`.
     */
    answerPendingConfirmation(
        actionId: string,
        ticketId: string,
        text: string,
        modelId: string,
    ): Promise<void> {
        bootstrap();
        return host.answerPendingConfirmation(actionId, ticketId, text, modelId);
    },
    async setActiveAction(actionId: string): Promise<void> {
        await host.setActiveAction(actionId);
        // Ask any peer running this action for a fresh snapshot. If one
        // responds, applyEvent for `snapshot-response` overwrites the
        // IDB-hydrated state with the peer's live view. If no peer has
        // it, this is a no-op and the IDB hydration stays in effect.
        requestSnapshot(actionId);
    },
    clearActiveAction(): Promise<void> {
        return host.clearActiveAction();
    },
    rerunAction(actionId: string): Promise<ActionExecution> {
        return host.rerunAction(actionId);
    },
    deleteAction(actionId: string): Promise<void> {
        return host.deleteAction(actionId);
    },
    renameAction(actionId: string, name: string): Promise<void> {
        return host.renameAction(actionId, name);
    },
    focusVersion(actionId: string, versionId: string): Promise<void> {
        return host.focusVersion(actionId, versionId);
    },
    /** Preview a committed version (with its stored result) while a candidate
     * is under review, without committing the focus. See host.previewVersion. */
    previewVersion(actionId: string, versionId: string): Promise<void> {
        return host.previewVersion(actionId, versionId);
    },
    setViewing(actionId: string, viewing: import('./api').DraftViewing | undefined): Promise<void> {
        return host.setViewing(actionId, viewing);
    },
    revertToVersion(actionId: string, versionId: string): Promise<ActionExecution> {
        return host.revertToVersion(actionId, versionId);
    },
    fetchResult(resultId: string): Promise<ActionExecution | undefined> {
        return host.getResult(resultId);
    },
    listResultsForAction(actionId: string): Promise<ActionExecution[]> {
        return host.listResultsForAction(actionId);
    },
    listRecentActions(limit: number): Promise<Action[]> {
        return host.listRecentActions(limit);
    },
    patchSettings(patch: Partial<Settings>): Promise<void> {
        return host.patchSettings(patch);
    },
    resetSettings(): Promise<void> {
        return host.resetSettings();
    },
    forceRestart(): Promise<void> {
        return host.forceRestart();
    },
};

/** Update the recent-actions cache opportunistically. */
export function setRecentActionsCache(actions: Action[]): void {
    setMirror('recentActions', actions);
}

// Bootstrap on first import. Consumers that need to wait for initial
// state should await whenHydrated().
bootstrap();

// Re-export the types for convenience.
export type { ChatSession, ActionDraft, Ticket, Settings, Action, ActionExecution };
export type { ActionListPatch };
