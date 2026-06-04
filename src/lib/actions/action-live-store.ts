/**
 * Tab-side action-draft facade. The authoritative state lives in this
 * tab's runtime host (`@/lib/runtime/host` + `@/lib/runtime/state/*`).
 * This module exposes a Solid-reactive view backed by the runtime
 * mirror, plus thin command wrappers.
 */

import { useActiveDraft, useDraft, useActiveActionId, runtime } from '@/lib/runtime/client';
import type { ActionDraft, CodeStatus } from '@/lib/runtime/api';

export type { ActionDraft, CodeStatus };

/** Reactive read of the currently-focused draft (or undefined). */
export function activeAction(): ActionDraft | undefined {
    return useActiveDraft();
}

/** Reactive read of just the id, for components that don't need the
 * whole draft. */
export function activeActionId(): string | undefined {
    return useActiveActionId();
}

/** Reactive read of any draft by id. */
export function getDraft(id: string): ActionDraft | undefined {
    return useDraft(id);
}

/** Focus an action — loads from IDB in the worker, broadcasts an
 * active-action event the mirror picks up. */
export function setActiveAction(actionId: string): Promise<void> {
    return runtime.setActiveAction(actionId);
}

export function clearActiveAction(): Promise<void> {
    return runtime.clearActiveAction();
}

export function focusVersion(actionId: string, versionId: string): Promise<void> {
    return runtime.focusVersion(actionId, versionId);
}
