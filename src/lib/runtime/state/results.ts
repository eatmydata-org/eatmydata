import type { ActionExecution } from '@/lib/actions/executor';
import {
    getResultRow as idbGet,
    putResultRow as idbPut,
    listResultsForAction as idbListForAction,
} from '@/lib/actions/store';
import { publish } from './broadcast';

/**
 * Tab-side in-memory cache of execution results, backed by IDB. Peer
 * tabs see updates via `result-patch` broadcasts (see ./broadcast).
 */

const cache = new Map<string, ActionExecution>();

/**
 * Cache + broadcast immediately so peer tabs and the UI see the result
 * without waiting on IDB, but return the IDB write promise so callers that
 * MUST persist before yielding (e.g. the orchestrator commit path before
 * the user might reload) can await it. Errors are still swallowed with a
 * console.warn — IDB failures shouldn't crash the agent loop.
 */
export function putResult(result: ActionExecution): Promise<void> {
    cache.set(result.id, result);
    publish({ kind: 'result-patch', resultId: result.id, result });
    return idbPut(result).catch((e) => {
        console.warn('[runtime/results] idb put failed', e);
    });
}

export async function getResult(id: string): Promise<ActionExecution | undefined> {
    const cached = cache.get(id);
    if (cached) return cached;
    try {
        const row = await idbGet(id);
        if (row) cache.set(id, row);
        return row;
    } catch (e) {
        console.warn('[runtime/results] idb get failed', e);
        return undefined;
    }
}

export async function listResultsForAction(actionId: string): Promise<ActionExecution[]> {
    try {
        const rows = await idbListForAction(actionId);
        for (const r of rows) cache.set(r.id, r);
        return rows;
    } catch (e) {
        console.warn('[runtime/results] idb list failed', e);
        return [];
    }
}

export function snapshotResults(): Record<string, ActionExecution> {
    const out: Record<string, ActionExecution> = {};
    for (const [k, v] of cache) out[k] = v;
    return out;
}
