/**
 * Tab-side runtime host. Owns the agent loop, the in-memory state
 * modules, and IDB persistence for the *actions this tab is running*.
 *
 * Every state mutation goes through the state modules in `./state/*`,
 * which call `publish(event)` from `./state/broadcast`. `publish` both
 * self-delivers to this tab's Solid mirror (registered via
 * `setLocalListener`) and posts on `BroadcastChannel('rh-runtime')` so
 * peer tabs see committed updates.
 *
 * No SharedWorker: each tab is independently capable of running an agent.
 * The Web Lock acquired in `submitMessage` keyed by `actionId` ensures
 * at most one tab runs a given action at a time; peer tabs observe state
 * via broadcasts.
 */

import type {
    Action,
    ActionExecution,
    ConfirmationDecision,
    DraftViewing,
    RuntimeSnapshot,
} from './api';
import { findModelEntryIn, type Settings } from './state/settings-types';
import * as sessions from './state/sessions';
import * as drafts from './state/drafts';
import * as results from './state/results';
import * as tickets from './state/tickets';
import * as settingsState from './state/settings';
import { buildRuntimeControls } from './agent-controls';
import { runAgent } from '@/lib/agent/loop';
import { orchestratorAgent } from '@/lib/agent/agents/orchestrator';
import { resetSanitizer } from '@/lib/agent/sample-sanitizer';
import {
    deleteAction as idbDeleteAction,
    getAction as idbGetAction,
    listRecentActions as idbListRecentActions,
    putAction as idbPutAction,
} from '@/lib/actions/store';
import { rerunAction as runRerun } from '@/lib/actions/rerun';
import { executeAction } from '@/lib/actions/executor';
import { commitReviewCandidate } from '@/lib/actions/commit-review';
import type { PersistedPendingReview } from '@/lib/actions/types';
import type { Message } from '@/lib/types';
import { addLocalEventTap, publish } from './state/broadcast';
import type { RuntimeEvent } from './api';
import { getSqliteDb } from '@/lib/sqlite/client';
import { computeStepCost, extractUsageCounts } from '@/lib/agent/cost';

export async function getSnapshot(): Promise<RuntimeSnapshot> {
    await settingsState.whenReady();
    return {
        sessions: sessions.snapshotSessions(),
        drafts: drafts.snapshotDrafts(),
        activeActionId: drafts.getActiveActionId(),
        results: results.snapshotResults(),
        tickets: tickets.snapshotTickets(),
        settings: settingsState.getSettings(),
    };
}

export async function submitMessage(
    actionId: string | undefined,
    text: string,
    modelId: string,
    dataSourceId?: string,
): Promise<{ actionId: string }> {
    // Settings drive apiKey and pricing; block until IDB load resolves so
    // the first message of a fresh tab doesn't run against defaults.
    await settingsState.whenReady();

    let id = actionId;
    if (!id) {
        id = crypto.randomUUID();
        drafts.beginDraft({ id, actionName: 'New Action', intent: text });
    } else if (!drafts.getDraft(id)) {
        const found = await drafts.setActiveAction(id);
        if (!found) {
            drafts.beginDraft({ id, actionName: 'New Action', intent: text });
        }
    }

    sessions.ensureSession(id);

    const userMsg: Message = {
        id: crypto.randomUUID(),
        role: 'user',
        content: text,
        createdAt: Date.now(),
    };
    const history = [...(sessions.getSession(id)?.messages ?? [])];
    sessions.appendMessage(id, userMsg);
    sessions.setError(id, null);

    await persistChat(id, dataSourceId);

    const ac = new AbortController();
    sessions.setAbortController(id, ac);

    // Fire and forget. The caller doesn't await the agent loop; the UI
    // observes state via the Solid mirror (driven by local self-deliver
    // + cross-tab broadcasts).
    void runAgentBackground(id, text, history, modelId, ac);

    return { actionId: id };
}

/**
 * Try to acquire an exclusive Web Lock keyed by `actionId` for the
 * duration of an agent run. `ifAvailable: true` means we either get the
 * lock immediately or return null — no queueing across tabs.
 *
 * The returned `release` resolves the inner Promise the Lock API is
 * holding for us, freeing the lock. The lock also releases automatically
 * if this tab is torn down (browser guarantee), so a closed-mid-run tab
 * frees the action for the next tab.
 */
async function acquireActionLock(
    actionId: string,
    _signal: AbortSignal,
): Promise<{ release: () => void } | null> {
    const lockName = `analyst-action:${actionId}`;
    let release!: () => void;
    let acquired = false;
    const holderResolved = new Promise<void>((resolve) => {
        release = resolve;
    });
    const acquisition = new Promise<boolean>((resolve, reject) => {
        navigator.locks
            .request(lockName, { ifAvailable: true }, async (lock) => {
                if (!lock) {
                    resolve(false);
                    return;
                }
                acquired = true;
                resolve(true);
                // Hold the lock until release() is called.
                await holderResolved;
            })
            .catch((e) => {
                if (!acquired) reject(e);
            });
    });
    const ok = await acquisition;
    return ok ? { release } : null;
}

async function runAgentBackground(
    actionId: string,
    text: string,
    history: Message[],
    modelId: string,
    ac: AbortController,
): Promise<void> {
    // Take an exclusive Web Lock so a peer tab can't start a second
    // concurrent run for the same action. If we can't get it, the user's
    // message has already landed in the session; flag the error and bail.
    const acquired = await acquireActionLock(actionId, ac.signal);
    if (!acquired) {
        sessions.setError(actionId, 'This action is already running in another tab.');
        sessions.setInflightId(actionId, null);
        sessions.setAbortController(actionId, null);
        await persistChat(actionId);
        return;
    }
    const { release } = acquired;
    try {
        const definition = orchestratorAgent();
        await runAgent({
            definition,
            userText: text,
            history,
            controls: buildRuntimeControls(actionId),
            signal: ac.signal,
            modelId,
            onStepUsage: (usage, modelId) => {
                const entry = findModelEntryIn(settingsState.getSettings().providers, modelId);
                const counts = extractUsageCounts(usage);
                sessions.addUsage(actionId, {
                    ...counts,
                    costUsd: computeStepCost(usage, entry?.pricing),
                });
            },
        });
    } catch (e: unknown) {
        const err = e as { name?: string; message?: string };
        const isAbort = err.name === 'AbortError';
        if (!isAbort) {
            sessions.setError(actionId, err.message ?? String(e));
        }
        const inflight = sessions.getSession(actionId)?.inflightId;
        if (inflight) sessions.markMessageAborted(actionId, inflight);
    } finally {
        tickets.expireTicketsForAction(actionId);
        sessions.setInflightId(actionId, null);
        sessions.setAbortController(actionId, null);
        await persistChat(actionId);
        release();
    }
}

export async function abortSession(actionId: string): Promise<void> {
    sessions.abortSession(actionId);
    tickets.expireTicketsForAction(actionId);
}

export async function newAction(): Promise<{ actionId: string }> {
    const id = crypto.randomUUID();
    drafts.beginDraft({ id, actionName: 'New Action', intent: '' });
    sessions.ensureSession(id);
    return { actionId: id };
}

export async function clearSession(actionId: string): Promise<void> {
    sessions.clearSession(actionId);
    tickets.expireTicketsForAction(actionId);
}

export async function resolveTicket(
    ticketId: string,
    decision: ConfirmationDecision,
): Promise<void> {
    tickets.resolveTicket(ticketId, decision);
}

/**
 * Answer a chat-input confirmation (the `ask_user` "Other" path or the
 * analysis-review "Revise draft" follow-up) with text typed into the main
 * composer.
 *
 * On the tab that is actively running the loop this resolves the live ticket
 * and the parked agent resumes — the original behaviour. But after a window
 * reload (or when the chat is reopened in a tab that never ran it) the agent
 * loop, its AbortController, and the ticket's `Deferred` are all gone: only
 * the persisted chat log survives, with the confirmation card still showing
 * `approved: null`. Resolving the ticket then no-ops, so typing did nothing —
 * the bug this fixes.
 *
 * In that orphaned case the parked loop cannot be resumed (its async stack is
 * gone), so we mark the card answered and START A FRESH TURN from the chat
 * log with the typed text as a new user message. `buildInitialMessages`
 * reduces history to plain text (tool-calls/confirmations stripped), so the
 * dangling `work_on_action` call in the log causes no invalid message
 * sequence; the orchestrator re-reads the restored draft state and continues.
 */
export async function answerPendingConfirmation(
    actionId: string,
    ticketId: string,
    text: string,
    modelId: string,
): Promise<void> {
    const decision: ConfirmationDecision = {
        approved: true,
        response: { choiceId: null, freeText: text },
    };
    // Live loop in this tab → resume it exactly as before.
    if (tickets.resolveTicket(ticketId, decision)) return;
    // Orphaned (reload / different tab). Settle the card, then re-run the turn.
    sessions.resolveConfirmationPart(actionId, ticketId, decision);
    await submitMessage(actionId, text, modelId);
}

/**
 * Decide a button confirmation (the `analysis-review` thumbs-up/down card).
 *
 * On the tab running the loop this resolves the live ticket and the parked
 * orchestrator commits/rejects — unchanged. After a reload the ticket's
 * Deferred is gone, so clicking would no-op; instead we settle the card and
 * drive the outcome directly from the persisted candidate (restored into the
 * draft's `pendingReview` on hydration): thumbs-up commits a version, thumbs-
 * down clears the candidate so the user can type the next change as a fresh
 * turn. Other orphaned renderers fall through to the legacy no-op.
 */
export async function decideConfirmation(
    actionId: string,
    ticketId: string,
    decision: ConfirmationDecision,
): Promise<void> {
    if (tickets.resolveTicket(ticketId, decision)) return;
    const part = sessions.findConfirmationPart(actionId, ticketId);
    // Only the analysis-review card can be commit/rejected from the persisted
    // candidate; and only while still pending (guards a double-click commit).
    if (!part || part.approved !== null || part.rendererId !== 'analysis-review') return;
    sessions.resolveConfirmationPart(actionId, ticketId, decision);
    if (decision.approved) await commitReview(actionId);
    else await rejectReview(actionId);
}

/**
 * Commit the draft's review candidate after a reload — the orphaned
 * counterpart of the orchestrator's thumbs-up block. Materializes the version
 * via the shared `commitReviewCandidate`, updates the draft, and drops a
 * "vN saved" chip into the chat (there is no live step to attach it to).
 */
export async function commitReview(actionId: string): Promise<void> {
    const draft = drafts.getDraft(actionId);
    const pr = draft?.pendingReview;
    if (!draft?.action || !pr?.result) return;
    const result = pr.result;
    let committed: Awaited<ReturnType<typeof commitReviewCandidate>>;
    try {
        committed = await commitReviewCandidate({
            action: draft.action,
            actionName: draft.actionName,
            intent: pr.intent,
            code: pr.code,
            kind: pr.codeKind,
            dataSources: pr.dataSources,
            baseVersionId: pr.baseVersionId,
            result,
        });
    } catch (e) {
        console.warn('[runtime/host] commitReview failed', e);
        sessions.setError(actionId, e instanceof Error ? e.message : String(e));
        return;
    }
    drafts.attachResult(actionId, result);
    drafts.finalizeVersion(actionId, committed.version, committed.finalAction);
    drafts.clearPendingReview(actionId);
    sessions.appendMessage(actionId, {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: '',
        createdAt: Date.now(),
        parts: [
            {
                kind: 'action-result-link',
                resultId: result.id,
                actionName: committed.finalAction.name,
                versionIndex: committed.versionIndex,
                createdAt: Date.now(),
            },
        ],
    });
    await persistChat(actionId);
}

/**
 * Reject the draft's review candidate after a reload. Clears the candidate
 * (draft + the durable `Action.pendingReview` via persistChat) so the panel's
 * draft pill goes away; the user types what to change as a normal message,
 * which starts a fresh turn.
 */
export async function rejectReview(actionId: string): Promise<void> {
    drafts.clearPendingReview(actionId);
    await persistChat(actionId);
}

export async function setActiveAction(actionId: string): Promise<void> {
    await drafts.setActiveAction(actionId);
    const draft = drafts.getDraft(actionId);
    const session = sessions.getSession(actionId);
    if (
        draft?.action?.chatLog &&
        draft.action.chatLog.length > 0 &&
        (!session || session.messages.length === 0)
    ) {
        sessions.setMessages(actionId, [...draft.action.chatLog]);
    }
    if (draft?.action?.usage && (!session || session.usage.costUsd === 0)) {
        sessions.setUsage(actionId, draft.action.usage);
    }
}

export async function clearActiveAction(): Promise<void> {
    drafts.clearActiveAction();
}

export async function listRecentActions(limit: number): Promise<Action[]> {
    return await idbListRecentActions(limit);
}

export async function getAction(actionId: string): Promise<Action | undefined> {
    return await idbGetAction(actionId);
}

export async function deleteAction(actionId: string): Promise<void> {
    await idbDeleteAction(actionId);
    publish({
        kind: 'action-list-patch',
        patch: { actions: await idbListRecentActions(50) },
    });
}

export async function renameAction(actionId: string, name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) return;
    const current = await idbGetAction(actionId);
    if (!current) return;
    if (current.name === trimmed) return;
    const updated: Action = {
        ...current,
        name: trimmed,
        updatedAt: Date.now(),
    };
    await idbPutAction(updated);
    drafts.attachAction(actionId, updated);
    publish({
        kind: 'action-list-patch',
        patch: { actions: await idbListRecentActions(50) },
    });
}

export async function rerunAction(actionId: string): Promise<ActionExecution> {
    const exec = await runRerun(actionId);
    if (!exec) throw new Error(`Action ${actionId} not found`);
    drafts.attachResult(actionId, exec);
    return exec;
}

export async function focusVersion(actionId: string, versionId: string): Promise<void> {
    // Read this version's last STORED result up front — the only IDB read — so
    // the focus + result updates apply back-to-back below with no
    // "No execution yet" flash between two separately-awaited emits. Switching
    // versions shows the stored result instantly; re-executing (unbounded SQL +
    // sandbox) is the explicit "Re-run" button, not a side effect of a click.
    const stored = await loadStoredResultForVersion(actionId, versionId);
    await drafts.focusVersion(actionId, versionId);
    if (stored) drafts.attachResult(actionId, stored);
    const draft = drafts.getDraft(actionId);
    if (!draft?.action) return;
    const version = draft.versions.find((v) => v.id === versionId);
    if (!version) return;
    const updated: Action = {
        ...draft.action,
        code: version.code,
        kind: version.kind,
        dataSources: version.dataSources,
        currentVersionId: version.id,
        // Preserve updatedAt — focusing a version is navigation, not an edit.
        // Bumping it reordered Recents and tripped the sidebar's updatedAt-keyed
        // refetch (the "Loading…" flash + full list remount on every click).
        updatedAt: draft.action.updatedAt,
    };
    await idbPutAction(updated);
    drafts.attachAction(actionId, updated);
}

/**
 * Preview a committed version while a candidate is under review — switches the
 * panel's display to the version (with its stored result) without committing or
 * refocusing, so the review's base + currentVersionId stay intact. The
 * companion to `focusVersion` for the pendingReview path.
 */
export async function previewVersion(actionId: string, versionId: string): Promise<void> {
    const stored = await loadStoredResultForVersion(actionId, versionId);
    drafts.setViewing(actionId, { kind: 'version', id: versionId });
    if (stored) drafts.attachResult(actionId, stored);
}

/**
 * Most recent stored execution for a version, or undefined when none exists
 * (the panel then shows "No execution yet" and the user can Re-run). Used to
 * display a version's result on switch without re-executing it.
 */
async function loadStoredResultForVersion(
    actionId: string,
    versionId: string,
): Promise<ActionExecution | undefined> {
    try {
        const all = await results.listResultsForAction(actionId);
        let latest: ActionExecution | undefined;
        for (const r of all) {
            if (r.versionId !== versionId) continue;
            if (!latest || r.finishedAt > latest.finishedAt) latest = r;
        }
        return latest;
    } catch (e) {
        console.warn('[runtime/host] loadStoredResultForVersion failed', e);
        return undefined;
    }
}

/**
 * Switch which slot the side panel displays (committed version vs. the
 * pendingReview draft). No persistence — purely a UI focus signal. The
 * orchestrator's review loop doesn't depend on it; the user can flip
 * back and forth freely while the loop is awaiting their decision.
 */
export async function setViewing(
    actionId: string,
    viewing: DraftViewing | undefined,
): Promise<void> {
    drafts.setViewing(actionId, viewing);
}

export async function revertToVersion(
    actionId: string,
    versionId: string,
): Promise<ActionExecution> {
    await focusVersion(actionId, versionId);
    const action = drafts.getDraft(actionId)?.action;
    if (!action) throw new Error(`Action ${actionId} not found`);
    const exec = await executeAction(action);
    exec.versionId = versionId;
    results.putResult(exec);
    drafts.attachResult(actionId, exec);
    await setActiveAction(actionId);
    return exec;
}

export async function getResult(resultId: string): Promise<ActionExecution | undefined> {
    return await results.getResult(resultId);
}

export async function listResultsForAction(actionId: string): Promise<ActionExecution[]> {
    return await results.listResultsForAction(actionId);
}

export async function patchSettings(patch: Partial<Settings>): Promise<void> {
    await settingsState.whenReady();
    settingsState.patchSettings(patch);
}

export async function resetSettings(): Promise<void> {
    await settingsState.whenReady();
    settingsState.resetSettings();
}

/**
 * Broadcast a restart signal so every connected tab reloads. With no
 * SharedWorker to terminate, a reload is sufficient to pick up code
 * changes. The local listener will also receive the broadcast and
 * reload this tab.
 */
export async function forceRestart(): Promise<void> {
    publish({ kind: 'runtime-restart' });
}

/**
 * Write the current chat as a stub Action to IDB so reloads can restore
 * the conversation. Mirrors what the SharedWorker version did.
 *
 * `refreshRecentList` controls whether the sidebar's recent-actions list is
 * re-read + broadcast afterwards. The explicit callers (submit, end-of-turn)
 * pass true so a freshly created/renamed action appears in the sidebar; the
 * high-frequency auto-persist (every session change) passes false to skip the
 * extra IDB read + cross-tab broadcast on every keystroke/token.
 */
async function persistChat(
    actionId: string,
    initialDataSourceId?: string,
    refreshRecentList = true,
): Promise<void> {
    const session = sessions.getSession(actionId);
    if (!session || session.messages.length === 0) return;
    const draft = drafts.getDraft(actionId);
    const existing = draft?.action ?? (await idbGetAction(actionId));
    const now = Date.now();
    // Persist the in-review candidate (if any) so a reload can render + commit
    // it. Mirrors the in-memory `draft.pendingReview`; the result row is already
    // in the results store, so only its id is carried. Undefined here clears a
    // previously-persisted review on commit/reject/cancel.
    const pr = draft?.pendingReview;
    const pendingReview: PersistedPendingReview | undefined =
        pr && draft
            ? {
                  actionName: draft.actionName,
                  intent: pr.intent,
                  code: pr.code,
                  kind: pr.codeKind,
                  dataSources: structuredClone(pr.dataSources),
                  baseVersionId: pr.baseVersionId,
                  resultId: pr.result?.id,
              }
            : undefined;
    const action: Action = existing
        ? {
              ...existing,
              // While a candidate is under review the user-facing name lives on
              // the draft (the persisted Action may still be the "New Action"
              // stub); surface it so a reload shows the real title.
              name: pendingReview ? pendingReview.actionName : existing.name,
              chatLog: structuredClone(session.messages),
              updatedAt: now,
              dataSourceId: existing.dataSourceId ?? initialDataSourceId,
              usage: { ...session.usage },
              pendingReview,
          }
        : {
              id: actionId,
              name: pendingReview?.actionName ?? 'New Action',
              description: '',
              dataSources: [],
              code: null,
              chatLog: structuredClone(session.messages),
              createdAt: now,
              updatedAt: now,
              dataSourceId: initialDataSourceId,
              usage: { ...session.usage },
              pendingReview,
          };
    try {
        await idbPutAction(action);
        drafts.attachAction(actionId, action);
        if (refreshRecentList) {
            publish({
                kind: 'action-list-patch',
                patch: { actions: await idbListRecentActions(50) },
            });
        }
    } catch (e) {
        console.warn('[runtime/host] persistChat failed', e);
    }
}

/**
 * Debounced auto-persist: every session-state change (a part added, a
 * confirmation decision recorded, a streamed delta, …) schedules a write of
 * the chat to IDB. This is what makes the chat the durable source of truth —
 * e.g. a thumbs-up/down decision survives a reload even if the agent loop is
 * still parked mid-turn, instead of only being saved at end-of-turn.
 *
 * Coalesced per-action so a burst of streaming deltas collapses into one write
 * once it quiets down; the explicit end-of-turn persist still runs in
 * `runAgentBackground`'s finally for the authoritative final flush.
 */
const PERSIST_DEBOUNCE_MS = 400;
const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleAutoPersist(actionId: string): void {
    const existing = persistTimers.get(actionId);
    if (existing !== undefined) clearTimeout(existing);
    persistTimers.set(
        actionId,
        setTimeout(() => {
            persistTimers.delete(actionId);
            void persistChat(actionId, undefined, false);
        }, PERSIST_DEBOUNCE_MS),
    );
}

let autoPersistRegistered = false;
function registerAutoPersist(): void {
    if (autoPersistRegistered) return;
    autoPersistRegistered = true;
    addLocalEventTap((event: RuntimeEvent) => {
        // A `draft-patch` that opens/updates/clears a review candidate must be
        // persisted too — `pendingReview` lives on the draft, not in the chat
        // log, and the session-only trigger below would miss it (so a reload
        // would lose the candidate). `pushPendingReview` / `attachPendingResult`
        // / `clearPendingReview` all emit `pendingReview` in their patch.
        if (event.kind === 'draft-patch') {
            // Only when a candidate is actually PRESENT — `pushPendingReview` /
            // `attachPendingResult`. We deliberately ignore the `undefined`
            // (cleared) case: `clearPendingReview` is always followed by an
            // explicit `persistChat` (host commit/reject) or the end-of-turn
            // flush, and reacting to it here would also fire on every action
            // open (hydration emits the key), needlessly bumping `updatedAt`.
            if (event.patch.pendingReview != null) scheduleAutoPersist(event.actionId);
            return;
        }
        // Fine-grained session-* events (message-appended, text/reasoning
        // deltas, part add/update, sub-agent, abort, sweep) are real chat
        // mutations worth persisting. The bulk `session-patch`, by contrast, is
        // either HYDRATION (`setMessages`/`setUsage` when an action is opened)
        // or a transient toggle (`inflightId`/`error`) — never new content. It
        // must NOT trigger a persist: doing so rewrote the action with a fresh
        // `updatedAt` on every action OPEN, bumping it to the top of Recents.
        // (Usage/content reach IDB via the fine-grained events + end-of-turn.)
        if (!event.kind.startsWith('session') || event.kind === 'session-patch') return;
        const actionId = (event as { actionId?: string }).actionId;
        if (typeof actionId === 'string') scheduleAutoPersist(actionId);
    });
}

/**
 * One-time tab boot: reset the PII sanitizer dictionaries (per-session
 * artifact), then seed the demo db idempotently so the first
 * `list_tables` call sees populated data.
 */
let bootStarted = false;
export function boot(): void {
    if (bootStarted) return;
    bootStarted = true;
    registerAutoPersist();
    resetSanitizer();
    void (async () => {
        try {
            const db = await getSqliteDb();
            await db.seed();
        } catch (e) {
            console.warn('[runtime/host] initial seed failed', e);
        }
    })();
}
