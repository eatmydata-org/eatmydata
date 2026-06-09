import { For, Show, Switch, Match, createMemo, type Component } from 'solid-js';
import type { ResultBlock } from '@/lib/actions/types';
import { StreamedMarkdown } from './streamed-markdown';
import { ResultTableGrid } from './result-table-grid';
import { EChartsDashboard } from './echarts-dashboard';

type TableBlock = Extract<ResultBlock, { kind: 'table' }>;

/** A render group: consecutive `chart` blocks are coalesced into one dashboard
 *  so the auto-link sync controller spans them; markdown/table stay 1:1. */
type Group =
    | { kind: 'markdown'; text: string }
    | { kind: 'chart'; options: Array<Record<string, unknown>> }
    | { kind: 'table'; block: TableBlock };

function groupBlocks(blocks: ResultBlock[]): Group[] {
    const groups: Group[] = [];
    for (const b of blocks) {
        if (b.kind === 'chart') {
            const last = groups[groups.length - 1];
            if (last && last.kind === 'chart') last.options.push(b.option);
            else groups.push({ kind: 'chart', options: [b.option] });
        } else if (b.kind === 'markdown') {
            groups.push({ kind: 'markdown', text: b.text });
        } else {
            groups.push({ kind: 'table', block: b });
        }
    }
    return groups;
}

/**
 * Renders a composed block answer top to bottom: markdown prose, ECharts
 * dashboards, and tables. EVERY table renders in the interactive AG-Grid
 * (`ResultTableGrid`) regardless of row count — small tables auto-size to
 * their content, large ones get a bounded, virtualized, scrollable box. With
 * several large tables in one report, each grid gets a shorter bounded height
 * so the page scrolls sanely.
 */
export const ResultBlocks: Component<{ blocks: ResultBlock[] }> = (props) => {
    const groups = createMemo(() => groupBlocks(props.blocks));
    const tableHeight = createMemo(() =>
        props.blocks.filter((b) => b.kind === 'table').length > 1
            ? 'min(50vh, 480px)'
            : 'min(70vh, 640px)',
    );

    return (
        <div class="flex flex-col gap-3">
            <For each={groups()}>
                {(g) => (
                    <Switch>
                        <Match when={g.kind === 'markdown' && g}>
                            {(mg) => (
                                <div class="text-sm">
                                    <StreamedMarkdown content={mg().text} streaming={false} />
                                </div>
                            )}
                        </Match>
                        <Match when={g.kind === 'chart' && g}>
                            {(cg) => <EChartsDashboard output={cg().options} />}
                        </Match>
                        <Match when={g.kind === 'table' && g}>
                            {(tg) => <TableSection block={tg().block} maxHeight={tableHeight()} />}
                        </Match>
                    </Switch>
                )}
            </For>
        </div>
    );
};

const TableSection: Component<{ block: TableBlock; maxHeight: string }> = (props) => (
    <div class="flex flex-col gap-1">
        <Show when={props.block.title}>
            <h3 class="text-sm font-semibold">{props.block.title}</h3>
        </Show>
        <Show when={props.block.caption}>
            <div class="text-xs text-muted-foreground">
                <StreamedMarkdown content={props.block.caption ?? ''} streaming={false} />
            </div>
        </Show>
        <ResultTableGrid
            columns={props.block.columns}
            rows={props.block.rows}
            maxHeight={props.maxHeight}
        />
    </div>
);
