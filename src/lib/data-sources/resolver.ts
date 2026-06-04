/**
 * Resolve the sqlite DB that backs a given source-id (or undefined →
 * legacy default DB). Used by the action executor and agent tools.
 *
 * Kept in its own file so importing the resolver doesn't pull in the
 * UI-side data-sources route's component tree.
 */
import { getSqliteDb } from '@/lib/sqlite/client';
import { getSource } from './store';

export async function resolveDb(sourceId: string | undefined) {
    if (!sourceId) return getSqliteDb();
    const source = await getSource(sourceId);
    if (!source) return getSqliteDb();
    const opts =
        source.persistence === 'memory'
            ? {}
            : { filename: source.dbFile, vfs: 'opfs-sahpool' };
    return getSqliteDb(source.dbFile, opts);
}
