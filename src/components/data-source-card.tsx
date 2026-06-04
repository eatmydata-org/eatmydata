import { For, Show, type Component, type JSX } from 'solid-js';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/registry/ui/collapsible';
import type { SavedDataSourcePreview } from '@/lib/types';

type Props = {
    ds: SavedDataSourcePreview;
    /** Initial open state of the collapsible body. */
    defaultOpen?: boolean;
    /** Slot rendered to the right of the pill row — reserved for future
     * actions like an "open in SQL designer" link. */
    trailing?: JSX.Element;
};

/**
 * Reusable card for a single data source. Shows a monospace name pill and
 * its (rows × cols) "shape", with an expandable body containing the SQL
 * and a synthetic sample table. Drives the same visual identity in the
 * Action panel and in approval confirmations.
 */
export const DataSourceCard: Component<Props> = (props) => {
    const rowCount = () => props.ds.sampleRows.length;
    const colCount = () => props.ds.sampleColumns.length;
    return (
        <div class="rounded border bg-background">
            <Collapsible defaultOpen={props.defaultOpen}>
                <div class="flex items-baseline gap-2 px-2 py-1.5">
                    <CollapsibleTrigger class="flex-1 min-w-0 flex items-baseline gap-2 text-left hover:opacity-80 transition-opacity">
                        <code class="shrink-0 px-1.5 py-0.5 rounded bg-muted text-xs font-mono">
                            {props.ds.name}
                        </code>
                        <span class="shrink-0 text-xs text-muted-foreground font-mono">
                            {rowCount()} × {colCount()}
                        </span>
                        <Show when={props.ds.truncated}>
                            <span class="shrink-0 text-[10px] text-muted-foreground">
                                truncated
                            </span>
                        </Show>
                        <span class="text-xs text-muted-foreground truncate">
                            {props.ds.semanticDescription}
                        </span>
                    </CollapsibleTrigger>
                    <Show when={props.trailing}>{props.trailing}</Show>
                </div>
                <CollapsibleContent>
                    <div class="px-2 pb-2 flex flex-col gap-2">
                        <div>
                            <div class="text-muted-foreground text-[10px] uppercase tracking-wider mb-0.5">
                                SQL
                            </div>
                            <pre class="px-2 py-1 rounded bg-muted text-[11px] font-mono whitespace-pre-wrap break-words">
                                {props.ds.query}
                            </pre>
                        </div>
                        <Show when={rowCount() > 0}>
                            <div>
                                <div class="text-muted-foreground text-[10px] uppercase tracking-wider mb-0.5">
                                    sample (synthetic)
                                </div>
                                <SampleTable
                                    columns={props.ds.sampleColumns}
                                    rows={props.ds.sampleRows}
                                />
                            </div>
                        </Show>
                    </div>
                </CollapsibleContent>
            </Collapsible>
        </div>
    );
};

const SampleTable: Component<{
    columns: string[];
    rows: Array<Record<string, unknown>>;
}> = (props) => (
    <div class="overflow-x-auto rounded border">
        <table class="w-full text-[11px] font-mono border-collapse">
            <thead class="bg-muted">
                <tr>
                    <For each={props.columns}>
                        {(c) => <th class="text-left px-2 py-1 border-b font-semibold">{c}</th>}
                    </For>
                </tr>
            </thead>
            <tbody>
                <For each={props.rows}>
                    {(row) => (
                        <tr class="border-b last:border-b-0">
                            <For each={props.columns}>
                                {(col) => (
                                    <td class="px-2 py-1 align-top">{formatCell(row[col])}</td>
                                )}
                            </For>
                        </tr>
                    )}
                </For>
            </tbody>
        </table>
    </div>
);

function formatCell(v: unknown): string {
    if (v === null || v === undefined) return '∅';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return JSON.stringify(v);
}
