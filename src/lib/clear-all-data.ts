import { listSources, deleteSource } from '@/lib/data-sources/store';
import { closeSqliteDb, destroySqliteOpfs } from '@/lib/sqlite/client';
import { clearAllActions } from '@/lib/actions/store';

/**
 * Wipe everything EatMyData persists in this browser: every data source
 * (its SQLite database + tables, whether the bytes live in OPFS or only in
 * the worker's memory) and the entire action history (saved actions, their
 * version history, and every recorded run/result).
 *
 * Backs both the production "My data → Delete all my data" control in
 * Settings and the dev-only "Delete everything" button in the Sources panel.
 *
 * Best-effort per source: a failure to release/unlink one db file (e.g. a
 * peer tab transiently holding the OPFS handle) is logged loudly and the
 * sweep continues rather than stranding the remaining sources. Does NOT
 * touch settings or the API key — that's `runtime.resetSettings()`.
 */
export async function clearAllData(): Promise<void> {
    const all = await listSources();
    for (const src of all) {
        try {
            if (src.persistence === 'memory') {
                await closeSqliteDb(src.dbFile);
            } else {
                await destroySqliteOpfs(src.dbFile, src.dbFile);
            }
        } catch (e) {
            console.warn('[clear-all-data] failed to release/unlink db file', src.dbFile, e);
        }
        try {
            await deleteSource(src.id);
        } catch (e) {
            console.warn('[clear-all-data] failed to delete data source row', src.id, e);
        }
    }
    await clearAllActions();
}
