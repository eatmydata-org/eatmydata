import {
    ErrorBoundary,
    Show,
    createResource,
    createSignal,
    onCleanup,
    onMount,
    type Component,
    createMemo,
} from 'solid-js';
import { Button } from '@/registry/ui/button';
import { TopBar } from '@/components/top-bar';
import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogDescription,
} from '@/registry/ui/dialog';
import { SourcesListPanel } from '@/components/data-sources/list-panel';
import { SourceDetail } from '@/components/data-sources/source-detail';
import { ImportDialog } from '@/components/data-sources/import-dialog';
import { ViewEditor } from '@/components/data-sources/view-editor';
import { DemoDialog } from '@/components/data-sources/demo-dialog';
import { ConfirmDialog } from '@/components/data-sources/confirm-dialog';
import { listSources, deleteSource, setDefaultSource } from '@/lib/data-sources/store';
import type { DataSource } from '@/lib/data-sources/types';
import { closeSqliteDb, destroySqliteOpfs } from '@/lib/sqlite/client';
import { getSourceDb } from '@/lib/data-sources/db';
import {
    createSourceFromFile,
    type CreateFromFileResult,
} from '@/lib/data-sources/create-from-file';
import { clearAllData } from '@/lib/clear-all-data';
import { useSettings } from '@/lib/runtime/client';
import type { TableSchema } from '@/lib/wa-sqlite/types';
import { Resizable, ResizableHandle, ResizablePanel } from '@/registry/ui/resizable';

const PANEL_SIZES_KEY = 'analyst:data-sources:panel-sizes';
const DEFAULT_LIST_SIZE = 0.22;

function loadPanelSizes(): number[] {
    try {
        const raw = localStorage.getItem(PANEL_SIZES_KEY);
        if (!raw) return [DEFAULT_LIST_SIZE, 1 - DEFAULT_LIST_SIZE];
        const parsed = JSON.parse(raw);
        if (
            Array.isArray(parsed) &&
            parsed.length === 2 &&
            parsed.every((n) => typeof n === 'number' && n > 0.05 && n < 0.95)
        ) {
            return parsed as number[];
        }
    } catch {
        /* localStorage may be unavailable / parse fail */
    }
    return [DEFAULT_LIST_SIZE, 1 - DEFAULT_LIST_SIZE];
}

function savePanelSizes(sizes: number[]): void {
    try {
        localStorage.setItem(PANEL_SIZES_KEY, JSON.stringify(sizes));
    } catch {
        // quota or permissions error
    }
}

// Tear down a source that imported zero tables so no empty zombie entry is
// left behind. Best-effort: a failed cleanup is logged, not surfaced (the
// user already gets a failure notice for the import itself).
async function cleanupEmptySource(source: CreateFromFileResult['source']): Promise<void> {
    try {
        if (source.persistence === 'memory') {
            await closeSqliteDb(source.dbFile);
        } else {
            await destroySqliteOpfs(source.dbFile, source.dbFile);
        }
        await deleteSource(source.id);
    } catch (cleanupErr) {
        console.warn('[data-sources] orphan source cleanup failed', cleanupErr);
    }
}

// Build the user-facing notices for one import result (rename + per-table
// failures + the empty-source removal). Pure: collects messages, decides
// whether the source survived.
function collectImportNotices(res: CreateFromFileResult): {
    notices: string[];
    succeeded: boolean;
} {
    const notices: string[] = [];
    if (res.renamed) {
        notices.push(`"${res.requestedName}" already exists — imported as "${res.finalName}".`);
    }
    for (const o of res.outcomes) {
        if (o.status === 'failed') {
            notices.push(
                `Failed to import "${o.tableName}" into "${res.finalName}": ${o.error ?? 'unknown error'}`,
            );
        }
    }
    const succeeded = res.outcomes.some(
        (o) => o.status === 'imported' || o.status === 'overwritten',
    );
    if (!succeeded) {
        notices.push(`No tables were imported into "${res.finalName}" — source removed.`);
    }
    return { notices, succeeded };
}

// The selected source's detail pane, wrapped in a last-resort ErrorBoundary.
// Extracted from the page body so the boundary's fallback `onClick` doesn't
// sit five JSX-callback levels deep. The keyed `<Show>` at the call site
// remounts this (and resets the boundary) on source switch.
const SelectedSourceBoundary: Component<{
    source: DataSource;
    schemaTick: number;
    onImport: (pinned?: string) => void;
    onCreateView: () => void;
    onSourceUpdated: () => void;
    onRequestDelete: () => void;
}> = (props) => (
    <ErrorBoundary
        fallback={(err) => (
            <main class="h-full flex flex-col items-center justify-center gap-3 text-center p-6">
                <div class="text-destructive text-3xl leading-none">⚠</div>
                <p class="text-sm font-semibold">
                    Something went wrong opening "{props.source.name}"
                </p>
                <p class="text-xs text-muted-foreground max-w-md whitespace-pre-wrap">
                    {err instanceof Error ? err.message : String(err)}
                </p>
                <Button size="sm" variant="destructive" onClick={() => props.onRequestDelete()}>
                    Delete data source
                </Button>
            </main>
        )}
    >
        <SourceDetail
            source={props.source}
            schemaRefreshTick={props.schemaTick}
            onImport={(pinned) => props.onImport(pinned)}
            onCreateView={() => props.onCreateView()}
            onSourceUpdated={() => props.onSourceUpdated()}
            onRequestDeleteSource={() => props.onRequestDelete()}
        />
    </ErrorBoundary>
);

const DataSourcesPage: Component = () => {
    const [refreshTick, setRefreshTick] = createSignal(0);
    const [schemaTick, setSchemaTick] = createSignal(0);
    const [selectedId, setSelectedId] = createSignal<string | undefined>(undefined);
    const [panelSizes, setPanelSizes] = createSignal<number[]>(loadPanelSizes());
    const handleSizesChange = (sizes: number[]) => {
        setPanelSizes(sizes);
        savePanelSizes(sizes);
    };
    const [pendingFiles, setPendingFiles] = createSignal<File[]>([]);
    const [importOpen, setImportOpen] = createSignal(false);
    const [importPinned, setImportPinned] = createSignal<string | undefined>(undefined);
    const [viewOpen, setViewOpen] = createSignal(false);
    const [demoOpen, setDemoOpen] = createSignal(false);
    const [renameNotice, setRenameNotice] = createSignal<string | null>(null);
    let importFileInputRef: HTMLInputElement | undefined;

    const settings = useSettings;

    const [sources] = createResource(refreshTick, listSources);

    const selected = (): DataSource | undefined => {
        const id = selectedId();
        if (!id) return undefined;
        return (sources() ?? []).find((s) => s.id === id);
    };

    // Auto-select the default source on first load (or the first one).
    createMemo(() => {
        const list = sources();
        if (!list || list.length === 0) {
            setSelectedId(undefined);
            return;
        }
        if (!selectedId() || !list.find((s) => s.id === selectedId())) {
            const def = list.find((s) => s.isDefault) ?? list[0];
            setSelectedId(def?.id);
        }
    });

    const existingNames = createResource(
        () => `${selected()?.id ?? ''}:${schemaTick()}`,
        async () => {
            const s = selected();
            if (!s) return [] as string[];
            try {
                const db = await getSourceDb(s);
                const schema = (await db.getSchema()) as TableSchema[];
                return schema.map((t) => t.name).filter((n) => n !== '__rh_meta_tables');
            } catch (e) {
                // A corrupt/unreadable source has no table names to offer the
                // import/view dialogs. Don't let it throw out of the resource
                // (which would crash the route on read) — degrade to empty.
                console.warn('[data-sources] schema read failed', e);
                return [] as string[];
            }
        },
    );

    const refreshAll = () => {
        setRefreshTick((t) => t + 1);
        setSchemaTick((t) => t + 1);
    };

    // Page-level drag-and-drop overlay: dropping files anywhere on the
    // page opens the import dialog scoped to the current source.
    const [dragHover, setDragHover] = createSignal(false);
    onMount(() => {
        let depth = 0;
        const onEnter = (e: DragEvent) => {
            if (!e.dataTransfer?.types.includes('Files')) return;
            depth++;
            setDragHover(true);
        };
        const onLeave = () => {
            depth = Math.max(0, depth - 1);
            if (depth === 0) setDragHover(false);
        };
        const onDrop = (e: DragEvent) => {
            e.preventDefault();
            depth = 0;
            setDragHover(false);
            const files = e.dataTransfer ? Array.from(e.dataTransfer.files) : [];
            if (files.length === 0) return;
            // Drop without a selected source: treat the drop as a
            // multi-file "+ Import file…" — each file lands as a new
            // data source. Matches what the sidebar button does and
            // avoids a dead-end "pick a source first" prompt.
            if (!selected()) {
                void importPickedFiles(files);
                return;
            }
            setPendingFiles(files);
            setImportPinned(undefined);
            setImportOpen(true);
        };
        const onOver = (e: DragEvent) => {
            if (e.dataTransfer?.types.includes('Files')) {
                e.preventDefault();
            }
        };
        window.addEventListener('dragenter', onEnter);
        window.addEventListener('dragleave', onLeave);
        window.addEventListener('dragover', onOver);
        window.addEventListener('drop', onDrop);
        onCleanup(() => {
            window.removeEventListener('dragenter', onEnter);
            window.removeEventListener('dragleave', onLeave);
            window.removeEventListener('dragover', onOver);
            window.removeEventListener('drop', onDrop);
        });
    });

    // Sidebar "+ Import file…" → file picker. Each picked file becomes a
    // new data source with name = file basename. Display-name collisions
    // are auto-suffixed with "(1)", "(2)", … and the user is told about
    // each renamed source.
    const onCreateImported = () => {
        importFileInputRef?.click();
    };

    const importPickedFiles = async (files: File[]) => {
        if (files.length === 0) return;
        const persistence = settings().defaultDataSourcePersistence ?? 'temp';
        const notices: string[] = [];
        let lastId: string | undefined;
        for (const file of files) {
            try {
                const res = await createSourceFromFile(file, persistence);
                const { notices: fileNotices, succeeded } = collectImportNotices(res);
                notices.push(...fileNotices);
                if (succeeded) {
                    lastId = res.source.id;
                } else {
                    // Don't leave an empty zombie source behind.
                    await cleanupEmptySource(res.source);
                }
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                notices.push(`Failed to import "${file.name}": ${msg}`);
            }
        }
        refreshAll();
        if (lastId) setSelectedId(lastId);
        if (notices.length > 0) {
            setRenameNotice(notices.join('\n'));
        }
    };

    const onImportFileInput = (e: Event) => {
        const input = e.currentTarget as HTMLInputElement;
        const files = input.files ? Array.from(input.files) : [];
        input.value = '';
        void importPickedFiles(files);
    };

    const handleDemoCreated = (src: DataSource) => {
        refreshAll();
        setSelectedId(src.id);
    };

    const handleSetDefault = async (id: string) => {
        const cur = selected();
        const target = cur?.id === id ? null : id;
        await setDefaultSource(target);
        refreshAll();
    };

    // Source-delete uses a styled confirm dialog. The pending id sits
    // in `pendingDeleteId`; the dialog reads the source from
    // `sources()` to render the name. Errors land in `deleteError` so
    // the user sees them — previously a thrown unlink rejected silently
    // because there was no error surface.
    const [pendingDeleteId, setPendingDeleteId] = createSignal<string | null>(null);
    const [deleteError, setDeleteError] = createSignal<string | null>(null);
    const [deleting, setDeleting] = createSignal(false);

    const pendingDeleteSource = (): DataSource | undefined => {
        const id = pendingDeleteId();
        if (!id) return undefined;
        return (sources() ?? []).find((s) => s.id === id);
    };

    const runDelete = async () => {
        const src = pendingDeleteSource();
        if (!src || deleting()) return;
        setDeleting(true);
        setDeleteError(null);
        try {
            if (src.persistence === 'memory') {
                await closeSqliteDb(src.dbFile);
            } else {
                await destroySqliteOpfs(src.dbFile, src.dbFile);
            }
            await deleteSource(src.id);
            // Close the dialog FIRST, then refresh + reset selection.
            // Otherwise the dialog momentarily shows with a stale source
            // until the next tick.
            setPendingDeleteId(null);
            if (selectedId() === src.id) setSelectedId(undefined);
            refreshAll();
        } catch (e) {
            setDeleteError(e instanceof Error ? e.message : String(e));
        } finally {
            setDeleting(false);
        }
    };

    const handleOpenImport = (pinned?: string) => {
        setImportPinned(pinned);
        setPendingFiles([]);
        setImportOpen(true);
    };

    // Dev-only nuke: closes every source, unlinks every OPFS db file, drops
    // every IDB row (data sources + actions + executions + versions).
    // Useful when iterating on schema / persistence layout.
    const [confirmNukeOpen, setConfirmNukeOpen] = createSignal(false);
    const [nuking, setNuking] = createSignal(false);
    const [nukeError, setNukeError] = createSignal<string | null>(null);
    const runDeleteEverything = async () => {
        if (nuking()) return;
        setNuking(true);
        setNukeError(null);
        try {
            await clearAllData();
            setSelectedId(undefined);
            setConfirmNukeOpen(false);
            refreshAll();
        } catch (e) {
            setNukeError(e instanceof Error ? e.message : String(e));
        } finally {
            setNuking(false);
        }
    };

    return (
        <div class="h-svh flex flex-col bg-background text-foreground relative">
            <TopBar />

            <div class="flex-1 min-h-0">
                <Resizable
                    orientation="horizontal"
                    sizes={panelSizes()}
                    onSizesChange={handleSizesChange}
                    class="h-full"
                >
                    <ResizablePanel
                        initialSize={DEFAULT_LIST_SIZE}
                        minSize={0.12}
                        class="overflow-hidden min-w-0"
                    >
                        <SourcesListPanel
                            sources={sources() ?? []}
                            selectedId={selectedId()}
                            onSelect={setSelectedId}
                            onCreateImported={onCreateImported}
                            onCreateDemo={() => setDemoOpen(true)}
                            onSetDefault={(id) => void handleSetDefault(id)}
                            onDeleteEverything={
                                import.meta.env.DEV
                                    ? () => {
                                          setNukeError(null);
                                          setConfirmNukeOpen(true);
                                      }
                                    : undefined
                            }
                        />
                    </ResizablePanel>
                    <ResizableHandle withHandle />
                    <ResizablePanel
                        initialSize={1 - DEFAULT_LIST_SIZE}
                        minSize={0.4}
                        class="overflow-hidden min-w-0"
                    >
                        <Show
                            when={selected()}
                            fallback={
                                <main class="h-full flex items-center justify-center text-sm text-muted-foreground italic">
                                    Select or create a data source.
                                </main>
                            }
                        >
                            {(s) => (
                                // Key the boundary on the *id string* (not the
                                // source object): switching to a different source
                                // remounts and resets the ErrorBoundary, but a
                                // refreshAll() — which mints new DataSource
                                // objects from IDB — does NOT, so table selection
                                // survives an import. SourceDetail already renders
                                // its own inline error for an unreadable db; this
                                // boundary is a last-resort net so an unexpected
                                // throw can't take the whole sources list down.
                                <Show when={selectedId()} keyed>
                                    <SelectedSourceBoundary
                                        source={s()}
                                        schemaTick={schemaTick()}
                                        onImport={(pinned) => handleOpenImport(pinned)}
                                        onCreateView={() => setViewOpen(true)}
                                        onSourceUpdated={() => refreshAll()}
                                        onRequestDelete={() => {
                                            setDeleteError(null);
                                            setPendingDeleteId(s().id);
                                        }}
                                    />
                                </Show>
                            )}
                        </Show>
                    </ResizablePanel>
                </Resizable>
            </div>
            <Show when={dragHover()}>
                <div class="pointer-events-none absolute inset-0 bg-primary/10 ring-2 ring-primary ring-inset flex items-center justify-center text-sm font-semibold text-primary">
                    Drop files to import into "{selected()?.name ?? '(pick a source first)'}"
                </div>
            </Show>
            <Show when={selected() && importOpen()}>
                <ImportDialog
                    open={importOpen()}
                    onOpenChange={setImportOpen}
                    source={selected()!}
                    existingTableNames={existingNames[0]() ?? []}
                    pendingFiles={pendingFiles()}
                    pinnedTable={importPinned()}
                    onCommitted={() => {
                        refreshAll();
                    }}
                />
            </Show>
            <Show when={selected() && viewOpen()}>
                <ViewEditor
                    open={viewOpen()}
                    onOpenChange={setViewOpen}
                    source={selected()!}
                    existingNames={existingNames[0]() ?? []}
                    onCreated={() => refreshAll()}
                />
            </Show>
            <DemoDialog
                open={demoOpen()}
                onOpenChange={setDemoOpen}
                onCreated={handleDemoCreated}
            />
            <input
                ref={importFileInputRef}
                type="file"
                multiple
                accept=".csv,.tsv,.xlsx,.xls"
                class="hidden"
                onChange={onImportFileInput}
            />
            <Show when={renameNotice()}>
                <RenameNotice message={renameNotice()!} onClose={() => setRenameNotice(null)} />
            </Show>
            <ConfirmDialog
                open={pendingDeleteId() !== null}
                onOpenChange={(o) => {
                    if (!o) {
                        setPendingDeleteId(null);
                        setDeleteError(null);
                    }
                }}
                title={`Delete data source "${pendingDeleteSource()?.name ?? ''}"?`}
                description="All tables, views, and imported data will be lost. This cannot be undone."
                body={
                    <Show when={deleteError()}>
                        <div class="rounded-md border border-destructive/50 bg-destructive/10 text-destructive px-3 py-2 mt-2 whitespace-pre-wrap font-mono">
                            {deleteError()}
                        </div>
                    </Show>
                }
                confirmLabel={deleting() ? 'Deleting…' : 'Delete data source'}
                closeOnConfirm={false}
                onConfirm={runDelete}
            />
            <ConfirmDialog
                open={confirmNukeOpen()}
                onOpenChange={(o) => {
                    if (!o) {
                        setConfirmNukeOpen(false);
                        setNukeError(null);
                    }
                }}
                title="Delete everything?"
                description="Wipes every data source (and its OPFS file), every action, every execution, and every action version. Dev-only — there is no undo."
                body={
                    <Show when={nukeError()}>
                        <div class="rounded-md border border-destructive/50 bg-destructive/10 text-destructive px-3 py-2 mt-2 whitespace-pre-wrap font-mono">
                            {nukeError()}
                        </div>
                    </Show>
                }
                confirmLabel={nuking() ? 'Wiping…' : 'Delete everything'}
                closeOnConfirm={false}
                onConfirm={runDeleteEverything}
            />
        </div>
    );
};

const RenameNotice: Component<{
    message: string;
    onClose(): void;
}> = (props) => (
    <Dialog open onOpenChange={(o) => !o && props.onClose()}>
        <DialogContent>
            <DialogHeader>
                <DialogTitle>Import results</DialogTitle>
                <DialogDescription>
                    One or more imports produced warnings or errors.
                </DialogDescription>
            </DialogHeader>
            <pre class="text-xs whitespace-pre-wrap bg-muted/40 rounded-md px-3 py-2 font-mono">
                {props.message}
            </pre>
            <DialogFooter>
                <Button onClick={props.onClose}>OK</Button>
            </DialogFooter>
        </DialogContent>
    </Dialog>
);

export default DataSourcesPage;
