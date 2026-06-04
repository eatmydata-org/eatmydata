/**
 * Runtime patches for ECharts options produced by LLM-generated code.
 *
 * The Coder agent occasionally emits configs that are syntactically valid
 * but render poorly because of missing-but-implied fields. We patch those
 * before handing the option to `setOption` — both in the host-side
 * validator (so warnings reflect the rendered shape) and in the live
 * renderer.
 *
 * Why this layer exists: the agent writes chart code against the data's
 * *shape* (column names, types) without ever seeing concrete values. Any
 * option whose sensible default depends on the data's value distribution
 * is a candidate to be wrong or missing. ECharts will silently fall back
 * to a hardcoded default (often `100`) and render a degenerate-looking
 * chart with no warning.
 *
 * Currently handles:
 *   - `visualMap` (object or array) with no `max` set, when at least one
 *     bound series carries numeric heatmap-style data `[x, y, v]`.
 *     ECharts defaults `max` to 100, which collapses dollar-valued
 *     heatmaps into a single color.
 *
 * Likely future extensions — same family of "must be derived from data,
 * easy for the LLM to omit":
 *   - `visualMap.min` when the data isn't roughly zero-anchored (e.g.
 *     deltas, z-scores, temperatures). Default 0 produces a one-sided
 *     gradient that hides the negative side.
 *   - Continuous `visualMap` on scatter/line/bar with `dimension` pointing
 *     at a value column — same min/max problem as heatmap.
 *   - `xAxis`/`yAxis` `min`/`max` on value axes when the natural range
 *     doesn't start at 0 (e.g. years, prices in a narrow band). ECharts'
 *     auto-scaling is usually fine, but explicit bounds matter for
 *     dashboards where multiple charts must share a scale.
 *   - `dataZoom` `start`/`end` when the time series is much longer than
 *     what fits — pick a sensible default window (last N points) instead
 *     of showing everything zoomed out.
 *   - `series.symbolSize` on scatter when the value column's magnitude
 *     would produce dots either invisible (<1px) or covering the canvas.
 *   - `pieces`/`splitNumber` on a piecewise `visualMap` chosen from the
 *     actual value distribution rather than a hardcoded count.
 *   - Category axis `data` derived from series rows when the agent forgot
 *     to populate it but the series carries category-keyed points.
 *
 * Add patches conservatively: only when ECharts' silent default is
 * actively misleading, and only when the right value is recoverable from
 * `option.series[].data` without re-querying. Anything that needs the
 * source rows belongs upstream in the executor, not here.
 */

export function patchEchartsOption(
    option: Record<string, unknown>,
): Record<string, unknown> {
    const visualMap = option.visualMap;
    if (!visualMap) return option;

    const series = Array.isArray(option.series)
        ? (option.series as Array<Record<string, unknown>>)
        : [];

    const patchOne = (vm: Record<string, unknown>): Record<string, unknown> => {
        if (vm.max !== undefined) return vm;
        const max = computeMaxForVisualMap(vm, series);
        if (max === null) return vm;
        return { ...vm, max };
    };

    if (Array.isArray(visualMap)) {
        const patched = visualMap.map((vm) =>
            vm && typeof vm === 'object' && !Array.isArray(vm)
                ? patchOne(vm as Record<string, unknown>)
                : vm,
        );
        return { ...option, visualMap: patched };
    }

    if (typeof visualMap === 'object' && !Array.isArray(visualMap)) {
        return { ...option, visualMap: patchOne(visualMap as Record<string, unknown>) };
    }

    return option;
}

function computeMaxForVisualMap(
    vm: Record<string, unknown>,
    series: Array<Record<string, unknown>>,
): number | null {
    const boundIndices = resolveBoundSeriesIndices(vm, series);
    let highest = -Infinity;
    let saw = false;

    for (const idx of boundIndices) {
        const s = series[idx];
        if (!s || typeof s !== 'object') continue;
        const data = s.data;
        if (!Array.isArray(data)) continue;
        const dim = resolveValueDimension(vm, s);
        for (const point of data) {
            const v = extractNumeric(point, dim);
            if (v === null) continue;
            saw = true;
            if (v > highest) highest = v;
        }
    }

    if (!saw || !Number.isFinite(highest)) return null;
    return highest;
}

function resolveBoundSeriesIndices(
    vm: Record<string, unknown>,
    series: Array<Record<string, unknown>>,
): number[] {
    const raw = vm.seriesIndex;
    if (typeof raw === 'number') return [raw];
    if (Array.isArray(raw)) {
        return raw.filter((n): n is number => typeof n === 'number');
    }
    return series.map((_, i) => i);
}

function resolveValueDimension(
    vm: Record<string, unknown>,
    series: Record<string, unknown>,
): number {
    const d = vm.dimension;
    if (typeof d === 'number') return d;
    return series.type === 'heatmap' ? 2 : 1;
}

function extractNumeric(point: unknown, dim: number): number | null {
    if (typeof point === 'number') return Number.isFinite(point) ? point : null;
    if (Array.isArray(point)) {
        const v = point[dim];
        return typeof v === 'number' && Number.isFinite(v) ? v : null;
    }
    if (point && typeof point === 'object') {
        const v = (point as Record<string, unknown>).value;
        if (typeof v === 'number' && Number.isFinite(v)) return v;
        if (Array.isArray(v)) {
            const inner = v[dim];
            return typeof inner === 'number' && Number.isFinite(inner)
                ? inner
                : null;
        }
    }
    return null;
}
