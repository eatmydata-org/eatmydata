import * as Comlink from 'comlink';
import { workerVersions } from 'virtual:worker-versions';
import type { WaSqliteDb } from './db';
import type { WaSqliteDbInstanceAccessor } from './accessor';
import type { SqliteDbInitOptions } from './types';
import { runBootCleanup } from '@/lib/sqlite/boot-cleanup';

/**
 * Client-side wa-sqlite proxy. Spawns a fresh DedicatedWorker per tab,
 * Comlink-wraps it, and re-exposes the accessor.
 *
 * Tab-only consumer: the runtime is per-tab now (no SharedWorker), so
 * this module always runs in a window/main-thread context where the
 * `Worker` constructor is available. Multi-tab coordination on the
 * underlying OPFS file happens inside OPFSCoopSyncVFS via Web Locks;
 * no extra cross-context machinery is required.
 */

let worker: Worker | null = null;
let cachedAccessor: Comlink.Remote<WaSqliteDbInstanceAccessor> | null = null;

async function getSqliteAccessor(): Promise<Comlink.Remote<WaSqliteDbInstanceAccessor>> {
    if (cachedAccessor) return cachedAccessor;
    // Dev: suffix the name with a content hash of the worker sources so a
    // rebuild is visible in DevTools and never collides with a lingering
    // generation. The plugin also full-reloads on any worker-source edit,
    // which is what actually retires the old DedicatedWorker — without it a
    // stale worker keeps the OPFS file's Web Lock and the next boot seed
    // fails with `database is locked`. See tools/vite-plugin-worker-version.ts.
    worker = new Worker(new URL('./worker.ts', import.meta.url), {
        type: 'module',
        credentials: 'same-origin',
        name: import.meta.env.DEV
            ? `AnalystSqliteWorker-${workerVersions['wa-sqlite']}`
            : 'AnalystSqliteWorker',
    });
    cachedAccessor = Comlink.wrap<WaSqliteDbInstanceAccessor>(worker);
    // Fire boot cleanup once per page. Gated by a `navigator.locks`
    // try-acquire so only one tab actually does the sweep — see
    // `boot-cleanup.ts` for the rationale.
    try {
        await runBootCleanup(cachedAccessor!);
    } catch (e) {
        console.warn('[sqlite] boot cleanup failed', e);
    }
    return cachedAccessor;
}

/**
 * Caller-side cache of `accessor.get(name)` Remotes.
 *
 * Comlink 4.x's `proxyTransferHandler.serialize` allocates a fresh
 * `MessageChannel` on every wire-serialization of a proxy return, so every
 * `accessor.get(name)` call leaks a port pair when the caller drops the
 * returned Remote without `[Comlink.releaseProxy]()`. Cache here so hot
 * paths (chat, action executor, data-sources resolver) get one channel per
 * name for the life of the worker.
 *
 * Workers stay alive for the page's lifetime; the cache invalidates on
 * `close()` / `destroyOpfs()` / `importDemoIntoOpfs()`.
 */
const dbProxies = new Map<string, Promise<Comlink.Remote<WaSqliteDb>>>();

export async function getSqliteDb(
    name: string = 'default',
    options?: SqliteDbInitOptions,
): Promise<Comlink.Remote<WaSqliteDb>> {
    let p = dbProxies.get(name);
    if (!p) {
        const acc = await getSqliteAccessor();
        p = (acc.get(name, options) as Promise<Comlink.Remote<WaSqliteDb>>).catch((e: unknown) => {
            // Failed get must not poison the cache — drop the entry so the
            // next caller gets a fresh attempt.
            if (dbProxies.get(name) === p) {
                dbProxies.delete(name);
            }
            throw e;
        });
        dbProxies.set(name, p);
    }
    return p;
}

/**
 * Drop the cached db proxy for `name`. Use after closing or destroying the
 * underlying DB so the next `getSqliteDb` rebuilds — without this, a closed
 * source's stale Remote would hand callers handles pointing at a torn-down
 * DB.
 */
export function invalidateSqliteDb(name: string): void {
    dbProxies.delete(name);
}

/**
 * Close the worker-side WaSqliteDb for `name` and drop the caller-side
 * cached proxy in one step.
 */
export async function closeSqliteDb(name: string = 'default'): Promise<boolean> {
    invalidateSqliteDb(name);
    return (await getSqliteAccessor()).close(name);
}

/**
 * Close + unlink the OPFS file for `name`. Drops the caller-side cached
 * proxy too so a subsequent recreate gets a fresh one.
 */
export async function destroySqliteOpfs(name: string, filename: string): Promise<void> {
    invalidateSqliteDb(name);
    await (await getSqliteAccessor()).destroyOpfs(name, filename);
}

/**
 * Drop a pre-built `.sqlite` blob into OPFS at `filename` and (re)open it
 * under `name`. Used by the demo-source factory.
 *
 * Invalidates the caller-side proxy cache BEFORE the round-trip — worker-
 * side `accessor.importIntoOpfs(name, ...)` calls `this.close(name)` and
 * constructs a fresh WaSqliteDb, so any cached Remote here is bound (via
 * its private MessageChannel) to the discarded instance.
 */
export async function importDemoIntoOpfs(
    name: string,
    filename: string,
    bytes: ArrayBuffer,
): Promise<void> {
    invalidateSqliteDb(name);
    await (
        await getSqliteAccessor()
    ).importIntoOpfs(name, filename, Comlink.transfer(bytes, [bytes]));
}

/**
 * Terminate the DedicatedWorker and drop all caches. Worker termination
 * releases its OPFS SyncAccessHandle and Web Locks immediately. Everything is
 * lazy, so the next `getSqliteDb`/`getSqliteAccessor` re-spawns a fresh worker.
 */
function teardownWorker(reason: string): void {
    if (!worker) return;
    try {
        worker.terminate();
    } catch (e) {
        console.warn(`[sqlite] worker terminate failed (${reason})`, e);
    }
    worker = null;
    cachedAccessor = null;
    dbProxies.clear();
}

// Release the OPFS handle + Web Locks promptly when this tab is hidden into
// bfcache, frozen, or torn down. Otherwise a frozen/closing tab keeps the
// file's *exclusive* handle and starves peer tabs (the "database is locked"
// symptom). A frozen tab can't run JS anyway, so dropping its connection is
// safe; on resume the next DB call re-spawns the worker and reopens.
if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', (e: PageTransitionEvent) => {
        // Fires for both bfcache (persisted) and real unload; terminate either
        // way — a discarded tab needs no worker, a bfcached one must not hold
        // locks while frozen.
        teardownWorker(e.persisted ? 'bfcache' : 'unload');
    });
    // Page Lifecycle API: the browser may freeze a backgrounded tab without a
    // pagehide. Release on freeze too.
    document.addEventListener('freeze', () => teardownWorker('freeze'));
}

// Vite HMR: terminate the worker so a fresh module load gets a fresh one.
// Cached Comlink Remotes consumers hold are bound to the OLD module's
// `cachedAccessor`; an HMR-replaced module's exports point at a new
// `cachedAccessor` that has never been initialised. `import.meta.hot.invalidate`
// forces a full reload of consumers, propagating the new accessor.
if (import.meta.hot) {
    import.meta.hot.accept(() => {
        import.meta.hot!.invalidate();
    });
    import.meta.hot.dispose(() => {
        teardownWorker('hmr');
    });
}
