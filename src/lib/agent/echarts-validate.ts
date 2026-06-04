/**
 * Host-side ECharts option validator.
 *
 * Accepts either a single option object (legacy single-chart shape) or an
 * array of option objects (multi-chart dashboard form). For arrays, every
 * element is validated independently; the first hard failure stops, but
 * warnings from every chart are collected and prefixed with `[chart N]`.
 *
 * Uses ECharts' SSR mode (`ssr:true, renderer:'svg'`) so a hidden chart can
 * be instantiated without a DOM container — works in both the browser and
 * the Vitest node environment. We intercept console.error/warn for the
 * duration of setOption to capture ECharts' own validation warnings
 * (mismatched indices, unknown axis types, etc.); thrown errors are caught
 * directly.
 *
 * One additional rule beyond what ECharts itself checks: multi-grid
 * options (`grid: [a, b, ...]` with length > 1) are hard-rejected. They
 * lay out badly with rotated labels and the dashboard renderer now expects
 * an array of single-grid options instead.
 */

import { loadEchartsCore } from '@/lib/echarts/loader';
import { patchEchartsOption } from '@/lib/echarts/patch-option';

export type EchartsValidationResult =
    | { ok: true; warnings: string[] }
    | { ok: false; error: string; warnings: string[] };

const MULTI_GRID_REJECTION =
    'Multi-grid layouts are no longer supported — return an array of options instead, one self-contained chart per element.';

export async function validateEchartsOption(
    option: Record<string, unknown> | Array<Record<string, unknown>>,
): Promise<EchartsValidationResult> {
    if (Array.isArray(option)) {
        const aggregated: string[] = [];
        for (let i = 0; i < option.length; i++) {
            const item = option[i];
            if (!item || typeof item !== 'object' || Array.isArray(item)) {
                return {
                    ok: false,
                    error: `chart ${i}: expected an ECharts option object`,
                    warnings: aggregated,
                };
            }
            const r = await validateSingle(item);
            for (const w of r.warnings) {
                aggregated.push(`[chart ${i}] ${w}`);
            }
            if (!r.ok) {
                return {
                    ok: false,
                    error: `[chart ${i}] ${r.error}`,
                    warnings: aggregated,
                };
            }
        }
        return { ok: true, warnings: aggregated };
    }
    return validateSingle(option);
}

async function validateSingle(
    option: Record<string, unknown>,
): Promise<EchartsValidationResult> {
    if (Array.isArray(option.grid) && option.grid.length > 1) {
        return { ok: false, error: MULTI_GRID_REJECTION, warnings: [] };
    }
    const core = await loadEchartsCore({ renderer: 'svg' });
    const warnings: string[] = [];
    const originalWarn = console.warn;
    const originalError = console.error;
    console.warn = (...args: unknown[]) => {
        warnings.push(args.map(formatArg).join(' '));
    };
    console.error = (...args: unknown[]) => {
        warnings.push(args.map(formatArg).join(' '));
    };

    let chart: ReturnType<typeof core.init> | null = null;
    try {
        chart = core.init(null, null, {
            renderer: 'svg',
            ssr: true,
            width: 600,
            height: 400,
        });
        chart.setOption(patchEchartsOption(option), { notMerge: true });
        return { ok: true, warnings };
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return { ok: false, error: message, warnings };
    } finally {
        console.warn = originalWarn;
        console.error = originalError;
        if (chart) {
            try {
                chart.dispose();
            } catch {
                // ignore disposal errors
            }
        }
    }
}

function formatArg(x: unknown): string {
    if (x instanceof Error) return x.message;
    if (typeof x === 'string') return x;
    try {
        return JSON.stringify(x);
    } catch {
        return String(x);
    }
}
