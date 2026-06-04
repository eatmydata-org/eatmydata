/**
 * Single source of truth for which ECharts modules we register. Two callers
 * exist — the renderer (canvas) and the host-side validator (svg + ssr) —
 * and they previously each maintained their own `core.use([...])` list.
 *
 * The returned core promise is memoized per renderer; calling
 * `loadEchartsCore` multiple times returns the same promise (and ECharts
 * tolerates repeated `core.use` registrations, but we avoid them).
 */

export type EChartsCore = {
    use: (mods: unknown[]) => void;
    init: (
        dom: HTMLElement | null,
        theme?: string | object | null,
        opts?: {
            renderer?: 'canvas' | 'svg';
            ssr?: boolean;
            width?: number;
            height?: number;
        },
    ) => EChartsInstance;
    connect?: (group: string | EChartsInstance[]) => void;
};

export type EChartsInstance = {
    setOption: (
        option: Record<string, unknown>,
        opts?: { notMerge?: boolean; replaceMerge?: string | string[] },
    ) => void;
    getOption: () => Record<string, unknown>;
    resize: () => void;
    dispose: () => void;
    on: (event: string, handler: (ev: unknown) => void) => void;
    off: (event: string, handler?: (ev: unknown) => void) => void;
    dispatchAction: (action: Record<string, unknown>) => void;
};

type RendererKind = 'canvas' | 'svg';

const cache = new Map<RendererKind, Promise<EChartsCore>>();

export function loadEchartsCore(
    opts: { renderer: RendererKind } = { renderer: 'canvas' },
): Promise<EChartsCore> {
    const existing = cache.get(opts.renderer);
    if (existing) return existing;
    const p = (async () => {
        const [core, charts, components, renderers] = await Promise.all([
            import('echarts/core'),
            import('echarts/charts'),
            import('echarts/components'),
            import('echarts/renderers'),
        ]);
        core.use([
            charts.LineChart,
            charts.BarChart,
            charts.PieChart,
            charts.ScatterChart,
            charts.HeatmapChart,
            components.TitleComponent,
            components.TooltipComponent,
            components.GridComponent,
            components.LegendComponent,
            components.DatasetComponent,
            components.DataZoomComponent,
            components.MarkLineComponent,
            components.MarkPointComponent,
            components.VisualMapComponent,
            opts.renderer === 'svg'
                ? renderers.SVGRenderer
                : renderers.CanvasRenderer,
        ]);
        return core as unknown as EChartsCore;
    })();
    cache.set(opts.renderer, p);
    return p;
}
