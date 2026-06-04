import type { Action, ActionKind, ActionVersion, DataSource } from './types';
import type { ActionExecution } from './executor';
import { hashActionParams } from './executor';
import {
    getActionVersionByHash,
    listVersionsForAction,
    putAction,
    putActionVersion,
} from './store';
import { putResult } from '@/lib/runtime/state/results';

/**
 * Commit an in-review candidate into a durable `ActionVersion` + head Action.
 *
 * Extracted from the orchestrator's thumbs-up block so BOTH paths share one
 * implementation and can't diverge:
 *   - the live loop (orchestrator `iterateOnAction`), and
 *   - an orphaned commit after reload (host `commitReview`), where the loop is
 *     gone and the candidate is reconstructed from the persisted
 *     `Action.pendingReview`.
 *
 * Side effects: materializes (or reuses, deduped by contentHash) the version,
 * `putAction`s the head with `currentVersionId` set and `pendingReview`
 * cleared, backfills `result.versionId` and re-persists the result. The caller
 * owns the in-memory draft updates (`finalizeVersion` / `clearPendingReview`)
 * and any chat-side artifacts (the "vN saved" chip).
 */
export async function commitReviewCandidate(args: {
    /** Base action whose committed fields + chatLog are preserved. */
    action: Action;
    actionName: string;
    intent: string;
    code: string;
    kind?: ActionKind;
    dataSources: DataSource[];
    baseVersionId?: string;
    /** Candidate execution; its `versionId` is backfilled and it is re-put. */
    result: ActionExecution;
}): Promise<{ version: ActionVersion; finalAction: Action; versionIndex: number }> {
    const version = await materializeVersion({
        actionId: args.action.id,
        intent: args.intent,
        code: args.code,
        kind: args.kind,
        dataSources: args.dataSources,
        parentVersionId: args.baseVersionId,
    });
    const finalAction: Action = {
        ...args.action,
        name: args.actionName,
        dataSources: args.dataSources,
        code: args.code,
        kind: args.kind,
        currentVersionId: version.id,
        pendingReview: undefined,
        updatedAt: Date.now(),
    };
    // structuredClone mirrors the executeAction / materializeVersion boundary:
    // the persisted Action is independent of in-memory draft state, and the
    // clone surfaces serializability problems here instead of inside IDB.
    await putAction(structuredClone(finalAction));
    args.result.versionId = version.id;
    await putResult(args.result);
    const versionIndex = await computeVersionIndex(args.action.id, version.id);
    return { version, finalAction, versionIndex };
}

/**
 * Hash + persist a version, or return the existing one if the hash already
 * exists for this action. The committed `dataSources` array is
 * structuredClone'd before storing so the persisted version cannot be mutated
 * by later draft updates and is provably structured-cloneable.
 */
export async function materializeVersion(args: {
    actionId: string;
    intent: string;
    code: string;
    kind?: ActionKind;
    dataSources: DataSource[];
    parentVersionId?: string;
}): Promise<ActionVersion> {
    const dataSources = structuredClone(args.dataSources);
    const contentHash = await hashActionParams({
        code: args.code,
        dataSources,
    });
    const existing = await getActionVersionByHash(args.actionId, contentHash);
    if (existing) return existing;
    const version: ActionVersion = {
        id: crypto.randomUUID(),
        actionId: args.actionId,
        contentHash,
        intent: args.intent,
        code: args.code,
        kind: args.kind,
        dataSources,
        parentVersionId: args.parentVersionId,
        createdAt: Date.now(),
    };
    await putActionVersion(version);
    return version;
}

/** 1-based index of `versionId` in the action's version list (for the
 * "vN saved" chip). Falls back to 1 on read error. */
export async function computeVersionIndex(actionId: string, versionId: string): Promise<number> {
    try {
        const all = await listVersionsForAction(actionId);
        const idx = all.findIndex((v) => v.id === versionId);
        return idx >= 0 ? idx + 1 : all.length;
    } catch {
        return 1;
    }
}
