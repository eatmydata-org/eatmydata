import { For, Show, createMemo, createResource, createSignal, type Component } from 'solid-js';
import { Button } from '@/registry/ui/button';
import { Badge } from '@/registry/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/registry/ui/popover';
import type { DataSource } from '@/lib/data-sources/types';
import { getSourceDb, listTableMeta, deleteTableMeta } from '@/lib/data-sources/db';
import { listSources, putSource } from '@/lib/data-sources/store';
import { dedupHumanName } from '@/lib/data-sources/identifier';
import { deleteActionCascade, findActionsReferencingTable } from '@/lib/actions/store';
import type { Action } from '@/lib/actions/types';
import type { TableSchema } from '@/lib/wa-sqlite/types';
import { formatAgo } from '@/lib/format-time';
import { TableGrid } from './table-grid';
import { ConfirmDialog } from './confirm-dialog';
import { CascadeDropDialog, type CascadeChoice } from './cascade-drop-dialog';
import { EditableName } from '@/components/editable-name';
import { PaneHeader, PaneHeaderActions } from '@/components/pane-header';
import { isUnreadableDbError, UNREADABLE_DB_MESSAGE } from '@/lib/wa-sqlite/validate';

type Props = {
    source: DataSource;
    /** Bumped after imports/view creation so the table list re-fetches. */
    schemaRefreshTick: number;
    onImport(pinnedTable?: string): void;
    onCreateView(): void;
    /** Called after a successful rename so the sidebar re-fetches. */
    onSourceUpdated?: () => void;
    /** Triggered when the user clicks "Delete data source"; the route
     * owns the actual delete + refresh logic. */
    onRequestDeleteSource(): void;
};

export const SourceDetail: Component<Props> = (props) => {
    const [selectedTable, setSelectedTable] = createSignal<string | null>(null);
    const [gridRefreshTick, setGridRefreshTick] = createSignal(0);

    const refreshKey = createMemo(() => `${props.source.id}:${props.schemaRefreshTick}`);

    type TableEntry = TableSchema & {
        meta: Awaited<ReturnType<typeof listTableMeta>>[number] | undefined;
    };
    type SchemaResult = { ok: true; tables: TableEntry[] } | { ok: false; error: string };

    // The fetcher catches its own errors and returns a discriminated result
    // instead of throwing. Reading an *errored* createResource re-throws
    // synchronously during render — which previously crashed the whole page
    // (and every other source with it) the moment a corrupt/non-database
    // source got selected. Returning `{ ok: false }` keeps the failure local.
    const [tables] = createResource<SchemaResult, string>(refreshKey, async () => {
        const db = await getSourceDb(props.source);
        try {
            const all = (await db.getSchema()) as TableSchema[];
            const meta = await listTableMeta(props.source);
            const metaByName = new Map(meta.map((m) => [m.tableName, m]));
            // Hide our own meta table from the user.
            return {
                ok: true,
                tables: all
                    .filter((t) => t.name !== '__rh_meta_tables')
                    .map((t) => ({ ...t, meta: metaByName.get(t.name) })),
            };
        } catch (e) {
            const error = isUnreadableDbError(e)
                ? UNREADABLE_DB_MESSAGE
                : e instanceof Error
                  ? e.message
                  : String(e);
            return { ok: false, error };
        }
    });

    const entries = (): TableEntry[] => {
        const r = tables();
        return r && r.ok ? r.tables : [];
    };
    const loadError = (): string | null => {
        const r = tables();
        return r && !r.ok ? r.error : null;
    };

    const tablesList = () => entries().filter((t) => t.type === 'table');
    const viewsList = () => entries().filter((t) => t.type === 'view');

    // Auto-pick the first table when source changes.
    createMemo(() => {
        const list = entries();
        if (list.length > 0) {
            if (!selectedTable() || !list.find((t) => t.name === selectedTable())) {
                setSelectedTable(list[0]!.name);
            }
        } else {
            setSelectedTable(null);
        }
    });

    // State-driven drop confirmations (no more native confirm()). One
    // signal holds the target — the dialog reads it to render its
    // title and confirms via the stored kind.
    const [pendingDrop, setPendingDrop] = createSignal<
        { kind: 'table'; name: string } | { kind: 'view'; name: string } | null
    >(null);

    // Cascade-delete check: tables referenced by saved Actions get an
    // intermediate dialog asking the user what to do with those actions.
    const [cascade, setCascade] = createSignal<{
        kind: 'table' | 'view';
        name: string;
        actions: Action[];
    } | null>(null);

    const dropTableOrView = async (kind: 'table' | 'view', name: string): Promise<void> => {
        const db = await getSourceDb(props.source);
        const safe = name.replace(/"/g, '""');
        if (kind === 'table') {
            await db.execRaw(`DROP TABLE IF EXISTS "${safe}"`);
            await deleteTableMeta(props.source, name);
        } else {
            await db.execRaw(`DROP VIEW IF EXISTS "${safe}"`);
        }
    };

    const runDrop = async () => {
        const target = pendingDrop();
        if (!target) return;
        // Before dropping, check whether any saved Action references this
        // table/view. If so, switch to the cascade dialog and let the user
        // decide what to do with the referencing actions.
        const referencing = await findActionsReferencingTable(props.source.id, target.name);
        if (referencing.length > 0) {
            // Close the basic confirm; the cascade dialog drives from here.
            setPendingDrop(null);
            setCascade({
                kind: target.kind,
                name: target.name,
                actions: referencing,
            });
            return;
        }
        await dropTableOrView(target.kind, target.name);
        setPendingDrop(null);
        setGridRefreshTick((t) => t + 1);
    };

    const onCascadeChoice = async (choice: CascadeChoice) => {
        const c = cascade();
        if (!c) return;
        if (choice === 'cancel') {
            setCascade(null);
            return;
        }
        if (choice === 'cascade') {
            for (const a of c.actions) {
                try {
                    await deleteActionCascade(a.id);
                } catch (e) {
                    console.warn('[data-sources] cascade action delete failed', a.id, e);
                }
            }
        }
        await dropTableOrView(c.kind, c.name);
        setCascade(null);
        setGridRefreshTick((t) => t + 1);
    };

    const saveRename = async (raw: string) => {
        const next = raw.trim();
        if (!next || next === props.source.name) return;
        const all = await listSources();
        const taken = new Set(all.filter((s) => s.id !== props.source.id).map((s) => s.name));
        const finalName = dedupHumanName(next, taken);
        await putSource({
            ...props.source,
            name: finalName,
            updatedAt: Date.now(),
        });
        props.onSourceUpdated?.();
    };

    return (
        <main class="h-full min-w-0 flex flex-col overflow-hidden">
            <PaneHeader>
                <EditableName
                    value={props.source.name}
                    // Demo sources are read-only; their names stay as-is.
                    disabled={props.source.kind === 'demo'}
                    onSave={(name) => void saveRename(name)}
                    class="text-sm font-semibold truncate max-w-[28ch]"
                    inputClass="text-sm font-semibold bg-transparent border-b border-primary px-0.5 outline-none w-[28ch]"
                />
                <span class="text-[10px] text-muted-foreground whitespace-nowrap">
                    {props.source.kind === 'demo'
                        ? 'Built-in demo data'
                        : `${tablesList().length} table${tablesList().length === 1 ? '' : 's'} · ${viewsList().length} view${viewsList().length === 1 ? '' : 's'}`}
                    <span class="mx-1">·</span>
                    <span title={new Date(props.source.createdAt).toLocaleString()}>
                        created {formatAgo(props.source.createdAt)}
                    </span>
                </span>
                <PaneHeaderActions class="gap-2">
                    <Button size="sm" variant="default" onClick={() => props.onImport()}>
                        Import…
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => props.onCreateView()}>
                        + View
                    </Button>
                    <SourceInfoPopover source={props.source} />
                    <Button
                        size="sm"
                        variant="ghost"
                        class="text-destructive hover:text-destructive hover:bg-destructive/10"
                        onClick={() => props.onRequestDeleteSource()}
                    >
                        Delete data source
                    </Button>
                </PaneHeaderActions>
            </PaneHeader>
            <ConfirmDialog
                open={pendingDrop() !== null}
                onOpenChange={(o) => !o && setPendingDrop(null)}
                title={
                    pendingDrop()?.kind === 'view'
                        ? `Drop view "${pendingDrop()?.name}"?`
                        : `Drop table "${pendingDrop()?.name}"?`
                }
                description={
                    pendingDrop()?.kind === 'view'
                        ? 'The view definition will be removed. Underlying tables are not affected.'
                        : 'All rows will be lost. Views that reference this table will fail.'
                }
                confirmLabel={pendingDrop()?.kind === 'view' ? 'Drop view' : 'Drop table'}
                closeOnConfirm={false}
                onConfirm={runDrop}
            />
            <Show when={cascade()}>
                {(c) => (
                    <CascadeDropDialog
                        open
                        kind={c().kind}
                        tableName={c().name}
                        actions={c().actions}
                        onChoice={(ch) => void onCascadeChoice(ch)}
                    />
                )}
            </Show>
            <div class="flex-1 min-h-0 flex">
                <aside class="w-56 shrink-0 border-r overflow-y-auto bg-card/20">
                    <Show when={tablesList().length > 0}>
                        <ul>
                            <For each={tablesList()}>
                                {(t) => (
                                    <TableItem
                                        name={t.name}
                                        active={selectedTable() === t.name}
                                        meta={t.meta?.originalFileName}
                                        createdAt={t.meta?.importedAt}
                                        onSelect={() => setSelectedTable(t.name)}
                                        onReimport={() => props.onImport(t.name)}
                                        onDrop={() =>
                                            setPendingDrop({
                                                kind: 'table',
                                                name: t.name,
                                            })
                                        }
                                    />
                                )}
                            </For>
                        </ul>
                    </Show>
                    <Show when={viewsList().length > 0}>
                        <SectionHeader>Views</SectionHeader>
                        <ul>
                            <For each={viewsList()}>
                                {(v) => (
                                    <ViewItem
                                        name={v.name}
                                        active={selectedTable() === v.name}
                                        onSelect={() => setSelectedTable(v.name)}
                                        onDrop={() =>
                                            setPendingDrop({
                                                kind: 'view',
                                                name: v.name,
                                            })
                                        }
                                    />
                                )}
                            </For>
                        </ul>
                    </Show>
                    <Show when={loadError()}>
                        <p class="text-xs text-destructive italic px-3 py-4">Unavailable</p>
                    </Show>
                    <Show
                        when={
                            !tables.loading &&
                            !loadError() &&
                            tablesList().length === 0 &&
                            viewsList().length === 0
                        }
                    >
                        <p class="text-xs text-muted-foreground italic px-3 py-4">
                            Empty source — import a file to get started.
                        </p>
                    </Show>
                </aside>
                <section class="flex-1 min-w-0 flex flex-col px-4 pt-2 pb-4 overflow-hidden">
                    <Show
                        when={loadError()}
                        fallback={
                            <Show
                                when={selectedTable()}
                                fallback={
                                    <p class="text-sm text-muted-foreground italic">
                                        Pick a table or view from the left.
                                    </p>
                                }
                            >
                                {(t) => (
                                    <TableGrid
                                        source={props.source}
                                        tableName={t()}
                                        readOnly={props.source.kind === 'demo'}
                                        refreshTick={gridRefreshTick()}
                                        onSchemaChanged={() => {
                                            // Table dropped or its column shape
                                            // changed — invalidate our table list
                                            // AND nudge any sibling components
                                            // (sidebar, etc.) via the parent.
                                            setGridRefreshTick((n) => n + 1);
                                            props.onSourceUpdated?.();
                                        }}
                                        onDataReplaced={() => setGridRefreshTick((n) => n + 1)}
                                    />
                                )}
                            </Show>
                        }
                    >
                        {(err) => (
                            <div class="m-auto max-w-md text-center flex flex-col items-center gap-3">
                                <div class="text-destructive text-3xl leading-none">⚠</div>
                                <p class="text-sm font-semibold">Can't open this data source</p>
                                <p class="text-xs text-muted-foreground whitespace-pre-wrap">
                                    {err()}
                                </p>
                                <Button
                                    size="sm"
                                    variant="destructive"
                                    onClick={() => props.onRequestDeleteSource()}
                                >
                                    Delete data source
                                </Button>
                            </div>
                        )}
                    </Show>
                </section>
            </div>
        </main>
    );
};

const SectionHeader: Component<{ children: any }> = (props) => (
    <div class="px-3 pt-3 pb-1 text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
        {props.children}
    </div>
);

/**
 * "Info" button in the header that pops a small panel with the OPFS
 * filename, persistence mode, kind, demo spec (if applicable), and full
 * createdAt / updatedAt timestamps. Read-only — anything edit-worthy lives
 * elsewhere (rename inline, delete via the button next to this one).
 */
const SourceInfoPopover: Component<{ source: DataSource }> = (props) => {
    const fmt = (ms: number): string => new Date(ms).toLocaleString();
    return (
        <Popover>
            <PopoverTrigger as={Button} size="sm" variant="ghost" title="Source info">
                Info
            </PopoverTrigger>
            <PopoverContent class="w-80 text-xs">
                <div class="font-semibold text-sm mb-2">Source info</div>
                <dl class="grid grid-cols-[80px_1fr] gap-x-2 gap-y-1">
                    <dt class="text-muted-foreground">Name</dt>
                    <dd class="font-medium truncate" title={props.source.name}>
                        {props.source.name}
                    </dd>
                    <dt class="text-muted-foreground">OPFS file</dt>
                    <dd class="font-mono truncate" title={props.source.dbFile}>
                        {props.source.dbFile}
                    </dd>
                    <dt class="text-muted-foreground">Persistence</dt>
                    <dd class="font-mono">{props.source.persistence}</dd>
                    <dt class="text-muted-foreground">Kind</dt>
                    <dd class="font-mono">{props.source.kind}</dd>
                    <Show when={props.source.demoSpec}>
                        <dt class="text-muted-foreground">Demo</dt>
                        <dd class="font-mono">{props.source.demoSpec}</dd>
                    </Show>
                    <Show when={props.source.isDefault}>
                        <dt class="text-muted-foreground">Default</dt>
                        <dd>★ default for new chats</dd>
                    </Show>
                    <dt class="text-muted-foreground">ID</dt>
                    <dd class="font-mono truncate" title={props.source.id}>
                        {props.source.id}
                    </dd>
                    <dt class="text-muted-foreground">Created</dt>
                    <dd>{fmt(props.source.createdAt)}</dd>
                    <dt class="text-muted-foreground">Updated</dt>
                    <dd>{fmt(props.source.updatedAt)}</dd>
                </dl>
            </PopoverContent>
        </Popover>
    );
};

const TableItem: Component<{
    name: string;
    active: boolean;
    meta?: string;
    createdAt?: number;
    onSelect(): void;
    onReimport(): void;
    onDrop(): void;
}> = (props) => (
    <li>
        <button
            type="button"
            class={
                'w-full text-left px-3 py-1.5 text-xs border-l-2 transition-colors group ' +
                (props.active
                    ? 'border-primary bg-muted/60 text-foreground'
                    : 'border-transparent hover:bg-muted/40 text-muted-foreground')
            }
            onClick={props.onSelect}
        >
            <div class="flex items-center gap-1 h-fill">
                <span class="font-mono truncate flex-1 min-w-0">{props.name}</span>
                <div class="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 text-[10px]">
                    <span
                        class="hover:text-destructive"
                        onClick={(e) => {
                            e.stopPropagation();
                            props.onDrop();
                        }}
                    >
                        drop
                    </span>
                </div>
            </div>
        </button>
    </li>
);

const ViewItem: Component<{
    name: string;
    active: boolean;
    onSelect(): void;
    onDrop(): void;
}> = (props) => (
    <li>
        <button
            type="button"
            class={
                'w-full text-left px-3 py-1.5 text-xs border-l-2 transition-colors group flex items-center gap-1 ' +
                (props.active
                    ? 'border-primary bg-muted/60 text-foreground'
                    : 'border-transparent hover:bg-muted/40 text-muted-foreground')
            }
            onClick={props.onSelect}
        >
            <Badge variant="outline" class="font-mono text-[9px] px-1 py-0">
                view
            </Badge>
            <span class="font-mono truncate flex-1 min-w-0">{props.name}</span>
            <span
                class="opacity-0 group-hover:opacity-100 text-[10px] hover:text-destructive"
                onClick={(e) => {
                    e.stopPropagation();
                    props.onDrop();
                }}
            >
                drop
            </span>
        </button>
    </li>
);
