/**
 * Boot cleanup — runs once across all open tabs, gated by an `ifAvailable`
 * Web Lock so exactly one tab does the sweep:
 *
 *   1. **Abandoned temp sources**: IDB `DataSource` rows with
 *      `persistence: 'temp'` whose sessionId doesn't match the freshly-
 *      booted worker's id are from a prior process. Unlink the OPFS file
 *      and drop the IDB row.
 *   2. **OPFS orphan reconciliation**: OPFS files with no matching IDB
 *      DataSource row are dead weight (stale from earlier sessions, or
 *      from a delete that lost its OPFS unlink). Unlink so OPFS doesn't
 *      grow unbounded across sessions.
 *
 * Every tab spawns its own sqlite worker, so every tab boots; without the
 * lock, every tab would run cleanup concurrently. The try-acquire keeps it
 * idempotent — one tab does the work, others move on.
 */

import type * as Comlink from 'comlink';
import { listAbandonedTempSources, listSources, deleteSource } from '@/lib/data-sources/store';
import type { WaSqliteDbInstanceAccessor } from '@/lib/wa-sqlite/accessor';

const CLEANUP_LOCK = 'analyst-boot-cleanup';

/**
 * Try to acquire the cleanup lock and run the two-phase sweep. If another
 * tab already holds the lock, return immediately — that tab will do the
 * work. The lock is held for the lifetime of the sweep; releases on
 * completion or exception.
 */
export async function runBootCleanup(
    accessor: Comlink.Remote<WaSqliteDbInstanceAccessor>,
): Promise<void> {
    await navigator.locks.request(
        CLEANUP_LOCK,
        { ifAvailable: true, mode: 'exclusive' },
        async (lock) => {
            if (!lock) return; // another tab is doing it
            await runCleanupSweep(accessor);
        },
    );
}

async function runCleanupSweep(
    accessor: Comlink.Remote<WaSqliteDbInstanceAccessor>,
): Promise<void> {
    // Pass 1 — abandoned temp sources from prior worker sessions.
    let sessionId: string;
    try {
        sessionId = await accessor.getWorkerSessionId();
    } catch (e) {
        console.warn('[boot-cleanup] cannot fetch worker session id', e);
        return;
    }
    let abandoned;
    try {
        abandoned = await listAbandonedTempSources(sessionId);
    } catch (e) {
        console.warn('[boot-cleanup] could not list temp sources', e);
        return;
    }
    for (const src of abandoned) {
        try {
            await accessor.destroyOpfs(src.dbFile, src.dbFile);
        } catch (e) {
            // Keep the IDB row in place so the next boot can retry.
            // Removing it now would orphan the OPFS file invisibly.
            console.warn(
                '[boot-cleanup] unlink failed for',
                src.dbFile,
                '— keeping IDB row for next-boot retry',
                e,
            );
            continue;
        }
        try {
            await deleteSource(src.id);
        } catch (e) {
            console.warn('[boot-cleanup] IDB row delete failed', src.id, e);
        }
    }

    // Pass 2 — OPFS orphans. Files at OPFS root with no matching
    // DataSource row. The accessor enumerates OPFS root and filters out
    // VFS-internal entries (the `.ahp-*` temp directories OPFSCoopSyncVFS
    // owns).
    let opfsFiles: string[];
    try {
        opfsFiles = await accessor.listDataFileNames();
    } catch (e) {
        console.warn('[boot-cleanup] listDataFileNames failed', e);
        return;
    }
    let allSources;
    try {
        allSources = await listSources();
    } catch (e) {
        console.warn('[boot-cleanup] listSources failed', e);
        return;
    }
    // `dbFile` may carry a leading `/` from older IDB rows; OPFS leaf
    // names never do. Compare on leaf names so a slashed `dbFile` doesn't
    // make every real OPFS file look orphaned.
    const leaf = (path: string): string => {
        const parts = path.split('/').filter((p) => p.length > 0);
        return parts[parts.length - 1] ?? path;
    };
    const referenced = new Set(allSources.map((s) => leaf(s.dbFile)));
    for (const fileName of opfsFiles) {
        if (referenced.has(fileName)) continue;
        try {
            // `…IfIdle` skips the file if a live tab currently has it open
            // (its VFS handle / Web Lock is held), so we never unlink a file
            // a peer is using. Such a file gets reaped on a later boot when
            // no one holds it.
            const removed = await accessor.destroyOpfsIfIdle(fileName, fileName);
            if (!removed) {
                console.debug('[boot-cleanup] orphan in use by a live tab, skipping', fileName);
            }
        } catch (e) {
            console.warn('[boot-cleanup] orphan unlink failed for', fileName, e);
        }
    }
}
