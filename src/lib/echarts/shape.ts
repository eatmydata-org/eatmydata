/**
 * Shared shape predicates and tiny helpers used by the executor, the Coder
 * agent's input unwrapper, and the dashboard renderer / sync controller.
 *
 * Kept dependency-free so it can be imported from anywhere (including the
 * Vitest node environment).
 */

export const ECHARTS_TOP_LEVEL_KEYS = new Set<string>([
    'series',
    'xAxis',
    'yAxis',
    'grid',
    'title',
    'legend',
    'tooltip',
    'dataset',
    'radar',
    'polar',
    'angleAxis',
    'radiusAxis',
    'visualMap',
    'dataZoom',
    'toolbox',
]);

/**
 * Duck-type: is `x` a plain object that looks like an ECharts option? The
 * heuristic is identical to the executor's renderer-format inference — any
 * top-level key drawn from the well-known ECharts set qualifies.
 */
export function isEchartsOption(x: unknown): x is Record<string, unknown> {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return false;
    const o = x as Record<string, unknown>;
    for (const k of Object.keys(o)) {
        if (ECHARTS_TOP_LEVEL_KEYS.has(k)) return true;
    }
    return false;
}

/**
 * Multi-chart marker: an array of one-or-more ECharts options. Used by the
 * renderer to switch into the dashboard path.
 */
export function isEchartsOptionArray(
    x: unknown,
): x is Array<Record<string, unknown>> {
    return Array.isArray(x) && x.length > 0 && x.every(isEchartsOption);
}

/**
 * Cheap deep-equal for axis category arrays — only the primitive-element
 * case matters in practice. Returns false for non-arrays.
 */
export function arraysEqual(a: unknown, b: unknown): boolean {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

/**
 * Normalize an ECharts axis field (which can be a single object or an
 * array) into an array. Returns an empty array when the field is absent
 * or malformed.
 */
export function asAxisArray(
    field: unknown,
): Array<Record<string, unknown>> {
    if (Array.isArray(field)) {
        return field.filter(
            (a): a is Record<string, unknown> =>
                !!a && typeof a === 'object' && !Array.isArray(a),
        );
    }
    if (field && typeof field === 'object' && !Array.isArray(field)) {
        return [field as Record<string, unknown>];
    }
    return [];
}
