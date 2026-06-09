import { createSignal, type Component, type JSX } from 'solid-js';
import type { GridApi } from 'ag-grid-community';
import { SqlResultGrid } from './sql-result-grid';
import { Button } from '@/registry/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/registry/ui/tooltip';
import { exportRowsToXlsx } from '@/lib/export/xlsx';
import { GRID_AUTO_HEIGHT_MAX_ROWS } from '@/lib/actions/render-limits';

type Row = Record<string, unknown>;

type Props = {
    columns: string[];
    rows: Row[];
    /** Bounded box height for the scrollable (large) case. Shorter when
     *  several tables stack in one report. */
    maxHeight?: string;
};

/**
 * Queryable result grid for EVERY tabular result — there is no inline/markdown
 * table path. An icon-only toolbar (quick search, CSV/Excel export, clear
 * filters/sorting) sits above a grid with grid-native sort + column filters.
 *
 * Small results (≤ GRID_AUTO_HEIGHT_MAX_ROWS rows) render with
 * `domLayout:'autoHeight'` so the grid hugs its content instead of sitting in a
 * tall empty box; larger results get a bounded, virtualized, scrollable box
 * (AG-Grid needs an explicit height inside the `overflow-y-auto` Results host).
 */
export const ResultTableGrid: Component<Props> = (props) => {
    const [quick, setQuick] = createSignal('');
    let api: GridApi<Row> | undefined;

    const auto = () => props.rows.length <= GRID_AUTO_HEIGHT_MAX_ROWS;

    const exportCsv = () => api?.exportDataAsCsv({ fileName: 'result.csv' });
    const exportXlsx = () =>
        exportRowsToXlsx(props.rows, 'result.xlsx', {
            columns: props.columns.map((c) => ({ key: c, header: c })),
        });
    const resetFilters = () => {
        api?.setFilterModel(null);
        setQuick('');
    };
    const resetSorting = () => api?.applyColumnState({ defaultState: { sort: null } });

    const rowLabel = () =>
        `${props.rows.length.toLocaleString()} ${props.rows.length === 1 ? 'row' : 'rows'}`;

    return (
        <div
            class="overflow-hidden flex flex-col"
            // autoHeight: let the box grow to the grid's content; bounded box
            // otherwise so virtualization has a fixed viewport to scroll within.
            style={auto() ? undefined : { height: props.maxHeight ?? 'min(70vh, 640px)' }}
        >
            <div class="flex items-center gap-1 pb-2 shrink-0">
                <div class="relative">
                    <SearchIcon />
                    <input
                        value={quick()}
                        onInput={(e) => setQuick(e.currentTarget.value)}
                        placeholder="Filter…"
                        class="h-7 w-44 rounded-lg border bg-background pl-6 pr-2 text-xs outline-none focus:shadow-none"
                    />
                </div>
                <span class="text-xs text-muted-foreground">{rowLabel()}</span>
                <div class="ml-auto flex items-center gap-0.5">
                    <IconButton label="Clear filters" onClick={resetFilters}>
                        <FilterOffIcon />
                    </IconButton>
                    <IconButton label="Clear sorting" onClick={resetSorting}>
                        <SortOffIcon />
                    </IconButton>
                    <IconButton label="Export CSV" onClick={exportCsv}>
                        <DownloadIcon />
                    </IconButton>
                    <IconButton label="Export Excel (.xlsx)" onClick={exportXlsx}>
                        <SheetIcon />
                    </IconButton>
                </div>
            </div>
            <div class={auto() ? '' : 'flex-1 min-h-0 flex flex-col'}>
                <SqlResultGrid
                    columns={props.columns}
                    rows={props.rows}
                    sortable
                    filter
                    quickFilter={quick()}
                    autoHeight={auto()}
                    onReady={(a) => (api = a)}
                />
            </div>
        </div>
    );
};

const IconButton: Component<{
    label: string;
    onClick: () => void;
    children: JSX.Element;
}> = (props) => (
    <Tooltip>
        <TooltipTrigger
            as={Button}
            variant="ghost"
            size="sm"
            class="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
            aria-label={props.label}
            onClick={props.onClick}
        >
            {props.children}
        </TooltipTrigger>
        <TooltipContent>{props.label}</TooltipContent>
    </Tooltip>
);

/* — tiny inline icons (no icon dependency in this repo) — */

const svgBase = {
    width: '14',
    height: '14',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round' as const,
    'stroke-linejoin': 'round' as const,
};

const SearchIcon = () => (
    <svg
        {...svgBase}
        class="absolute left-1.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground pointer-events-none"
    >
        <circle cx="11" cy="11" r="7" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
);

const DownloadIcon = () => (
    <svg {...svgBase}>
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
);

const SheetIcon = () => (
    <svg {...svgBase}>
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <line x1="3" y1="9" x2="21" y2="9" />
        <line x1="3" y1="15" x2="21" y2="15" />
        <line x1="9" y1="3" x2="9" y2="21" />
    </svg>
);

const FilterOffIcon = () => (
    <svg {...svgBase}>
        <path d="M3 4h18l-7 8v6l-4 2v-8L3 4z" />
        <line x1="3" y1="3" x2="21" y2="21" />
    </svg>
);

const SortOffIcon = () => (
    <svg {...svgBase}>
        <path d="M7 4v16" />
        <polyline points="3 8 7 4 11 8" />
        <path d="M17 20V8" />
        <polyline points="13 12 17 8 21 12" />
    </svg>
);
