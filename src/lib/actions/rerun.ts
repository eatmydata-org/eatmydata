import { getAction } from './store';
import { executeAction, type ActionExecution } from './executor';
import { putResult } from '@/lib/runtime/state/results';

/**
 * Re-run a previously saved Action against current data. Returns the new
 * execution on success, or null if the source Action has been deleted (the
 * Result references it by id only — if the row is gone we can't rebuild it).
 *
 * The new ActionExecution is `putResult()`-ed so it lands in IDB and becomes
 * the active result in the side panel; navigation/follow-up is the caller's
 * responsibility.
 */
export async function rerunAction(actionId: string): Promise<ActionExecution | null> {
    const action = await getAction(actionId);
    if (!action) return null;
    const exec = await executeAction(action);
    // Tag the execution with the version it ran (the action's head). The panel
    // shows a version's result only when `latestResult.versionId === viewing.id`
    // (see action-panel `pickResult`); without this a re-run — including
    // clicking a version pill, which focuses that version then re-runs — yields
    // an untagged result the version view can't match, so it renders "No
    // execution yet." Legacy actions with no version leave it undefined.
    exec.versionId = action.currentVersionId;
    putResult(exec);
    return exec;
}
