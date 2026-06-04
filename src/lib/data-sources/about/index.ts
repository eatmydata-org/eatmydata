import { ADVENTUREWORKS } from './adventureworks';
import { CONTOSO } from './contoso';
import { NORTHWIND } from './northwind';
import { RETAIL_M, RETAIL_XL, RETAIL_XS } from './retail';
import type { DemoAbout, DemoFamily, DemoSpec } from './types';

export type { DemoAbout, DemoFamily, DemoSpec, DemoTableSummary, DemoVariant, DemoHiddenPattern } from './types';

/**
 * Registry of all demo datasets keyed by their stable `DemoSpec` id.
 * The picker UI iterates this registry; the demo-source factory looks
 * up an entry to know which file to download and how to caption the
 * meta-table rows.
 */
export const DEMO_ABOUT: Record<DemoSpec, DemoAbout> = {
    'retail-xs': RETAIL_XS,
    'retail-m': RETAIL_M,
    'retail-xl': RETAIL_XL,
    'northwind': NORTHWIND,
    'adventureworks': ADVENTUREWORKS,
    'contoso': CONTOSO,
};

/**
 * Family-grouped view of the registry, e.g. so the UI can render
 * "Retail demo" once with three variant pills underneath.
 */
export const DEMOS_BY_FAMILY: Record<DemoFamily, DemoAbout[]> = (() => {
    const out: Record<DemoFamily, DemoAbout[]> = {
        retail: [],
        northwind: [],
        adventureworks: [],
        contoso: [],
    };
    for (const about of Object.values(DEMO_ABOUT)) {
        out[about.family].push(about);
    }
    return out;
})();

export function getDemoAbout(spec: DemoSpec): DemoAbout {
    return DEMO_ABOUT[spec];
}
