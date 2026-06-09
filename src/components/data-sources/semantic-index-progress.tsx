/**
 * Compact banner showing live background semantic-indexing progress on the Data
 * Sources page. Reads the ephemeral store in
 * [semantic-index-status.ts](../../lib/data-sources/semantic-index-status.ts);
 * renders nothing when idle.
 *
 * A row flips to "ready to search" only once its index is atomically committed
 * (the planner sees it as searchable at the same instant), so this never shows
 * a half-usable column.
 */
import { For, Show, type Component } from 'solid-js';
import {
    semanticIndexJobs,
    dismissIndexJob,
    type IndexJob,
} from '@/lib/data-sources/semantic-index-status';

function percent(j: IndexJob): number {
    if (j.state === 'done') return 100;
    if (j.total <= 0) return 0;
    return Math.min(100, Math.round((j.done / j.total) * 100));
}

export const SemanticIndexProgress: Component = () => {
    return (
        <Show when={semanticIndexJobs().length > 0}>
            <div class="border-b bg-muted/40 px-3 py-2 flex flex-col gap-1.5">
                <For each={semanticIndexJobs()}>
                    {(job) => (
                        <div class="flex items-center gap-2 text-xs">
                            <span class="font-medium text-foreground/80 shrink-0">
                                Semantic index · {job.table}.{job.column}
                            </span>
                            <Show when={job.state === 'running'}>
                                <div class="h-1.5 w-40 rounded bg-border overflow-hidden shrink-0">
                                    <div
                                        class="h-full bg-primary transition-[width] duration-300"
                                        style={{ width: `${percent(job)}%` }}
                                    />
                                </div>
                                <span class="tabular-nums text-muted-foreground shrink-0">
                                    {job.total > 0
                                        ? `${job.done.toLocaleString()} / ${job.total.toLocaleString()}`
                                        : 'starting…'}
                                </span>
                            </Show>
                            <Show when={job.state === 'done'}>
                                <span class="text-muted-foreground">✓ ready to search</span>
                            </Show>
                            <Show when={job.state === 'error'}>
                                <span class="text-destructive truncate" title={job.error}>
                                    failed: {job.error}
                                </span>
                                <button
                                    type="button"
                                    class="ml-auto text-muted-foreground hover:text-foreground shrink-0"
                                    onClick={() =>
                                        dismissIndexJob(job.sourceId, job.table, job.column)
                                    }
                                >
                                    dismiss
                                </button>
                            </Show>
                        </div>
                    )}
                </For>
            </div>
        </Show>
    );
};
