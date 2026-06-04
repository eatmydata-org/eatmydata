import type {
    Action,
    ActionKind,
    ActionVersion,
    ActionExecution,
    ActionDraft,
    DataSource,
    DraftDataSourcePreview,
    DraftPatch,
    DraftViewing,
    PendingReview,
    CodeStatus,
} from '@/lib/runtime/api';
import { publish, publishLocal } from './broadcast';
import {
    getAction as idbGetAction,
    listVersionsForAction as idbListVersions,
    listResultsForAction as idbListResults,
    getActionVersion as idbGetVersion,
} from '@/lib/actions/store';

const drafts = new Map<string, ActionDraft>();
let activeId: string | undefined = undefined;

function emitDraft(actionId: string, patch: DraftPatch): void {
    publish({ kind: 'draft-patch', actionId, patch });
}

function emitDraftLocal(actionId: string, patch: DraftPatch): void {
    publishLocal({ kind: 'draft-patch', actionId, patch });
}

/**
 * active-action is tab-local UI focus: each tab follows its own URL.
 * Always local-only — broadcasting would yank peer tabs to whatever
 * action this tab focuses.
 */
function emitActive(): void {
    publishLocal({ kind: 'active-action', activeActionId: activeId });
}

export function getDraft(id: string): ActionDraft | undefined {
    return drafts.get(id);
}

export function getActiveDraft(): ActionDraft | undefined {
    return activeId ? drafts.get(activeId) : undefined;
}

/** Alias of `getActiveDraft` matching the legacy
 * `@/lib/actions/action-live-store` API so agent code can import the
 * same name unchanged. */
export const activeAction = getActiveDraft;

export function getActiveActionId(): string | undefined {
    return activeId;
}

export function snapshotDrafts(): Record<string, ActionDraft> {
    const out: Record<string, ActionDraft> = {};
    for (const [k, v] of drafts) out[k] = v;
    return out;
}

/**
 * Default stub name used by the `submitMessage` first-message path
 * before the orchestrator has decided what to call the action. We
 * never want this to overwrite a real user-facing name that an earlier
 * `work_on_action` round already stamped on the draft.
 */
const STUB_ACTION_NAME = 'New Action';

/**
 * Preserve the existing user-visible name when a caller is about to
 * overwrite it with the stub `'New Action'`. This catches two real
 * regression paths uncovered in log1.txt:
 *
 *   1. `submitMessage` recreates a stub draft on the next user turn
 *      after a rejection-with-feedback (the UI lost the actionId).
 *   2. The chat model passes `name: 'New Action'` on a follow-up
 *      `work_on_action` call instead of the prior actionName.
 *
 * Without this guard, ACTIVE ACTION CONTEXT on the next prompt step
 * shows `"New Action"` and the orchestrator thinks it's a fresh
 * action — triggering a create_new path that mis-routes the iteration.
 */
function resolveActionName(existing: ActionDraft | undefined, incoming: string): string {
    const trimmedIncoming = incoming.trim();
    const trimmedExisting = existing?.actionName.trim() ?? '';
    if (
        trimmedIncoming === STUB_ACTION_NAME &&
        trimmedExisting &&
        trimmedExisting !== STUB_ACTION_NAME
    ) {
        console.warn(
            `[drafts] refusing to overwrite actionName "${trimmedExisting}" with stub "${STUB_ACTION_NAME}" — keeping existing name (F1 guard)`,
        );
        return trimmedExisting;
    }
    return incoming;
}

export function beginDraft(args: {
    id: string;
    actionName: string;
    intent: string;
    baseAction?: Action;
    baseVersion?: ActionVersion;
    versions?: ActionVersion[];
}): string {
    const seed = args.baseVersion;
    const existing = drafts.get(args.id);
    const actionName = resolveActionName(existing, args.actionName);
    const draft: ActionDraft = {
        id: args.id,
        actionName,
        intent: args.intent,
        action: args.baseAction,
        dataSources: seed ? versionDataSourcesToPreviews(seed) : [],
        code: seed?.code,
        codeKind: seed?.kind,
        codeStatus: seed ? 'approved' : undefined,
        versions: args.versions ?? [],
        currentVersionId: args.baseAction?.currentVersionId ?? seed?.id,
        inflight: true,
    };
    drafts.set(draft.id, draft);
    emitDraft(draft.id, draftAsPatch(draft));
    if (activeId !== draft.id) {
        activeId = draft.id;
        emitActive();
    }
    return draft.id;
}

export function pushDataSources(draftId: string, previews: DraftDataSourcePreview[]): void {
    const d = drafts.get(draftId);
    if (!d) return;
    d.dataSources = previews;
    emitDraft(draftId, { dataSources: previews });
}

export function pushCode(
    draftId: string,
    code: string,
    status: CodeStatus,
    kind?: ActionKind,
): void {
    const d = drafts.get(draftId);
    if (!d) return;
    d.code = code;
    d.codeStatus = status;
    if (kind !== undefined) d.codeKind = kind;
    emitDraft(draftId, {
        code,
        codeStatus: status,
        ...(kind !== undefined ? { codeKind: kind } : {}),
    });
}

export function attachResult(draftId: string, result: ActionExecution): void {
    const d = drafts.get(draftId);
    if (!d) return;
    d.latestResult = result;
    emitDraft(draftId, { latestResult: result });
}

/**
 * Seed the pendingReview slot with a candidate version (code + data
 * sources + intent + base version). Auto-flips `viewing` to draft so
 * the side panel surfaces the candidate immediately. `result` is filled
 * in afterward via {@link attachPendingResult} once executeAction
 * finishes. Used by the orchestrator's review loop, NOT persisted.
 */
export function pushPendingReview(draftId: string, pending: PendingReview): void {
    const d = drafts.get(draftId);
    if (!d) return;
    d.pendingReview = pending;
    d.viewing = { kind: 'draft' };
    emitDraft(draftId, {
        pendingReview: pending,
        viewing: { kind: 'draft' },
    });
}

export function attachPendingResult(draftId: string, result: ActionExecution): void {
    const d = drafts.get(draftId);
    if (!d?.pendingReview) return;
    d.pendingReview = { ...d.pendingReview, result };
    emitDraft(draftId, { pendingReview: d.pendingReview });
}

/** Drop the candidate. Called after a successful commit (the draft has
 * been materialized into a real ActionVersion) or when the user cancels
 * the review. Resets viewing to the (now-current) committed version. */
export function clearPendingReview(draftId: string): void {
    const d = drafts.get(draftId);
    if (!d) return;
    d.pendingReview = undefined;
    d.viewing = d.currentVersionId ? { kind: 'version', id: d.currentVersionId } : undefined;
    emitDraft(draftId, {
        pendingReview: undefined,
        viewing: d.viewing,
    });
}

export function setViewing(draftId: string, viewing: DraftViewing | undefined): void {
    const d = drafts.get(draftId);
    if (!d) return;
    d.viewing = viewing;
    emitDraft(draftId, { viewing });
}

export function finalizeVersion(draftId: string, version: ActionVersion, action: Action): void {
    const d = drafts.get(draftId);
    if (!d) return;
    d.action = action;
    d.actionName = action.name;
    if (!d.versions.some((v) => v.id === version.id)) {
        d.versions = [...d.versions, version];
    }
    d.currentVersionId = version.id;
    d.inflight = false;
    emitDraft(draftId, {
        action,
        actionName: action.name,
        versions: d.versions,
        currentVersionId: version.id,
        inflight: false,
    });
}

export function setInflight(draftId: string, inflight: boolean): void {
    const d = drafts.get(draftId);
    if (!d) return;
    d.inflight = inflight;
    emitDraft(draftId, { inflight });
}

export function attachAction(draftId: string, action: Action): void {
    const d = drafts.get(draftId);
    if (!d) return;
    d.action = action;
    d.actionName = action.name;
    emitDraft(draftId, { action, actionName: action.name });
}

export async function setActiveAction(actionId: string): Promise<string | undefined> {
    const cached = drafts.get(actionId);
    if (cached) {
        if (activeId !== actionId) {
            activeId = actionId;
            emitActive();
        }
        return cached.id;
    }
    const [action, versions, results] = await Promise.all([
        idbGetAction(actionId),
        idbListVersions(actionId),
        idbListResults(actionId),
    ]);
    if (!action) return undefined;
    const head = action.currentVersionId
        ? versions.find((v) => v.id === action.currentVersionId)
        : versions[versions.length - 1];
    const headVersionId = head?.id ?? action.currentVersionId;
    const sortedResults = results.slice().sort((a, b) => b.finishedAt - a.finishedAt);
    // Pair the restored result with the SELECTED version, not the globally most
    // recent execution. Reloading while a non-latest version is current restores
    // that selection (currentVersionId), so a global latestResult would belong
    // to a different version and `pickResult` — which requires
    // `latestResult.versionId === viewing.id` — would render "No execution yet".
    // Legacy/no-version actions (no headVersionId) fall back to the most recent
    // result, shown in the draft slot.
    const latestResult = headVersionId
        ? sortedResults.find((r) => r.versionId === headVersionId)
        : sortedResults[0];
    const draft: ActionDraft = {
        id: actionId,
        actionName: action.name,
        intent: head?.intent ?? '',
        action,
        dataSources: head ? versionDataSourcesToPreviews(head) : [],
        code: head?.code ?? action.code ?? undefined,
        codeKind: head?.kind ?? action.kind,
        codeStatus: head ? 'approved' : undefined,
        latestResult,
        versions,
        currentVersionId: head?.id ?? action.currentVersionId,
        inflight: false,
    };
    // Restore an in-review candidate persisted by `persistChat`. Without this
    // a reload (or a tab that never ran the loop) would show only the result —
    // an uncommitted draft has no version/head, so name/code/dataSources are
    // all empty — and the thumbs-up/down card would have nothing to commit.
    const pr = action.pendingReview;
    if (pr) {
        const reviewResult =
            (pr.resultId ? results.find((r) => r.id === pr.resultId) : undefined) ?? latestResult;
        const reviewKind: ActionKind = pr.kind ?? 'code';
        draft.actionName = pr.actionName;
        draft.dataSources = dataSourcesToPreviews(pr.dataSources);
        draft.code = pr.code;
        draft.codeKind = reviewKind;
        draft.codeStatus = 'approved';
        draft.pendingReview = {
            code: pr.code,
            codeKind: reviewKind,
            dataSources: pr.dataSources,
            intent: pr.intent,
            baseVersionId: pr.baseVersionId,
            result: reviewResult,
        };
        draft.viewing = { kind: 'draft' };
    }
    drafts.set(actionId, draft);
    // Hydration from IDB: local-only so peer tabs aren't yanked into
    // this tab's just-loaded state.
    emitDraftLocal(actionId, draftAsPatch(draft));
    activeId = actionId;
    emitActive();
    return actionId;
}

export async function focusVersion(actionId: string, versionId: string): Promise<void> {
    const d = drafts.get(actionId);
    if (!d) return;
    let v = d.versions.find((x) => x.id === versionId);
    if (!v) v = await idbGetVersion(versionId);
    if (!v) return;
    d.currentVersionId = v.id;
    d.dataSources = versionDataSourcesToPreviews(v);
    d.code = v.code;
    d.codeKind = v.kind;
    d.codeStatus = 'approved';
    d.intent = v.intent;
    // Move the panel's display pointer to the focused version too. `viewing`
    // is what `resolveViewing` reads FIRST (the panel renders + highlights off
    // it); leaving it stale here is what made clicking a version pill change
    // currentVersionId but not the highlight/result — the panel's `viewing`
    // memo only tracks `draft.viewing` while it's set, so a currentVersionId-
    // only update never re-ran it. Keep the two in lockstep.
    d.viewing = { kind: 'version', id: v.id };
    emitDraft(actionId, {
        currentVersionId: v.id,
        dataSources: d.dataSources,
        code: d.code,
        codeKind: d.codeKind,
        codeStatus: 'approved',
        intent: d.intent,
        viewing: d.viewing,
    });
}

export function clearActiveAction(): void {
    if (activeId !== undefined) {
        activeId = undefined;
        emitActive();
    }
}

function draftAsPatch(d: ActionDraft): DraftPatch {
    return {
        actionName: d.actionName,
        intent: d.intent,
        action: d.action,
        dataSources: d.dataSources,
        code: d.code,
        codeKind: d.codeKind,
        codeStatus: d.codeStatus,
        latestResult: d.latestResult,
        versions: d.versions,
        currentVersionId: d.currentVersionId,
        inflight: d.inflight,
        pendingReview: d.pendingReview,
        viewing: d.viewing,
    };
}

function versionDataSourcesToPreviews(v: ActionVersion): DraftDataSourcePreview[] {
    return dataSourcesToPreviews(v.dataSources);
}

function dataSourcesToPreviews(sources: DataSource[]): DraftDataSourcePreview[] {
    // Samples are agent-runtime only. Even if a legacy row in IDB still carries
    // `sampleData`, we ignore it on read: samples persisted with the Action
    // were synthetic, and showing them on the panel after reload makes the user
    // think the action is running on fake data.
    return sources.map((d) => ({
        name: d.name,
        query: d.query,
        semanticDescription: d.semanticDescription,
        typeDeclaration: d.typeDeclaration,
        sampleColumns: [],
        sampleRows: [],
        truncated: false,
    }));
}
