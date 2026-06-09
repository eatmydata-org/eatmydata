import { For, Show, createSignal, createEffect, onCleanup, type Component } from 'solid-js';
import { loadEchartsCore, type EChartsInstance } from '@/lib/echarts/loader';
import { isEchartsOption, isEchartsOptionArray } from '@/lib/echarts/shape';
import { patchEchartsOption } from '@/lib/echarts/patch-option';
import { createSyncController, type SyncController } from '@/lib/echarts/sync-controller';

/**
 * Normalize a raw output value into a list of ECharts options. A bare option
 * object becomes a one-element array; an array of options passes through;
 * anything else yields an empty list (the caller renders a fallback).
 */
export function normalizeCharts(output: unknown): Array<Record<string, unknown>> {
    if (isEchartsOptionArray(output)) return [...output];
    if (isEchartsOption(output)) return [output];
    return [];
}

/**
 * Renders one-or-more ECharts options as a responsive grid of cards. Cards
 * that share categories / axis names are auto-linked (synced tooltip,
 * dataZoom, cross-highlight) via a single per-dashboard sync controller.
 *
 * Used both by the standalone `echarts` output format and by the block
 * renderer, which coalesces adjacent `chart` blocks into one dashboard so the
 * auto-linking still applies across them.
 */
export const EChartsDashboard: Component<{ output: unknown }> = (props) => {
    const charts = () => normalizeCharts(props.output);
    const controller = createSyncController();
    onCleanup(() => controller.dispose());

    return (
        <Show
            when={charts().length > 0}
            fallback={
                <div class="rounded-lg border bg-card px-2 py-1 text-xs text-destructive">
                    ECharts output is missing or not a recognized option object.
                </div>
            }
        >
            <div
                class={
                    charts().length > 1
                        ? 'grid grid-cols-1 lg:grid-cols-2 gap-3'
                        : 'grid grid-cols-1 gap-3'
                }
            >
                <For each={charts()}>
                    {(option, i) => (
                        <EChartsCard option={option} index={i()} controller={controller} />
                    )}
                </For>
            </div>
        </Show>
    );
};

const EChartsCard: Component<{
    option: Record<string, unknown>;
    index: number;
    controller: SyncController;
}> = (props) => {
    let container: HTMLDivElement | undefined;
    const [error, setError] = createSignal<string | null>(null);

    createEffect(() => {
        const el = container;
        const option = props.option;
        if (!el) return;

        let disposed = false;
        let chart: EChartsInstance | null = null;
        let resizeObserver: ResizeObserver | null = null;

        (async () => {
            const core = await loadEchartsCore({ renderer: 'canvas' });
            if (disposed) return;
            try {
                chart = core.init(el) as EChartsInstance;
                const patched = patchEchartsOption(option);
                chart.setOption(patched);
                setError(null);
                props.controller.register(props.index, chart, patched);
            } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
                return;
            }
            resizeObserver = new ResizeObserver(() => {
                try {
                    chart?.resize();
                } catch {
                    // chart may be mid-dispose
                }
            });
            resizeObserver.observe(el);
        })();

        onCleanup(() => {
            disposed = true;
            resizeObserver?.disconnect();
            props.controller.unregister(props.index);
            chart?.dispose();
        });
    });

    return (
        <div class="rounded-lg border bg-card p-2 min-h-[360px] flex flex-col">
            <Show when={error()}>
                <div class="px-2 py-1 text-xs text-destructive">{error()}</div>
            </Show>
            <div ref={container} class="flex-1" style="width: 100%; min-height: 340px;" />
        </div>
    );
};
