/**
 * Live, ephemeral status of background semantic indexing (semantic-index.ts).
 *
 * A module-level Solid store the indexer writes to and the Data Sources page
 * reads — purely transient progress (resets on reload; nothing persisted), so a
 * global signal is the right shape, not IDB/chat-model state. One entry per
 * (source, table, column) being embedded; the UI renders a small progress
 * banner from it.
 *
 * Note: a column is reported `done` here only AFTER its index is atomically
 * committed (the map row written) — so "done" in this UI lines up exactly with
 * the planner seeing the column as searchable. There is no "partially ready"
 * state by construction.
 */
import { createStore, produce } from 'solid-js/store';

export type IndexJobState = 'running' | 'done' | 'error';

export interface IndexJob {
    sourceId: string;
    sourceName: string;
    table: string;
    column: string;
    done: number;
    total: number;
    state: IndexJobState;
    error?: string;
    /** Monotonic order key (no Date.now needed). */
    seq: number;
}

const [state, setState] = createStore<{ jobs: IndexJob[] }>({ jobs: [] });
let seq = 0;

/** Reactive accessor: all current jobs (running + recently finished). */
export const semanticIndexJobs = (): readonly IndexJob[] => state.jobs;
/** Reactive accessor: only the running ones. */
export const activeSemanticIndexJobs = (): readonly IndexJob[] =>
    state.jobs.filter((j) => j.state === 'running');

function idx(sourceId: string, table: string, column: string): number {
    return state.jobs.findIndex(
        (j) => j.sourceId === sourceId && j.table === table && j.column === column,
    );
}

export function reportIndexStart(
    sourceId: string,
    sourceName: string,
    table: string,
    column: string,
): void {
    const job: IndexJob = {
        sourceId,
        sourceName,
        table,
        column,
        done: 0,
        total: 0,
        state: 'running',
        seq: seq++,
    };
    setState(
        produce((s) => {
            const i = idx(sourceId, table, column);
            if (i >= 0) s.jobs[i] = job;
            else s.jobs.push(job);
        }),
    );
}

export function reportIndexProgress(
    sourceId: string,
    table: string,
    column: string,
    done: number,
    total: number,
): void {
    const i = idx(sourceId, table, column);
    if (i < 0) return;
    // Leaf-path sets keep the row object's reference stable, so <For> doesn't
    // recreate the row on every progress tick — only the changed cell updates.
    setState('jobs', i, 'done', done);
    setState('jobs', i, 'total', total);
}

export function reportIndexDone(sourceId: string, table: string, column: string): void {
    const i = idx(sourceId, table, column);
    if (i < 0) return;
    setState('jobs', i, 'done', state.jobs[i]!.total);
    setState('jobs', i, 'state', 'done');
    // Auto-clear finished entries so the banner doesn't accumulate. Errors stay
    // until dismissed or the next (re)build replaces them.
    scheduleClear(sourceId, table, column);
}

export function reportIndexError(
    sourceId: string,
    table: string,
    column: string,
    error: string,
): void {
    const i = idx(sourceId, table, column);
    if (i < 0) return;
    setState('jobs', i, 'error', error);
    setState('jobs', i, 'state', 'error');
}

/** Remove a job from the banner (dismiss). */
export function dismissIndexJob(sourceId: string, table: string, column: string): void {
    setState(
        'jobs',
        state.jobs.filter(
            (j) => !(j.sourceId === sourceId && j.table === table && j.column === column),
        ),
    );
}

const CLEAR_DELAY_MS = 6000;
function scheduleClear(sourceId: string, table: string, column: string): void {
    // `setTimeout` is browser-only; guard so importing this module under
    // Node/vitest (e.g. the candidate-selection unit test) is inert.
    if (typeof setTimeout !== 'function') return;
    setTimeout(() => {
        const i = idx(sourceId, table, column);
        if (i >= 0 && state.jobs[i]!.state === 'done') dismissIndexJob(sourceId, table, column);
    }, CLEAR_DELAY_MS);
}
