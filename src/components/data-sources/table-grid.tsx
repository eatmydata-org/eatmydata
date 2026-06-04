import {
    createSignal,
    onCleanup,
    onMount,
    Show,
    For,
    createEffect,
    type Component,
} from 'solid-js';
import './ag-grid-modules';
import {
    createGrid,
    type CellValueChangedEvent,
    type ColDef,
    type GridApi,
    type GridOptions,
    type ICellRendererParams,
    type IDatasource,
    type IGetRowsParams,
} from 'ag-grid-community';
import { shadcnGridTheme } from './ag-grid-theme';
import {
    escIdent,
    filterModelToWhere,
    sortModelToOrderBy,
    sqlLiteralValue,
    type FilterModel,
    type SortModelItem,
} from '@/lib/data-sources/ag-grid-sql';
import { Button } from '@/registry/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/registry/ui/tooltip';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/registry/ui/dialog';
import { getSourceDb, deleteTableMeta } from '@/lib/data-sources/db';
import type { DataSource } from '@/lib/data-sources/types';
import type { ColumnInfo, TableSchema } from '@/lib/wa-sqlite/types';
import { isUnreadableDbError, UNREADABLE_DB_MESSAGE } from '@/lib/wa-sqlite/validate';
import { exportTableToXlsxBytes, downloadBytes } from '@/lib/data-sources/export-table';
import {
    importIntoExisting,
    type StructureMismatch,
} from '@/lib/data-sources/import-into-existing';
import { deleteActionCascade, findActionsReferencingTable } from '@/lib/actions/store';
import type { Action } from '@/lib/actions/types';
import { ConfirmDialog } from './confirm-dialog';
import { CascadeDropDialog, type CascadeChoice } from './cascade-drop-dialog';

type Props = {
    source: DataSource;
    tableName: string;
    /** Pass true for views (sqlite-side immutable). */
    readOnly?: boolean;
    /** Bumped externally to force a re-fetch (e.g. after re-import). */
    refreshTick?: number;
    /** Called after destructive or structural changes so the parent
     * (source-detail) can re-fetch the table list. */
    onSchemaChanged?: () => void;
    /** Called after a successful in-table data replace so the grid
     * itself re-loads its rows. The parent doesn't necessarily care
     * about pure data swaps. */
    onDataReplaced?: () => void;
};

/** Rows per page request to sqlite. ag-grid's default is 100. */
const CACHE_BLOCK_SIZE = 100;
/** Maximum number of cached blocks (older blocks get evicted as user scrolls). */
const MAX_BLOCKS_IN_CACHE = 20;
/** Debounce on per-keystroke filter UI before the cache repopulates. */
const FILTER_DEBOUNCE_MS = 200;

export const TableGrid: Component<Props> = (props) => {
    const [schema, setSchema] = createSignal<TableSchema | null>(null);
    const [error, setError] = createSignal<string | null>(null);
    const [totalCount, setTotalCount] = createSignal<number | null>(null);
    const [busyAction, setBusyAction] = createSignal<string | null>(null);
    const [mismatch, setMismatch] = createSignal<StructureMismatch | null>(null);
    // Resolver for the "structure mismatch" dialog promise. When the
    // user clicks Replace / Cancel, importIntoExisting's callback resumes.
    let mismatchResolve: ((decision: 'replace-structure' | 'cancel') => void) | null = null;
    let importFileInputRef: HTMLInputElement | undefined;

    // The grid mounts imperatively; we keep a handle so we can refresh
    // and clean up.
    let containerRef: HTMLDivElement | undefined;
    let gridApi: GridApi<RowData> | null = null;

    /**
     * Build an IDatasource that pushes limit/offset/sort/filter down to
     * sqlite. Closes over `schema()` so we know whether to select rowid.
     * Views don't have rowid; editing is also disabled for views so the
     * column is only requested for tables.
     */
    const makeDatasource = (): IDatasource => ({
        getRows: async (params: IGetRowsParams) => {
            try {
                const s = schema();
                if (!s) {
                    params.successCallback([], 0);
                    return;
                }
                const db = await getSourceDb(props.source);
                const limit = params.endRow - params.startRow;
                const offset = params.startRow;
                const where = filterModelToWhere(params.filterModel as FilterModel);
                const orderBy = sortModelToOrderBy(params.sortModel as SortModelItem[]);
                const tbl = escIdent(props.tableName);
                const isView = s.type === 'view';
                const select = isView ? `SELECT *` : `SELECT rowid AS __rowid, *`;
                const sql = `${select} FROM "${tbl}"${where}${orderBy} LIMIT ${limit} OFFSET ${offset}`;
                const res = await db.execRaw(sql, limit);
                const rows: RowData[] = res.rows.map((r, i) => ({
                    ...(r as Record<string, unknown>),
                    __rowid: (r.__rowid as number | undefined) ?? offset + i + 1,
                }));
                // A short read tells the grid this is the last block.
                const lastRow = rows.length < limit ? params.startRow + rows.length : undefined;
                params.successCallback(rows, lastRow);
            } catch (err) {
                console.error('[grid] getRows failed', err);
                setError(err instanceof Error ? err.message : String(err));
                params.failCallback();
            }
        },
    });

    const refreshRowCount = async () => {
        try {
            const db = await getSourceDb(props.source);
            const filterModel = gridApi?.getFilterModel() as FilterModel | undefined;
            const where = filterModelToWhere(filterModel);
            const sql = `SELECT COUNT(*) AS n FROM "${escIdent(props.tableName)}"${where}`;
            const res = await db.execRaw(sql, 1);
            setTotalCount(Number(res.rows[0]?.n ?? 0));
        } catch (err) {
            // Count is informational; don't surface as a hard error.
            console.warn('[grid] count query failed', err);
        }
    };

    const loadSchemaAndBind = async () => {
        // Callers invoke this as `void loadSchemaAndBind()`, so a throw here
        // would become an unhandled rejection that never reaches the UI.
        // Catch + surface via the error signal (e.g. an unreadable db).
        try {
            const db = await getSourceDb(props.source);
            const all = (await db.getSchema()) as TableSchema[];
            const found = all.find((t) => t.name === props.tableName);
            if (!found) {
                setError(`Table not found: ${props.tableName}`);
                return;
            }
            setSchema(found);
            // Setting a fresh datasource purges the grid's block cache and
            // triggers the first getRows call.
            gridApi?.setGridOption('datasource', makeDatasource());
            await refreshRowCount();
        } catch (e) {
            setError(
                isUnreadableDbError(e)
                    ? UNREADABLE_DB_MESSAGE
                    : e instanceof Error
                      ? e.message
                      : String(e),
            );
        }
    };

    const colDefs = (): ColDef<RowData>[] => {
        const s = schema();
        if (!s) return [];
        const isView = s.type === 'view';
        const allowEdit = !props.readOnly && !isView;
        return s.columns.map((col) => ({
            field: col.name,
            headerName: col.name,
            editable: allowEdit,
            cellDataType: cellDataTypeFor(col),
            valueFormatter: nullishFormatter,
            cellRenderer: nullishRenderer,
            // Distribute width: numeric narrow, text wide.
            flex: col.type.toUpperCase().includes('INT') ? 1 : 2,
            minWidth: 100,
        }));
    };

    const handleResetFilters = () => {
        gridApi?.setFilterModel(null);
    };

    const handleResetSorting = () => {
        gridApi?.applyColumnState({ defaultState: { sort: null } });
    };

    const handleExport = async () => {
        if (busyAction()) return;
        setBusyAction('export');
        setError(null);
        try {
            const bytes = await exportTableToXlsxBytes(props.source, props.tableName);
            downloadBytes(bytes, `${props.tableName}.xlsx`);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusyAction(null);
        }
    };

    const [confirmDeleteOpen, setConfirmDeleteOpen] = createSignal(false);
    const [cascadeActions, setCascadeActions] = createSignal<Action[] | null>(null);

    const handleDelete = () => {
        if (busyAction()) return;
        setConfirmDeleteOpen(true);
    };

    const actuallyDropTable = async (cascadeIds: string[] = []) => {
        const isView = schema()?.type === 'view';
        setBusyAction('delete');
        setError(null);
        try {
            for (const actionId of cascadeIds) {
                try {
                    await deleteActionCascade(actionId);
                } catch (e) {
                    console.warn('[table-grid] cascade action delete failed', actionId, e);
                }
            }
            const db = await getSourceDb(props.source);
            await db.execRaw(
                isView
                    ? `DROP VIEW IF EXISTS "${escIdent(props.tableName)}"`
                    : `DROP TABLE IF EXISTS "${escIdent(props.tableName)}"`,
            );
            if (!isView) {
                await deleteTableMeta(props.source, props.tableName);
            }
            props.onSchemaChanged?.();
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusyAction(null);
        }
    };

    const runDelete = async () => {
        // Probe for actions that reference this table. Views are dropped
        // without a cascade prompt — they're cheap to recreate from the
        // view editor, and we don't sniff view bodies.
        const isView = schema()?.type === 'view';
        if (isView) {
            setConfirmDeleteOpen(false);
            await actuallyDropTable();
            return;
        }
        const referencing = await findActionsReferencingTable(props.source.id, props.tableName);
        if (referencing.length > 0) {
            setConfirmDeleteOpen(false);
            setCascadeActions(referencing);
            return;
        }
        setConfirmDeleteOpen(false);
        await actuallyDropTable();
    };

    const onCascadeChoice = async (choice: CascadeChoice) => {
        const actions = cascadeActions();
        setCascadeActions(null);
        if (!actions || choice === 'cancel') return;
        const ids = choice === 'cascade' ? actions.map((a) => a.id) : [];
        await actuallyDropTable(ids);
    };

    const handleImportClick = () => {
        if (busyAction()) return;
        importFileInputRef?.click();
    };

    const handleImportFile = async (e: Event) => {
        const input = e.currentTarget as HTMLInputElement;
        const file = input.files?.[0];
        input.value = '';
        if (!file) return;
        setBusyAction('import');
        setError(null);
        try {
            const result = await importIntoExisting(
                props.source,
                props.tableName,
                file,
                // Promise-based bridge to the mismatch dialog: stash
                // the resolver, show the dialog, and wait for click.
                (mm) =>
                    new Promise<'replace-structure' | 'cancel'>((resolve) => {
                        mismatchResolve = resolve;
                        setMismatch(mm);
                    }),
            );
            if (result.mode === 'data-only') {
                props.onDataReplaced?.();
                await loadSchemaAndBind();
            } else if (result.mode === 'structure-and-data') {
                props.onSchemaChanged?.();
            }
            // 'cancelled' → no-op.
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusyAction(null);
            mismatchResolve = null;
            setMismatch(null);
        }
    };

    const resolveMismatch = (decision: 'replace-structure' | 'cancel') => {
        // setMismatch(null) is deferred to the finally block in
        // handleImportFile so the dialog stays mounted until the
        // import promise resolves.
        mismatchResolve?.(decision);
    };

    const handleCellEdit = async (e: CellValueChangedEvent<RowData>) => {
        if (props.readOnly) return;
        const rowid = e.data.__rowid;
        const col = e.colDef.field;
        if (!col || typeof rowid !== 'number') return;
        try {
            const db = await getSourceDb(props.source);
            const newVal = e.newValue;
            const literal = sqlLiteralValue(newVal);
            await db.execRaw(
                `UPDATE "${escIdent(props.tableName)}" ` +
                    `SET "${escIdent(col)}" = ${literal} WHERE rowid = ${rowid}`,
            );
        } catch (err) {
            console.error('[grid] edit failed; reverting', err);
            // Revert via grid API: set back the old value.
            e.node.setDataValue(col, e.oldValue);
            setError(err instanceof Error ? err.message : String(err));
        }
    };

    onMount(() => {
        if (!containerRef) return;
        const options: GridOptions<RowData> = {
            theme: shadcnGridTheme,
            columnDefs: [],
            defaultColDef: {
                resizable: true,
                sortable: true,
                filter: true,
                editable: !props.readOnly,
                // Debounce per-keystroke filter changes before they
                // purge the grid's block cache and re-query sqlite.
                filterParams: { debounceMs: FILTER_DEBOUNCE_MS },
            },
            getRowId: (p) => String((p.data as RowData).__rowid),
            stopEditingWhenCellsLoseFocus: true,
            singleClickEdit: false,
            animateRows: false,
            domLayout: 'normal',
            // Infinite Row Model: paginated server-side fetches via
            // IDatasource. ag-grid Community supports this row model;
            // SSRM is Enterprise and we don't need it.
            rowModelType: 'infinite',
            cacheBlockSize: CACHE_BLOCK_SIZE,
            maxBlocksInCache: MAX_BLOCKS_IN_CACHE,
            // Placeholder height until the grid has discovered lastRow.
            // Updated on the fly via setRowCount once the count query
            // returns.
            infiniteInitialRowCount: CACHE_BLOCK_SIZE,
            rowBuffer: 10,
            suppressColumnVirtualisation: false,
            onCellValueChanged: handleCellEdit,
            // Filter changes auto-purge the infinite cache; we also
            // need to re-count for the footer. Debouncing happens in
            // the filter UI (filterParams.debounceMs), so this fires
            // at most once per debounce window.
            onFilterChanged: () => {
                void refreshRowCount();
            },
        };
        gridApi = createGrid<RowData>(containerRef, options);
        void loadSchemaAndBind();
    });

    createEffect(() => {
        // Re-fetch when table or refresh tick changes.
        props.tableName;
        props.refreshTick;
        props.source.id;
        if (gridApi) {
            setSchema(null);
            setError(null);
            setTotalCount(null);
            void loadSchemaAndBind();
        }
    });

    createEffect(() => {
        const defs = colDefs();
        gridApi?.setGridOption('columnDefs', defs);
    });

    onCleanup(() => {
        gridApi?.destroy();
        gridApi = null;
    });

    const isView = () => schema()?.type === 'view';
    return (
        <div class="flex-1 min-h-0 flex flex-col gap-2">
            <div class="flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
                <span class="font-mono text-foreground">{props.tableName}</span>
                <span>·</span>
                <span>
                    {totalCount() === null
                        ? '…'
                        : `${totalCount()!.toLocaleString()} ${totalCount() === 1 ? 'row' : 'rows'}`}
                </span>
                <Show when={props.readOnly}>
                    <span class="text-amber-600 dark:text-amber-400">read-only</span>
                </Show>
                <div class="ml-auto flex items-center gap-1">
                    <Button size="sm" variant="ghost" onClick={handleResetFilters}>
                        Reset filters
                    </Button>
                    <Button size="sm" variant="ghost" onClick={handleResetSorting}>
                        Reset sorting
                    </Button>
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void handleExport()}
                        disabled={busyAction() === 'export'}
                    >
                        {busyAction() === 'export' ? 'Exporting…' : 'Export table'}
                    </Button>
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={handleImportClick}
                        disabled={busyAction() === 'import' || isView()}
                        title={isView() ? 'Views cannot be re-imported' : undefined}
                    >
                        {busyAction() === 'import' ? 'Importing…' : 'Import table'}
                    </Button>
                    <Button
                        size="sm"
                        variant="ghost"
                        class="text-destructive hover:text-destructive"
                        onClick={() => void handleDelete()}
                        disabled={busyAction() === 'delete'}
                    >
                        {busyAction() === 'delete' ? 'Deleting…' : 'Delete table'}
                    </Button>
                    <Tooltip>
                        <TooltipTrigger as={Button} size="sm" variant="secondary" disabled>
                            Redact PII
                        </TooltipTrigger>
                        <TooltipContent>
                            Coming soon — mass-redact PII across selected columns.
                        </TooltipContent>
                    </Tooltip>
                </div>
            </div>
            <Show when={error()}>
                <div class="rounded-md border border-destructive/50 bg-destructive/10 text-destructive px-3 py-2 text-xs">
                    {error()}
                </div>
            </Show>
            {/* Explicit dimensions: ag-grid's row virtualization depends on
                knowing the container height at init. With purely
                flex-based sizing, the container can briefly measure as 0
                during mount and the grid won't virtualize correctly.
                `flex: 1 1 0; min-height: 0` participates in the flex
                parent; `height: 100%` is a belt-and-suspenders for the
                ResizeObserver tick. */}
            <div
                ref={containerRef}
                class="flex-1 min-h-0"
                style={{ width: '100%', height: '100%' }}
            />
            <input
                ref={importFileInputRef}
                type="file"
                accept=".csv,.tsv,.xlsx,.xls"
                class="hidden"
                onChange={handleImportFile}
            />
            <Show when={mismatch()}>
                <StructureMismatchDialog
                    mismatch={mismatch()!}
                    tableName={props.tableName}
                    onDecision={resolveMismatch}
                />
            </Show>
            <ConfirmDialog
                open={confirmDeleteOpen()}
                onOpenChange={setConfirmDeleteOpen}
                title={`Delete ${schema()?.type === 'view' ? 'view' : 'table'} "${props.tableName}"?`}
                description={
                    schema()?.type === 'view'
                        ? 'The view definition will be removed; underlying tables are untouched.'
                        : 'All rows in this table will be lost. This cannot be undone.'
                }
                confirmLabel={schema()?.type === 'view' ? 'Drop view' : 'Delete table'}
                closeOnConfirm={false}
                onConfirm={runDelete}
            />
            <Show when={cascadeActions()}>
                {(actions) => (
                    <CascadeDropDialog
                        open
                        kind={schema()?.type === 'view' ? 'view' : 'table'}
                        tableName={props.tableName}
                        actions={actions()}
                        onChoice={(c) => void onCascadeChoice(c)}
                    />
                )}
            </Show>
        </div>
    );
};

type RowData = Record<string, unknown> & { __rowid: number };

const StructureMismatchDialog: Component<{
    mismatch: StructureMismatch;
    tableName: string;
    onDecision(d: 'replace-structure' | 'cancel'): void;
}> = (props) => (
    <Dialog open onOpenChange={(o) => !o && props.onDecision('cancel')}>
        <DialogContent class="max-w-xl">
            <DialogHeader>
                <DialogTitle>Structure of "{props.tableName}" does not match</DialogTitle>
                <DialogDescription>
                    The file you're importing has a different column shape than the existing table.
                    Replace the table structure too, or cancel?
                </DialogDescription>
            </DialogHeader>
            <div class="text-xs text-muted-foreground flex flex-col gap-2">
                <div>
                    <div class="font-medium text-foreground mb-0.5">Differences</div>
                    <ul class="list-disc list-inside font-mono">
                        <For each={props.mismatch.reasons}>{(r) => <li>{r}</li>}</For>
                    </ul>
                </div>
                <div class="grid grid-cols-2 gap-3 mt-2">
                    <ColumnList title="Current" columns={props.mismatch.current} />
                    <ColumnList title="Incoming" columns={props.mismatch.incoming} />
                </div>
            </div>
            <DialogFooter>
                <Button variant="ghost" onClick={() => props.onDecision('cancel')}>
                    Cancel
                </Button>
                <Button
                    class="bg-destructive hover:bg-destructive/90"
                    onClick={() => props.onDecision('replace-structure')}
                >
                    Replace structure + data
                </Button>
            </DialogFooter>
        </DialogContent>
    </Dialog>
);

const ColumnList: Component<{
    title: string;
    columns: Array<{ name: string; type: string }>;
}> = (props) => (
    <div class="rounded-md border border-border bg-muted/30 p-2 text-xs">
        <div class="font-medium text-foreground mb-1">{props.title}</div>
        <Show
            when={props.columns.length > 0}
            fallback={<span class="italic text-muted-foreground">(empty)</span>}
        >
            <ul class="font-mono">
                <For each={props.columns}>
                    {(c) => (
                        <li class="truncate">
                            <span>{c.name}</span>
                            <span class="text-muted-foreground"> · {c.type || '?'}</span>
                        </li>
                    )}
                </For>
            </ul>
        </Show>
    </div>
);

// TODO(pii-redact): when implemented, the toolbar button above wires
// into the PII worker (src/lib/pii/worker.ts) batch-redact path.
// Selection model: column-multi-select via grid header right-click →
// "Redact this column"; runs the NER pipeline over every cell and
// stores both the redacted value and the redaction map (so the user
// can un-redact). Disabled here intentionally.

function cellDataTypeFor(col: ColumnInfo): string {
    const t = col.type.toUpperCase();
    if (t.includes('INT')) return 'number';
    if (t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB')) return 'number';
    if (t.includes('BOOL')) return 'boolean';
    return 'text';
}

const nullishFormatter = (p: { value: unknown }): string => {
    if (p.value === null || p.value === undefined) return '';
    if (typeof p.value === 'object') return JSON.stringify(p.value);
    return String(p.value);
};

const nullishRenderer = (p: ICellRendererParams): string | HTMLElement => {
    if (p.value === null || p.value === undefined) {
        const span = document.createElement('span');
        span.textContent = '∅';
        span.style.color = 'var(--muted-foreground)';
        span.style.opacity = '0.6';
        return span;
    }
    if (typeof p.value === 'object') return JSON.stringify(p.value);
    return String(p.value);
};
