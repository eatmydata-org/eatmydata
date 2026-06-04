import { describe, it, expect } from 'vitest';
import type { ActionVersion } from '@/lib/actions/types';
import { beginDraft, focusVersion, getDraft, setViewing } from './drafts';

/**
 * Regression for the version-pill highlight bug: clicking a version focuses it
 * (updates `currentVersionId`) but used to leave `draft.viewing` stale.
 * `resolveViewing` reads `viewing` first and short-circuits, so the panel's
 * `viewing` memo only tracks `draft.viewing` while it's set — a
 * currentVersionId-only update never re-ran it, and the highlight/result froze
 * on the previously-viewed version. `focusVersion` must keep the two in sync.
 */

function uid(prefix: string): string {
    return `${prefix}-${crypto.randomUUID()}`;
}

function makeVersion(actionId: string, id: string): ActionVersion {
    return {
        id,
        actionId,
        contentHash: `hash-${id}`,
        intent: `intent ${id}`,
        code: `__output = ${JSON.stringify(id)};`,
        kind: 'code',
        dataSources: [],
        createdAt: Date.now(),
    };
}

describe('drafts.focusVersion keeps viewing in lockstep with currentVersionId', () => {
    it('moves viewing to the focused version even when a stale viewing points elsewhere', async () => {
        const actionId = uid('action');
        const v1 = makeVersion(actionId, uid('v1'));
        const v2 = makeVersion(actionId, uid('v2'));
        beginDraft({
            id: actionId,
            actionName: 'A',
            intent: 'i',
            versions: [v1, v2],
            baseVersion: v2,
        });
        // Simulate the post-commit state where `viewing` is pinned to v2 (what
        // clearPendingReview leaves behind) — the exact condition that froze the
        // highlight before the fix.
        setViewing(actionId, { kind: 'version', id: v2.id });
        expect(getDraft(actionId)?.viewing).toEqual({ kind: 'version', id: v2.id });

        await focusVersion(actionId, v1.id);

        const d = getDraft(actionId);
        expect(d?.currentVersionId).toBe(v1.id);
        // viewing must follow the click, not stay on v2.
        expect(d?.viewing).toEqual({ kind: 'version', id: v1.id });
        expect(d?.code).toBe(v1.code);
    });
});
