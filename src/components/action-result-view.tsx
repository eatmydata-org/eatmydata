import { For, Show, createSignal, createEffect, onCleanup, type Component } from 'solid-js';
import type { ActionExecution } from '@/lib/actions/executor';
import type { ActionOutputFormat } from '@/lib/actions/types';
import { StreamedMarkdown } from './streamed-markdown';
import { sanitizeHtml } from '@/lib/sanitize-html';
import { loadEchartsCore, type EChartsInstance } from '@/lib/echarts/loader';
import { isEchartsOption, isEchartsOptionArray } from '@/lib/echarts/shape';
import { patchEchartsOption } from '@/lib/echarts/patch-option';
import { createSyncController, type SyncController } from '@/lib/echarts/sync-controller';

type Props = {
    result: ActionExecution;
};

/**
 * Shared renderer for an action execution result — the result *body*
 * (error, data sources, output, stdout). Callers supply their own chrome:
 * the in-chat side panel wraps it with a re-run / open-in-new-window
 * toolbar; the standalone `/result/:id` route prefixes a name + timestamp.
 */
export const ActionResultView: Component<Props> = (props) => {
    const r = () => props.result;

    return (
        <div class="flex flex-col gap-4 text-sm">
            <Show when={r().error}>
                <section class="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2">
                    <div class="text-destructive text-xs uppercase tracking-wider font-semibold mb-1">
                        error
                    </div>
                    <pre class="text-xs font-mono whitespace-pre-wrap break-words">{r().error}</pre>
                </section>
            </Show>

            <Show when={r().output !== undefined && !r().error}>
                <OutputRenderer output={r().output} format={r().outputFormat} />
            </Show>
        </div>
    );
};

const OutputRenderer: Component<{
    output: unknown;
    format: ActionOutputFormat;
}> = (props) => {
    return (
        <div>
            <Show when={props.format === 'markdown'}>
                <div class="rounded-lg border bg-card px-4 py-3 text-sm">
                    <StreamedMarkdown content={String(props.output ?? '')} streaming={false} />
                </div>
            </Show>
            <Show when={props.format === 'html'}>
                <div
                    class="rounded-lg border bg-card px-4 py-3 prose prose-sm max-w-none"
                    // Action output is LLM-authored sandbox HTML (untrusted);
                    // sanitizeHtml() strips scripts/handlers/javascript: URLs.
                    // eslint-disable-next-line solid/no-innerhtml -- sanitized above
                    innerHTML={sanitizeHtml(String(props.output ?? ''))}
                />
            </Show>
            <Show when={props.format === 'json'}>
                <pre class="rounded-lg border bg-card px-3 py-2 text-xs font-mono whitespace-pre-wrap break-words overflow-auto">
                    {formatJson(props.output)}
                </pre>
            </Show>
            <Show when={props.format === 'echarts'}>
                <EChartsDashboard output={props.output} />
            </Show>
        </div>
    );
};

/**
 * Normalize the raw `__output` value into a list of ECharts options. A
 * bare option object becomes a one-element array; an array of options
 * passes through; anything else yields an empty list (an error message
 * is rendered upstream).
 */
function normalizeCharts(output: unknown): Array<Record<string, unknown>> {
    if (isEchartsOptionArray(output)) return [...output];
    if (isEchartsOption(output)) return [output];
    return [];
}

const EChartsDashboard: Component<{ output: unknown }> = (props) => {
    const charts = () => normalizeCharts(props.output);
    /**
     * One sync controller per dashboard instance. Each card registers
     * itself once its ECharts instance is ready; controller wires
     * cross-card behavior after every register via a microtask rebuild.
     */
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

function formatJson(x: unknown): string {
    try {
        return JSON.stringify(x, null, 2);
    } catch {
        return String(x);
    }
}
