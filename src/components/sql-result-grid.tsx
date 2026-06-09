import { createEffect, onCleanup, onMount, type Component } from 'solid-js';
import './data-sources/ag-grid-modules';
import {
    createGrid,
    type ColDef,
    type GridApi,
    type GridOptions,
    type ICellRendererParams,
    type ValueFormatterParams,
} from 'ag-grid-community';
import { shadcnGridTheme } from './data-sources/ag-grid-theme';

type Row = Record<string, unknown>;

type Props = {
    columns: string[];
    rows: Row[];
    /** Enable click-to-sort on headers. Default off (SQL console behavior). */
    sortable?: boolean;
    /** Enable per-column filter menus. Default off (SQL console behavior). */
    filter?: boolean;
    /** Cross-column quick-filter text (AG-Grid `quickFilterText`). */
    quickFilter?: string;
    /**
     * `domLayout: 'autoHeight'` — the grid sizes to its rows instead of
     * filling the parent (used for small result sets so they don't sit in a
     * tall empty box). Renders all rows (no virtualization), so only enable it
     * for small row counts.
     */
    autoHeight?: boolean;
    /** Surfaces the GridApi so a parent toolbar can export / reset state. */
    onReady?: (api: GridApi<Row>) => void;
};

/**
 * In-memory AG-Grid for a materialized result set. The result is already fully
 * in memory, so we use the client-side row model — it still virtualizes rows,
 * matching the Data Sources grid's scroll feel.
 *
 * Defaults are read-only with sorting/filtering OFF (the SQL console's
 * behavior). Action results opt into `sortable`/`filter`/`quickFilter` to get
 * a queryable grid; `onReady` hands the GridApi to a parent toolbar for
 * CSV/Excel export and filter/sort resets.
 */
export const SqlResultGrid: Component<Props> = (props) => {
    let containerRef: HTMLDivElement | undefined;
    let gridApi: GridApi<Row> | null = null;

    const colDefs = (): ColDef<Row>[] =>
        // Coerce to string defensively: AG-Grid's `initDotNotation` calls
        // `field.includes('.')`, so a non-string field (e.g. a column
        // descriptor object that slipped through) throws and the grid renders
        // rows with no columns.
        props.columns.map((col) => {
            const field = String(col);
            return {
                field,
                headerName: field,
                valueFormatter: nullishFormatter,
                cellRenderer: nullishRenderer,
                flex: 1,
                minWidth: 100,
            };
        });

    onMount(() => {
        if (!containerRef) return;
        const options: GridOptions<Row> = {
            theme: shadcnGridTheme,
            columnDefs: colDefs(),
            rowData: props.rows,
            quickFilterText: props.quickFilter ?? '',
            enableCellTextSelection: true,
            defaultColDef: {
                resizable: true,
                sortable: props.sortable ?? false,
                filter: props.filter ?? false,
                editable: false,
                // Treat every value generically; our formatter/renderer
                // handle display, so skip ag-grid's date/number inference.
                cellDataType: false,
            },
            suppressCellFocus: true,
            animateRows: false,
            domLayout: props.autoHeight ? 'autoHeight' : 'normal',
        };
        gridApi = createGrid<Row>(containerRef, options);
        props.onReady?.(gridApi);
    });

    createEffect(() => {
        // Re-bind columns + rows whenever a new result arrives.
        gridApi?.setGridOption('columnDefs', colDefs());
        gridApi?.setGridOption('rowData', props.rows);
    });

    createEffect(() => {
        // Push quick-filter text through whenever the parent changes it.
        gridApi?.setGridOption('quickFilterText', props.quickFilter ?? '');
    });

    onCleanup(() => {
        gridApi?.destroy();
        gridApi = null;
    });

    return (
        <div
            ref={containerRef}
            class={props.autoHeight ? '' : 'flex-1 min-h-0'}
            style={props.autoHeight ? { width: '100%' } : { width: '100%', height: '100%' }}
        />
    );
};

const formatCell = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    if (v instanceof Uint8Array) return `<blob ${v.byteLength}B>`;
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
};

const nullishFormatter = (p: ValueFormatterParams<Row>): string => formatCell(p.value);

const nullishRenderer = (p: ICellRendererParams<Row>): string | HTMLElement => {
    if (p.value === null || p.value === undefined) {
        const span = document.createElement('span');
        span.textContent = '∅';
        span.style.color = 'var(--muted-foreground)';
        span.style.opacity = '0.6';
        return span;
    }
    return formatCell(p.value);
};
