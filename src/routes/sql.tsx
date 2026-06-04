import { createSignal, For, onMount, Show, type Component } from 'solid-js';
import { Button } from '@/registry/ui/button';
import { TopBar } from '@/components/top-bar';
import { PaneHeader, PaneHeaderActions, PaneHeaderTitle } from '@/components/pane-header';
import { DataSourceSelector } from '@/components/data-source-selector';
import { SqlResultGrid } from '@/components/sql-result-grid';
import { getSqliteDb } from '@/lib/sqlite/client';
import { resolveDb } from '@/lib/data-sources/resolver';
import { STORAGE_VERSION } from '@/lib/storage';
import { Resizable, ResizableHandle, ResizablePanel } from '@/registry/ui/resizable';

const HISTORY_KEY = `sql:history:v${STORAGE_VERSION}`;
// Persisted splitter ratios: history sidebar | main, and results | sql input.
const HISTORY_PANE_KEY = `sql:history-pane:v${STORAGE_VERSION}`;
const INPUT_PANE_KEY = `sql:input-pane:v${STORAGE_VERSION}`;
const DEFAULT_HISTORY_SIZE = 0.18;
const DEFAULT_INPUT_SIZE = 0.3;
const HISTORY_LIMIT = 100;
const ROW_LIMIT = 1000;
const DEFAULT_SQL = `SELECT name, type FROM sqlite_master
WHERE type IN ('table', 'view')
ORDER BY type, name;`;

/**
 * Quick-fill snippets shown as pills under the console. Clicking one
 * drops the SQL into the editor (it does not auto-run) so the user can
 * tweak it — e.g. swap 'Products' for their own table name.
 */
const SNIPPETS: ReadonlyArray<{ label: string; sql: string }> = [
    {
        label: 'Tables & views',
        sql: `SELECT name, type FROM sqlite_master
WHERE type IN ('table', 'view')
ORDER BY type, name;`,
    },
    {
        label: 'Show table',
        sql: `PRAGMA table_info('Products');`,
    },
    {
        label: 'Indexes',
        sql: `SELECT name, tbl_name, sql FROM sqlite_master
WHERE type = 'index'
ORDER BY tbl_name, name;`,
    },
    {
        label: 'Foreign keys',
        sql: `PRAGMA foreign_key_list('Products');`,
    },
    {
        label: 'Db size',
        sql: `SELECT page_count * page_size AS size_bytes, page_count, page_size
FROM pragma_page_count(), pragma_page_size();`,
    },
    {
        label: 'Integrity check',
        sql: `PRAGMA integrity_check;`,
    },
    {
        label: 'Compile options',
        sql: `PRAGMA compile_options;`,
    },
    {
        label: 'SQLite ver.',
        sql: `SELECT sqlite_version() AS version;`,
    },
    {
        label: 'VACUUM',
        sql: `VACUUM;`,
    },
];

interface HistoryEntry {
    sql: string;
    ranAt: number;
}

interface RunResult {
    columns: string[];
    rows: Array<Record<string, unknown>>;
    truncated: boolean;
    changes: number;
    elapsedMs: number;
}

function loadHistory(): HistoryEntry[] {
    try {
        const raw = localStorage.getItem(HISTORY_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(
            (x): x is HistoryEntry =>
                !!x &&
                typeof x === 'object' &&
                typeof (x as HistoryEntry).sql === 'string' &&
                typeof (x as HistoryEntry).ranAt === 'number',
        );
    } catch {
        return [];
    }
}

function saveHistory(h: HistoryEntry[]) {
    try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(h));
    } catch {
        // quota or disabled storage
    }
}

function loadPaneSizes(key: string, fallback: number[]): number[] {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return fallback;
        const parsed = JSON.parse(raw);
        if (
            Array.isArray(parsed) &&
            parsed.length === 2 &&
            parsed.every((n) => typeof n === 'number' && n > 0.05 && n < 0.95)
        ) {
            return parsed as number[];
        }
    } catch {
        // localStorage unavailable / parse fail
    }
    return fallback;
}

function savePaneSizes(key: string, sizes: number[]): void {
    try {
        localStorage.setItem(key, JSON.stringify(sizes));
    } catch {
        // quota or disabled storage
    }
}

function previewLine(sql: string): string {
    const trimmed = sql.trim().replace(/\s+/g, ' ');
    return trimmed.length > 80 ? trimmed.slice(0, 77) + '…' : trimmed;
}

const SqlPage: Component = () => {
    const [sql, setSql] = createSignal(DEFAULT_SQL);
    const [result, setResult] = createSignal<RunResult | null>(null);
    const [error, setError] = createSignal<string | null>(null);
    const [running, setRunning] = createSignal(false);
    const [history, setHistory] = createSignal<HistoryEntry[]>([]);
    // SQL text that was last loaded from history; if `sql()` diverges from
    // this, the entry is no longer "selected" — running again creates a new
    // history record rather than refreshing the original.
    const [selectedSnapshot, setSelectedSnapshot] = createSignal<string | null>(null);
    // The data source SQL runs against; undefined falls back to the default DB.
    const [sourceId, setSourceId] = createSignal<string | undefined>(undefined);

    // Splitter ratios. historyPaneSizes = [sidebar, main] (vertical divider);
    // inputPaneSizes = [results, sql input] (horizontal divider).
    const [historyPaneSizes, setHistoryPaneSizes] = createSignal<number[]>(
        loadPaneSizes(HISTORY_PANE_KEY, [DEFAULT_HISTORY_SIZE, 1 - DEFAULT_HISTORY_SIZE]),
    );
    const [inputPaneSizes, setInputPaneSizes] = createSignal<number[]>(
        loadPaneSizes(INPUT_PANE_KEY, [1 - DEFAULT_INPUT_SIZE, DEFAULT_INPUT_SIZE]),
    );
    const handleHistoryPaneSizes = (sizes: number[]) => {
        setHistoryPaneSizes(sizes);
        savePaneSizes(HISTORY_PANE_KEY, sizes);
    };
    const handleInputPaneSizes = (sizes: number[]) => {
        setInputPaneSizes(sizes);
        savePaneSizes(INPUT_PANE_KEY, sizes);
    };

    let textareaRef: HTMLTextAreaElement | undefined;

    onMount(async () => {
        setHistory(loadHistory());
        try {
            const db = await getSqliteDb();
            // Match the chat seed so the debug viewer has data to inspect.
            await db.seed();
        } catch (e) {
            setError(`Database init failed: ${String(e)}`);
        }
    });

    const recordHistory = (text: string) => {
        const trimmed = text.trim();
        if (!trimmed) return;
        const entry: HistoryEntry = { sql: trimmed, ranAt: Date.now() };
        const next = [entry, ...history().filter((h) => h.sql !== trimmed)].slice(0, HISTORY_LIMIT);
        setHistory(next);
        saveHistory(next);
    };

    const run = async () => {
        const text = sql();
        if (!text.trim() || running()) return;
        setRunning(true);
        setError(null);
        const startedAt = performance.now();
        try {
            const db = await resolveDb(sourceId());
            const res = await db.execRaw(text, ROW_LIMIT);
            const elapsedMs = performance.now() - startedAt;
            setResult({
                columns: res.columns,
                rows: res.rows,
                truncated: res.truncated,
                changes: res.changes,
                elapsedMs,
            });
            recordHistory(text);
            setSelectedSnapshot(text.trim());
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setResult(null);
        } finally {
            setRunning(false);
        }
    };

    const onKeyDown = (e: KeyboardEvent) => {
        // Cmd/Ctrl+Enter to execute.
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            void run();
        }
    };

    const loadFromHistory = (entry: HistoryEntry) => {
        setSql(entry.sql);
        setSelectedSnapshot(entry.sql);
        textareaRef?.focus();
    };

    const applySnippet = (snippet: string) => {
        setSql(snippet);
        // A snippet is a fresh draft, not a replayed history entry.
        setSelectedSnapshot(null);
        textareaRef?.focus();
    };

    const clearHistory = () => {
        setHistory([]);
        saveHistory([]);
        setSelectedSnapshot(null);
    };

    const isModified = () => {
        const snap = selectedSnapshot();
        return snap !== null && snap !== sql().trim();
    };

    return (
        <div class="h-svh flex flex-col bg-background text-foreground">
            <TopBar />

            <PaneHeader>
                <PaneHeaderTitle>SQL</PaneHeaderTitle>
                <PaneHeaderActions class="gap-2">
                    <span class="text-xs text-muted-foreground">Data source</span>
                    <DataSourceSelector value={sourceId()} onChange={setSourceId} autoPickDefault />
                </PaneHeaderActions>
            </PaneHeader>

            <div class="flex-1 min-h-0">
                <Resizable
                    orientation="horizontal"
                    sizes={historyPaneSizes()}
                    onSizesChange={handleHistoryPaneSizes}
                    class="h-full"
                >
                    <ResizablePanel
                        initialSize={DEFAULT_HISTORY_SIZE}
                        minSize={0.1}
                        class="overflow-hidden min-w-0"
                    >
                        <aside class="h-full flex flex-col bg-card/30">
                            <div class="px-3 py-2 flex items-center justify-between border-b">
                                <span class="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                    History
                                </span>
                                <Show when={history().length > 0}>
                                    <button
                                        type="button"
                                        class="text-xs text-muted-foreground hover:text-foreground"
                                        onClick={clearHistory}
                                    >
                                        Clear
                                    </button>
                                </Show>
                            </div>
                            <div class="flex-1 overflow-y-auto">
                                <Show
                                    when={history().length > 0}
                                    fallback={
                                        <p class="text-xs text-muted-foreground italic px-3 py-3">
                                            No queries yet.
                                        </p>
                                    }
                                >
                                    <ul class="py-1">
                                        <For each={history()}>
                                            {(entry) => {
                                                const selected = () =>
                                                    selectedSnapshot() === entry.sql;
                                                return (
                                                    <li>
                                                        <button
                                                            type="button"
                                                            class="w-full text-left px-3 py-2 text-xs font-mono hover:bg-muted/60 transition-colors border-l-2 border-transparent data-[selected=true]:bg-muted data-[selected=true]:border-primary"
                                                            data-selected={selected()}
                                                            title={entry.sql}
                                                            onClick={() => loadFromHistory(entry)}
                                                        >
                                                            <div class="truncate">
                                                                {previewLine(entry.sql)}
                                                            </div>
                                                            <div class="text-[10px] text-muted-foreground font-sans mt-0.5">
                                                                {new Date(
                                                                    entry.ranAt,
                                                                ).toLocaleTimeString()}
                                                            </div>
                                                        </button>
                                                    </li>
                                                );
                                            }}
                                        </For>
                                    </ul>
                                </Show>
                            </div>
                        </aside>
                    </ResizablePanel>
                    <ResizableHandle withHandle />
                    <ResizablePanel
                        initialSize={1 - DEFAULT_HISTORY_SIZE}
                        minSize={0.4}
                        class="overflow-hidden min-w-0"
                    >
                        <main class="h-full min-w-0 flex flex-col">
                            <Resizable
                                orientation="vertical"
                                sizes={inputPaneSizes()}
                                onSizesChange={handleInputPaneSizes}
                                class="h-full"
                            >
                                <ResizablePanel
                                    initialSize={1 - DEFAULT_INPUT_SIZE}
                                    minSize={0.2}
                                    class="overflow-hidden min-h-0"
                                >
                                    <section class="h-full min-h-0 flex flex-col p-4 gap-2 overflow-hidden">
                                        <Show when={error()}>
                                            <div class="rounded-md border border-destructive/50 bg-destructive/10 text-destructive px-3 py-2 text-sm font-mono whitespace-pre-wrap">
                                                {error()}
                                            </div>
                                        </Show>
                                        <Show when={!error() && result()}>
                                            {(r) => (
                                                <>
                                                    <div class="shrink-0 text-xs text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
                                                        <span>
                                                            {r().rows.length}{' '}
                                                            {r().rows.length === 1 ? 'row' : 'rows'}
                                                            {r().truncated
                                                                ? ` (truncated at ${ROW_LIMIT})`
                                                                : ''}
                                                        </span>
                                                        <Show
                                                            when={
                                                                r().columns.length === 0 &&
                                                                r().changes > 0
                                                            }
                                                        >
                                                            <span>{r().changes} change(s)</span>
                                                        </Show>
                                                        <span>{r().elapsedMs.toFixed(1)} ms</span>
                                                    </div>
                                                    <Show
                                                        when={r().columns.length > 0}
                                                        fallback={
                                                            <p class="text-sm text-muted-foreground italic">
                                                                Statement executed. No rows
                                                                returned.
                                                            </p>
                                                        }
                                                    >
                                                        <div class="flex-1 min-h-0 flex flex-col overflow-hidden">
                                                            <SqlResultGrid
                                                                columns={r().columns}
                                                                rows={r().rows}
                                                            />
                                                        </div>
                                                    </Show>
                                                </>
                                            )}
                                        </Show>
                                        <Show when={!error() && !result()}>
                                            <p class="text-sm text-muted-foreground italic">
                                                Enter SQL below and press ⌘/Ctrl+Enter to run.
                                            </p>
                                        </Show>
                                    </section>
                                </ResizablePanel>
                                <ResizableHandle withHandle />
                                <ResizablePanel
                                    initialSize={DEFAULT_INPUT_SIZE}
                                    minSize={0.15}
                                    class="overflow-hidden min-h-0"
                                >
                                    <section class="h-full min-h-0 flex flex-col border-t bg-card/30">
                                        <div class="relative flex-1 min-h-0">
                                            <textarea
                                                ref={textareaRef}
                                                class="block w-full h-full rounded-md bg-background px-3 py-2 pb-12 font-mono text-sm resize-none focus:outline-none focus:shadow-none"
                                                spellcheck={false}
                                                value={sql()}
                                                onInput={(e) => setSql(e.currentTarget.value)}
                                                onKeyDown={onKeyDown}
                                            />

                                            <div class="absolute top-1 right-1 flex gap-2 backdrop-blur-sm rounded-full">
                                                <div class="px-4 py-1 flex items-center gap-3 text-xs text-muted-foreground">
                                                    <Show when={isModified()}>
                                                        <span class="text-amber-600 dark:text-amber-400">
                                                            modified - will be saved as new query
                                                        </span>
                                                    </Show>
                                                    <span class="ml-auto">⌘/Ctrl+Enter to run</span>
                                                </div>
                                            </div>
                                            <div class="absolute bottom-1 left-0 right-0 flex gap-2 px-2">
                                                <div class="flex-1 flex items-center flex-wrap gap-1 mb-1 max-h-13 overflow-hidden">
                                                    <For each={SNIPPETS}>
                                                        {(s) => (
                                                            <button
                                                                type="button"
                                                                class="rounded-full border border-border backdrop-blur-sm px-2.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground transition-colors text-nowrap"
                                                                title={s.sql}
                                                                onClick={() => applySnippet(s.sql)}
                                                            >
                                                                {s.label}
                                                            </button>
                                                        )}
                                                    </For>
                                                </div>
                                                <div>
                                                    <Button
                                                        size="sm"
                                                        variant="ghost"
                                                        onClick={() => {
                                                            setSql('');
                                                            setSelectedSnapshot(null);
                                                            textareaRef?.focus();
                                                        }}
                                                    >
                                                        Clear
                                                    </Button>
                                                    <Button
                                                        size="sm"
                                                        onClick={() => void run()}
                                                        disabled={running() || !sql().trim()}
                                                    >
                                                        {running() ? 'Running…' : 'Run'}
                                                    </Button>
                                                </div>
                                            </div>
                                        </div>
                                    </section>
                                </ResizablePanel>
                            </Resizable>
                        </main>
                    </ResizablePanel>
                </Resizable>
            </div>
        </div>
    );
};

export default SqlPage;
