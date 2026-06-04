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
};

/**
 * Read-only AG-Grid for the SQL console result set. The result is already
 * fully materialized in memory (capped at the page's ROW_LIMIT), so we use
 * the client-side row model — it still virtualizes rows, matching the
 * Data Sources grid's scroll feel. Sorting, filtering and editing are all
 * off: this is a result viewer, not an editor.
 */
export const SqlResultGrid: Component<Props> = (props) => {
    let containerRef: HTMLDivElement | undefined;
    let gridApi: GridApi<Row> | null = null;

    const colDefs = (): ColDef<Row>[] =>
        props.columns.map((col) => ({
            field: col,
            headerName: col,
            valueFormatter: nullishFormatter,
            cellRenderer: nullishRenderer,
            flex: 1,
            minWidth: 100,
        }));

    onMount(() => {
        if (!containerRef) return;
        const options: GridOptions<Row> = {
            theme: shadcnGridTheme,
            columnDefs: colDefs(),
            rowData: props.rows,
            defaultColDef: {
                resizable: true,
                sortable: false,
                filter: false,
                editable: false,
                // Treat every value generically; our formatter/renderer
                // handle display, so skip ag-grid's date/number inference.
                cellDataType: false,
            },
            suppressCellFocus: true,
            animateRows: false,
            domLayout: 'normal',
        };
        gridApi = createGrid<Row>(containerRef, options);
    });

    createEffect(() => {
        // Re-bind columns + rows whenever a new result arrives.
        gridApi?.setGridOption('columnDefs', colDefs());
        gridApi?.setGridOption('rowData', props.rows);
    });

    onCleanup(() => {
        gridApi?.destroy();
        gridApi = null;
    });

    return (
        <div ref={containerRef} class="flex-1 min-h-0" style={{ width: '100%', height: '100%' }} />
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
