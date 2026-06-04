/**
 * Cross-card sync controller for the multi-chart dashboard renderer.
 *
 * The dashboard mounts one ECharts instance per option object. This
 * controller inspects every option, derives sync groups by structural
 * similarity, and wires manual cross-`dispatchAction` handlers — no
 * declarative metadata from the agent is required.
 *
 * Group kinds:
 *   xCategory   — axes with the same category `data` array.
 *                 → linked tooltip (axis pointer + showTip)
 *                 → linked dataZoom (panning one pans the others)
 *   numericAxis — value/time/log axes with a shared `name`+`type`+side.
 *                 → linked dataZoom on that axis
 *   seriesName  — series carrying the same `name` across cards.
 *                 → cross-highlight on hover
 *                 → legend toggle propagates by name
 *
 * `echarts.connect()` is intentionally not used: it links tooltip+legend+
 * dataZoom together at group granularity, and our spec demands per-axis
 * and per-series-name granularity (e.g. propagate legend by name, only
 * link dataZoom on axes whose domain actually matches).
 */

import { arraysEqual, asAxisArray } from './shape';
import type { EChartsInstance } from './loader';

type Entry = {
    index: number;
    chart: EChartsInstance;
    option: Record<string, unknown>;
};

type AxisRef = { cardIdx: number; axisIdx: number };

type XCategoryGroup = {
    categories: ReadonlyArray<unknown>;
    members: AxisRef[];
};

type NumericGroup = {
    side: 'x' | 'y';
    name: string;
    members: AxisRef[];
};

type Subscription = {
    chart: EChartsInstance;
    event: string;
    handler: (ev: unknown) => void;
};

type Detected = {
    xCategory: XCategoryGroup[];
    numeric: NumericGroup[];
    seriesByName: Map<string, Set<number>>;
};

export type SyncController = {
    register(
        index: number,
        chart: EChartsInstance,
        option: Record<string, unknown>,
    ): void;
    unregister(index: number): void;
    dispose(): void;
};

export function createSyncController(): SyncController {
    const entries = new Map<number, Entry>();
    let subscriptions: Subscription[] = [];
    /**
     * Re-entrancy guard. When we re-dispatch an action on a sibling chart
     * it can synchronously fire the very event we are handling — without
     * this flag the handlers would ping-pong forever. The microtask
     * release is critical: ECharts re-emits within the same tick.
     */
    let suppressing = false;
    /**
     * Tracks which (cardIdx, axisKey) we've already injected an inside-
     * dataZoom for — repeated `register()` calls during a Solid effect
     * re-run would otherwise stack duplicates onto the chart.
     */
    const injected = new Set<string>();
    let rebuildScheduled = false;
    let disposed = false;

    function scheduleRebuild() {
        if (rebuildScheduled || disposed) return;
        rebuildScheduled = true;
        queueMicrotask(() => {
            rebuildScheduled = false;
            if (disposed) return;
            rebuild();
        });
    }

    function teardown() {
        for (const sub of subscriptions) {
            try {
                sub.chart.off(sub.event, sub.handler);
            } catch {
                // chart may already be disposed by the time we unwire
            }
        }
        subscriptions = [];
    }

    function on(chart: EChartsInstance, event: string, handler: (ev: unknown) => void) {
        chart.on(event, handler);
        subscriptions.push({ chart, event, handler });
    }

    function withGuard(fn: () => void) {
        if (suppressing) return;
        suppressing = true;
        try {
            fn();
        } finally {
            queueMicrotask(() => {
                suppressing = false;
            });
        }
    }

    function rebuild() {
        teardown();
        const list = [...entries.values()].sort((a, b) => a.index - b.index);
        if (list.length < 2) {
            // Single card — series-name and axis sync are no-ops; nothing
            // to wire. (Single-card legend/tooltip already works locally.)
            return;
        }

        const detected = detect(list);

        // 1) Inject hidden inside-dataZoom on participating axes so panning
        //    actually works on charts the agent didn't declare zoom for.
        for (const g of detected.xCategory) {
            if (g.members.length < 2) continue;
            for (const m of g.members) {
                injectInsideZoom(list, m, 'x');
            }
        }
        for (const g of detected.numeric) {
            if (g.members.length < 2) continue;
            for (const m of g.members) {
                injectInsideZoom(list, m, g.side);
            }
        }

        // 2) Wire linked tooltip + linked dataZoom for xCategory groups.
        for (const g of detected.xCategory) {
            if (g.members.length < 2) continue;
            wireXCategoryGroup(list, g);
        }

        // 3) Wire linked dataZoom for named numeric-axis groups.
        for (const g of detected.numeric) {
            if (g.members.length < 2) continue;
            wireNumericGroup(list, g);
        }

        // 4) Wire cross-highlight + legend propagation by series name.
        wireSeriesNameSync(list, detected.seriesByName);
    }

    function injectInsideZoom(
        list: Entry[],
        ref: AxisRef,
        side: 'x' | 'y',
    ) {
        const key = `${ref.cardIdx}:${side}:${ref.axisIdx}`;
        if (injected.has(key)) return;
        const entry = list.find((e) => e.index === ref.cardIdx);
        if (!entry) return;
        const opt = entry.chart.getOption();
        const existing = Array.isArray(opt.dataZoom)
            ? (opt.dataZoom as Array<Record<string, unknown>>)
            : opt.dataZoom
            ? [opt.dataZoom as Record<string, unknown>]
            : [];
        // Skip injection when the agent already declared a zoom on this axis.
        const axisField = side === 'x' ? 'xAxisIndex' : 'yAxisIndex';
        const already = existing.some((dz) => {
            const v = dz[axisField];
            if (v === undefined) return false;
            if (Array.isArray(v)) return (v as number[]).includes(ref.axisIdx);
            return v === ref.axisIdx;
        });
        if (already) {
            injected.add(key);
            return;
        }
        const next = [
            ...existing,
            { type: 'inside', [axisField]: ref.axisIdx, filterMode: 'none' },
        ];
        try {
            entry.chart.setOption({ dataZoom: next });
            injected.add(key);
        } catch {
            // ignore — agent's option might have malformed dataZoom; we
            // don't want sync injection to crash the renderer.
        }
    }

    function wireXCategoryGroup(list: Entry[], group: XCategoryGroup) {
        for (const m of group.members) {
            const me = list.find((e) => e.index === m.cardIdx);
            if (!me) continue;
            const siblings = group.members.filter(
                (o) => o.cardIdx !== m.cardIdx,
            );

            on(me.chart, 'updateAxisPointer', (ev) => {
                const e = ev as {
                    axesInfo?: Array<{
                        axisDim?: string;
                        axisIndex?: number;
                        value?: number | string;
                    }>;
                };
                const info = (e.axesInfo ?? []).find(
                    (a) =>
                        a.axisDim === 'x' && a.axisIndex === m.axisIdx,
                );
                if (!info || info.value === undefined || info.value === null) {
                    return;
                }
                const dataIndex = Number(info.value);
                if (!Number.isFinite(dataIndex) || dataIndex < 0) return;
                withGuard(() => {
                    for (const sib of siblings) {
                        const target = list.find(
                            (e2) => e2.index === sib.cardIdx,
                        );
                        if (!target) continue;
                        try {
                            target.chart.dispatchAction({
                                type: 'showTip',
                                xAxisIndex: sib.axisIdx,
                                dataIndex,
                            });
                        } catch {
                            // ignore — chart may not have a series at idx
                        }
                    }
                });
            });

            on(me.chart, 'globalout', () => {
                withGuard(() => {
                    for (const sib of siblings) {
                        const target = list.find(
                            (e2) => e2.index === sib.cardIdx,
                        );
                        if (!target) continue;
                        try {
                            target.chart.dispatchAction({ type: 'hideTip' });
                        } catch {
                            /* ignore */
                        }
                    }
                });
            });

            on(me.chart, 'dataZoom', (ev) => {
                const range = extractZoomRange(ev);
                if (!range) return;
                withGuard(() => {
                    for (const sib of siblings) {
                        const target = list.find(
                            (e2) => e2.index === sib.cardIdx,
                        );
                        if (!target) continue;
                        try {
                            target.chart.dispatchAction({
                                type: 'dataZoom',
                                xAxisIndex: sib.axisIdx,
                                start: range.start,
                                end: range.end,
                            });
                        } catch {
                            /* ignore */
                        }
                    }
                });
            });
        }
    }

    function wireNumericGroup(list: Entry[], group: NumericGroup) {
        const axisField = group.side === 'x' ? 'xAxisIndex' : 'yAxisIndex';
        for (const m of group.members) {
            const me = list.find((e) => e.index === m.cardIdx);
            if (!me) continue;
            const siblings = group.members.filter(
                (o) => o.cardIdx !== m.cardIdx,
            );

            on(me.chart, 'dataZoom', (ev) => {
                const range = extractZoomRange(ev);
                if (!range) return;
                withGuard(() => {
                    for (const sib of siblings) {
                        const target = list.find(
                            (e2) => e2.index === sib.cardIdx,
                        );
                        if (!target) continue;
                        try {
                            target.chart.dispatchAction({
                                type: 'dataZoom',
                                [axisField]: sib.axisIdx,
                                start: range.start,
                                end: range.end,
                            });
                        } catch {
                            /* ignore */
                        }
                    }
                });
            });
        }
    }

    function wireSeriesNameSync(
        list: Entry[],
        seriesByName: Map<string, Set<number>>,
    ) {
        for (const entry of list) {
            const siblings = list.filter((e) => e.index !== entry.index);
            if (siblings.length === 0) continue;

            const handleHighlight = (eventName: 'highlight' | 'downplay') => (ev: unknown) => {
                const seriesName = pickSeriesName(ev);
                if (!seriesName) return;
                const targets = seriesByName.get(seriesName);
                if (!targets || targets.size < 2) return;
                withGuard(() => {
                    for (const sib of siblings) {
                        if (!targets.has(sib.index)) continue;
                        try {
                            sib.chart.dispatchAction({
                                type: eventName,
                                seriesName,
                            });
                        } catch {
                            /* ignore */
                        }
                    }
                });
            };

            on(entry.chart, 'highlight', handleHighlight('highlight'));
            on(entry.chart, 'downplay', handleHighlight('downplay'));

            on(entry.chart, 'legendselectchanged', (ev) => {
                const e = ev as {
                    name?: string;
                    selected?: Record<string, boolean>;
                };
                const name = e.name;
                const selectedMap = e.selected ?? {};
                if (!name) return;
                const targets = seriesByName.get(name);
                if (!targets || targets.size < 2) return;
                const isSelected = selectedMap[name];
                withGuard(() => {
                    for (const sib of siblings) {
                        if (!targets.has(sib.index)) continue;
                        try {
                            sib.chart.dispatchAction({
                                type: isSelected ? 'legendSelect' : 'legendUnSelect',
                                name,
                            });
                        } catch {
                            /* ignore */
                        }
                    }
                });
            });
        }
    }

    return {
        register(index, chart, option) {
            if (disposed) return;
            entries.set(index, { index, chart, option });
            scheduleRebuild();
        },
        unregister(index) {
            if (disposed) return;
            if (!entries.delete(index)) return;
            // Clean injection-marker bookkeeping so a future card at the
            // same index doesn't get its inside-zoom skipped.
            for (const key of [...injected]) {
                if (key.startsWith(`${index}:`)) injected.delete(key);
            }
            scheduleRebuild();
        },
        dispose() {
            disposed = true;
            teardown();
            entries.clear();
            injected.clear();
        },
    };
}

/**
 * Pure detection — exported for unit tests. Given a list of registered
 * entries (in index order), compute the three sync structures the
 * controller wires from.
 */
export function detect(list: Entry[]): Detected {
    const xCategory: XCategoryGroup[] = [];
    const numericMap = new Map<string, NumericGroup>();
    const seriesByName = new Map<string, Set<number>>();

    for (const entry of list) {
        const opt = entry.option;
        const xAxes = asAxisArray(opt.xAxis);
        const yAxes = asAxisArray(opt.yAxis);

        xAxes.forEach((ax, axIdx) => {
            const type = typeof ax.type === 'string' ? ax.type : 'category';
            if (type === 'category' && Array.isArray(ax.data)) {
                const data = ax.data as ReadonlyArray<unknown>;
                const existing = xCategory.find((g) =>
                    arraysEqual(g.categories, data),
                );
                const member: AxisRef = {
                    cardIdx: entry.index,
                    axisIdx: axIdx,
                };
                if (existing) {
                    existing.members.push(member);
                } else {
                    xCategory.push({ categories: data, members: [member] });
                }
            } else if (
                (type === 'value' || type === 'time' || type === 'log') &&
                typeof ax.name === 'string' &&
                ax.name.length > 0
            ) {
                const key = `x:${type}:${ax.name}`;
                const g = numericMap.get(key) ?? {
                    side: 'x' as const,
                    name: ax.name,
                    members: [],
                };
                g.members.push({ cardIdx: entry.index, axisIdx: axIdx });
                numericMap.set(key, g);
            }
        });

        yAxes.forEach((ax, axIdx) => {
            const type = typeof ax.type === 'string' ? ax.type : 'value';
            if (
                (type === 'value' || type === 'time' || type === 'log') &&
                typeof ax.name === 'string' &&
                ax.name.length > 0
            ) {
                const key = `y:${type}:${ax.name}`;
                const g = numericMap.get(key) ?? {
                    side: 'y' as const,
                    name: ax.name,
                    members: [],
                };
                g.members.push({ cardIdx: entry.index, axisIdx: axIdx });
                numericMap.set(key, g);
            }
        });

        const series = Array.isArray(opt.series)
            ? (opt.series as Array<Record<string, unknown>>)
            : opt.series
            ? [opt.series as Record<string, unknown>]
            : [];
        for (const s of series) {
            const name = typeof s.name === 'string' ? s.name : undefined;
            if (!name) continue;
            const set = seriesByName.get(name) ?? new Set<number>();
            set.add(entry.index);
            seriesByName.set(name, set);
        }
    }

    return {
        xCategory,
        numeric: [...numericMap.values()],
        seriesByName,
    };
}

function extractZoomRange(
    ev: unknown,
): { start: number; end: number } | null {
    const e = ev as {
        start?: number;
        end?: number;
        batch?: Array<{ start?: number; end?: number }>;
    };
    if (typeof e.start === 'number' && typeof e.end === 'number') {
        return { start: e.start, end: e.end };
    }
    const first = e.batch?.[0];
    if (
        first &&
        typeof first.start === 'number' &&
        typeof first.end === 'number'
    ) {
        return { start: first.start, end: first.end };
    }
    return null;
}

function pickSeriesName(ev: unknown): string | undefined {
    const e = ev as {
        seriesName?: string;
        name?: string;
        batch?: Array<{ seriesName?: string; name?: string }>;
    };
    if (typeof e.seriesName === 'string') return e.seriesName;
    if (typeof e.name === 'string') return e.name;
    const first = e.batch?.[0];
    if (first?.seriesName) return first.seriesName;
    if (first?.name) return first.name;
    return undefined;
}
