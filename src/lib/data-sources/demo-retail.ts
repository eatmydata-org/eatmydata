import type { DataSource, Persistence } from './types';
import {
    listSources,
    makeDataSourceId,
    makeDbFile,
    putSource,
    takenDbLeaves,
} from './store';
import { getSourceDb, putTableMeta } from './db';
import { getWorkerSessionId } from './session';

/**
 * Create a new data source seeded with the existing retail-demo dataset.
 * Returns the created DataSource row so the UI can navigate to it.
 *
 * In the future we'll have more demo datasets (Northwind, ...). Each
 * gets its own creator like this; they all share the same persistence
 * choice contract.
 */
export async function createRetailDemoSource(
    name: string,
    persistence: Persistence,
): Promise<DataSource> {
    const id = makeDataSourceId();
    const now = Date.now();
    const all = await listSources();
    const source: DataSource = {
        id,
        name,
        dbFile: makeDbFile(name, persistence, takenDbLeaves(all), id),
        kind: 'demo',
        persistence,
        sessionId:
            persistence === 'temp' ? getWorkerSessionId() : undefined,
        isDefault: false,
        createdAt: now,
        updatedAt: now,
    };
    await putSource(source);

    const db = await getSourceDb(source);
    await db.seed({ force: true });

    // Stamp each seeded table with a meta row so the data sources page
    // can show "originated from: (demo)" alongside imported tables.
    const seeded = [
        'warehouses', 'products', 'stock', 'customers',
        'orders', 'order_items', 'returns', 'claims',
    ];
    for (const t of seeded) {
        await putTableMeta(source, {
            tableName: t,
            originalFileName: '(demo: retail)',
            importedAt: now,
        });
    }
    return source;
}
