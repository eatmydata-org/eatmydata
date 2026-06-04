import { createSignal, Show, type Component, type JSX } from 'solid-js';
import * as Comlink from 'comlink';
import { Button } from '@/registry/ui/button';
import { TopBar } from '@/components/top-bar';
import type {
    ProbeApi,
    Demo1Result,
    Demo2WriteResult,
    Demo2ReadResult,
    Demo3Result,
    Demo4Result,
    Demo5Result,
} from '@/lib/wa-sqlite-probe/worker';
import { randomToken } from '@/lib/random';

/**
 * wa-sqlite + OPFSCoopSyncVFS manual debugging surface.
 *
 * Spawns a DedicatedWorker (one per tab) and exposes five demos covering
 * the load-bearing scenarios: basic open/insert/select, multi-tab
 * concurrent writes, `sqlite3_deserialize` round-trip, write-heavy load
 * under DELETE journal, and JS-heap baseline.
 */

type WorkerProxy = Comlink.Remote<ProbeApi>;

function newWorker(): WorkerProxy {
    const w = new Worker(new URL('@/lib/wa-sqlite-probe/worker.ts', import.meta.url), {
        type: 'module',
        name: 'wa-sqlite-probe',
    });
    return Comlink.wrap<ProbeApi>(w);
}

const TAB_TAG = `tab-${randomToken(3)}`;

const WaSqlitePage: Component = () => {
    const probe = newWorker();

    return (
        <main class="h-svh flex flex-col bg-background text-foreground">
            <TopBar />

            <div class="flex-1 min-h-0 p-6 max-w-4xl overflow-auto flex flex-col gap-6">
                <header class="flex items-baseline gap-3 flex-wrap">
                    <h1 class="text-lg font-semibold">wa-sqlite + OPFSCoopSyncVFS debug surface</h1>
                    <span class="text-xs font-mono text-muted-foreground">
                        this tab id: {TAB_TAG}
                    </span>
                </header>
                <p class="text-sm text-muted-foreground">
                    Each tab spawns its own DedicatedWorker (one wa-sqlite instance per tab).
                    Workers share the same OPFS file via{' '}
                    <code class="font-mono">readwrite-unsafe</code>; the VFS coordinates writes
                    through Web Locks. Use the demos below to reproduce engine-level issues without
                    app state in the way.
                </p>

                <DemoSection
                    title="1. Basic open / insert / select"
                    description="Open the OPFS-backed DB, create a table, insert 5 rows, SELECT them back."
                >
                    <RunButton
                        label="Run demo 1"
                        run={() => probe.demo1()}
                        format={(r: Demo1Result) =>
                            `rowCount=${r.rowCount}, elapsed=${r.elapsedMs}ms\nfirst 5 rows: ${JSON.stringify(r.firstFive)}`
                        }
                    />
                </DemoSection>

                <DemoSection
                    title="2. Multi-tab concurrent writes"
                    description={
                        <>
                            <p>
                                Open this page in <b>two tabs</b>. In Tab A click "Writer". In Tab B
                                click "Writer". Each writer tags its rows with that tab's id (
                                {TAB_TAG}). Then click "Read all" in either tab — you should see
                                both tab tags with their respective counts.
                            </p>
                            <p class="mt-1">
                                Watch <code class="font-mono">busyRetries</code> — it should stay 0.
                                Non-zero means OPFSCoopSyncVFS surfaced SQLITE_BUSY instead of
                                queueing via Web Lock; worth a closer look.
                            </p>
                        </>
                    }
                >
                    <RunButton
                        label="Writer (200 rows tagged this tab)"
                        run={() => probe.demo2_write(TAB_TAG, 200)}
                        format={(r: Demo2WriteResult) =>
                            `wrote ${r.written} rows tagged "${r.tag}" in ${r.elapsedMs}ms, busyRetries=${r.busyRetries}`
                        }
                    />
                    <RunButton
                        label="Read all (group by tag)"
                        run={() => probe.demo2_read()}
                        format={(r: Demo2ReadResult) =>
                            `total=${r.totalRows} rows in ${r.elapsedMs}ms\nbyTag=${JSON.stringify(r.byTag, null, 2)}`
                        }
                    />
                </DemoSection>

                <DemoSection
                    title="3. sqlite3_deserialize accessibility"
                    description="Not exposed by wa-sqlite's JS wrapper. Try to reach it via module._sqlite3_deserialize + module.cwrap. If callResult is 5, the round-trip serialize→deserialize→query worked."
                >
                    <RunButton
                        label="Run demo 3"
                        run={() => probe.demo3()}
                        format={(r: Demo3Result) =>
                            `rawExportPresent=${r.rawExportPresent}, cwrappable=${r.cwrappable}\n` +
                            `callResult=${r.callResult ?? 'null'}` +
                            (r.error ? `\nerror: ${r.error}` : '')
                        }
                    />
                </DemoSection>

                <DemoSection
                    title="4. Write-heavy load under DELETE journal"
                    description="Bulk-insert 1000 rows in a single transaction. Surfaces effective journal_mode so we know we're not on WAL silently."
                >
                    <RunButton
                        label="Insert 1000 rows"
                        run={() => probe.demo4(1000)}
                        format={(r: Demo4Result) =>
                            `inserted=${r.inserted}, journalMode=${r.journalMode}\n` +
                            `elapsed=${r.elapsedMs}ms (${r.rowsPerSecond} rows/s)`
                        }
                    />
                </DemoSection>

                <DemoSection
                    title="5. Memory baseline"
                    description="Chromium-only via performance.memory; null elsewhere. Compare across 1 → N tabs to estimate per-tab footprint."
                >
                    <RunButton
                        label="Read JS heap usage"
                        run={() => probe.demo5()}
                        format={(r: Demo5Result) =>
                            r.usedJSHeapBytes !== null
                                ? `usedJSHeapBytes=${r.usedJSHeapBytes.toLocaleString()} (~${Math.round(r.usedJSHeapBytes / 1024 / 1024)} MB)\n${r.note}`
                                : r.note
                        }
                    />
                </DemoSection>

                <DemoSection
                    title="Reset"
                    description="Drop probe + load_test tables so demos start fresh. Doesn't touch the multi_tab table — to clear that, run /sah-shared's wipe or use DevTools."
                >
                    <RunButton
                        label="Reset"
                        run={() => probe.reset()}
                        format={() => 'reset done'}
                    />
                </DemoSection>
            </div>
        </main>
    );
};

const DemoSection: Component<{
    title: string;
    description: JSX.Element;
    children: JSX.Element;
}> = (props) => (
    <section class="border rounded p-4 flex flex-col gap-3">
        <div>
            <h2 class="text-sm font-semibold">{props.title}</h2>
            <div class="text-xs text-muted-foreground mt-1">{props.description}</div>
        </div>
        <div class="flex flex-wrap gap-2">{props.children}</div>
    </section>
);

const RunButton: <T>(props: {
    label: string;
    run: () => Promise<T>;
    format: (r: T) => string;
}) => JSX.Element = (props) => {
    const [busy, setBusy] = createSignal(false);
    const [out, setOut] = createSignal<string | null>(null);
    const [err, setErr] = createSignal<string | null>(null);
    const click = async () => {
        setBusy(true);
        setOut(null);
        setErr(null);
        try {
            const r = await props.run();
            setOut(props.format(r));
        } catch (e) {
            setErr(`${(e as Error).name || 'Error'}: ${(e as Error).message}`);
        } finally {
            setBusy(false);
        }
    };
    return (
        <div class="flex flex-col gap-1 min-w-[260px]">
            <Button onClick={click} disabled={busy()} size="sm">
                {busy() ? 'Running…' : props.label}
            </Button>
            <Show when={out()}>
                {(text) => (
                    <pre class="text-xs font-mono bg-emerald-50 border border-emerald-200 rounded p-2 whitespace-pre-wrap">
                        {text()}
                    </pre>
                )}
            </Show>
            <Show when={err()}>
                {(text) => (
                    <pre class="text-xs font-mono bg-red-50 border border-red-200 rounded p-2 whitespace-pre-wrap">
                        {text()}
                    </pre>
                )}
            </Show>
        </div>
    );
};

export default WaSqlitePage;
