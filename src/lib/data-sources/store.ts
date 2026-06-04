import { openDB, type IDBPDatabase } from 'idb';
import { STORAGE_VERSION } from '@/lib/storage';
import { toSnakeCase } from './identifier';
import type { DataSource, Persistence } from './types';

const DB_NAME = `analyst-data-sources:v${STORAGE_VERSION}`;
const DB_VERSION = 1;
const STORE = 'data_sources';

type Schema = {
    data_sources: {
        key: string;
        value: DataSource;
        indexes: { 'by-createdAt': number };
    };
};

let dbPromise: Promise<IDBPDatabase<Schema>> | null = null;

function openStore(): Promise<IDBPDatabase<Schema>> {
    if (!dbPromise) {
        dbPromise = openDB<Schema>(DB_NAME, DB_VERSION, {
            upgrade(db, oldVersion) {
                if (oldVersion < 1) {
                    const store = db.createObjectStore(STORE, {
                        keyPath: 'id',
                    });
                    store.createIndex('by-createdAt', 'createdAt');
                }
            },
        });
    }
    return dbPromise;
}

export async function listSources(): Promise<DataSource[]> {
    const db = await openStore();
    const all = await db.getAllFromIndex(STORE, 'by-createdAt');
    // Default first, then newest first.
    all.sort((a, b) => {
        if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
        return b.createdAt - a.createdAt;
    });
    return all;
}

export async function getSource(id: string): Promise<DataSource | undefined> {
    const db = await openStore();
    return db.get(STORE, id);
}

export async function putSource(source: DataSource): Promise<void> {
    const db = await openStore();
    await db.put(STORE, source);
}

export async function deleteSource(id: string): Promise<void> {
    const db = await openStore();
    await db.delete(STORE, id);
}

/**
 * Set exactly one source as the default (or none, if id === null).
 * Wrapped in a single transaction so we never end up with two defaults
 * if two tabs flip the flag concurrently.
 */
export async function setDefaultSource(id: string | null): Promise<void> {
    const db = await openStore();
    const tx = db.transaction(STORE, 'readwrite');
    const all = await tx.store.getAll();
    const now = Date.now();
    for (const s of all) {
        const shouldBeDefault = s.id === id;
        if (s.isDefault === shouldBeDefault) continue;
        await tx.store.put({ ...s, isDefault: shouldBeDefault, updatedAt: now });
    }
    await tx.done;
}

/**
 * Returns sources marked as 'temp' that were created in a different worker
 * session than `currentSessionId`. Used by the worker boot cleanup pass.
 */
export async function listAbandonedTempSources(
    currentSessionId: string,
): Promise<DataSource[]> {
    const db = await openStore();
    const all = await db.getAll(STORE);
    return all.filter(
        (s) => s.persistence === 'temp' && s.sessionId !== currentSessionId,
    );
}

export function makeDataSourceId(): string {
    return crypto.randomUUID();
}

/**
 * Generate an OPFS leaf filename for a new data source whose display name is
 * `sourceName`. Real OPFS leaf name (no path separators — `getFileHandle`
 * rejects them). For OPFS-backed persistence the leaf is the snake_case of
 * the source name with `.sqlite` extension; collisions against `takenLeaves`
 * are resolved by appending `_1`, `_2`, … For memory persistence the file
 * never lands in OPFS — we still use a `mem_<uuid>` key so concurrently-
 * created memory sources don't share a worker-side WaSqliteDb instance.
 */
export function makeDbFile(
    sourceName: string,
    persistence: Persistence,
    takenLeaves: Set<string> = new Set(),
    id: string = crypto.randomUUID(),
): string {
    if (persistence === 'memory') return `mem_${id}`;
    const base = toSnakeCase(sourceName, 'data_source');
    const suffix = '.sqlite';
    if (!takenLeaves.has(`${base}${suffix}`)) return `${base}${suffix}`;
    let i = 1;
    while (takenLeaves.has(`${base}_${i}${suffix}`)) i++;
    return `${base}_${i}${suffix}`;
}

/**
 * Build the taken-leaf set used by `makeDbFile` to dedup. Pass the existing
 * sources list — defensive against the rare OPFS-orphan case (rows where the
 * file got cleaned but IDB still has the entry, or vice versa) is left to
 * `boot-cleanup`.
 */
export function takenDbLeaves(sources: ReadonlyArray<DataSource>): Set<string> {
    return new Set(sources.map((s) => s.dbFile));
}
