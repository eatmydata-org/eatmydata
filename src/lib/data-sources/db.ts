import { getSqliteDb } from '@/lib/sqlite/client';
import type { DataSource, ImportedTableMeta } from './types';

/**
 * Open (or fetch the cached handle for) the sqlite DB backing a data
 * source. Uses `getSqliteDb` which caches the Comlink Remote per
 * `name` for the life of the leader — without this every repeat call
 * would allocate a fresh MessageChannel on serialization (Comlink's
 * proxyTransferHandler limitation).
 */
export async function getSourceDb(source: DataSource) {
    const opts =
        source.persistence === 'memory' ? {} : { filename: source.dbFile, vfs: 'opfs-sahpool' };
    return getSqliteDb(source.dbFile, opts);
}

/**
 * Internal bookkeeping tables that should be hidden from any
 * user-facing surface (data-source UI, agent schema exploration, etc.).
 * Keep additions here so new meta tables are excluded automatically.
 */
export const META_TABLES: readonly string[] = ['__rh_meta_tables'];

export function isMetaTable(name: string): boolean {
    return META_TABLES.includes(name);
}

/**
 * Ensure the meta table exists. Idempotent. Called by import + view-
 * creation flows so older sources auto-upgrade on first write.
 */
const META_DDL = `CREATE TABLE IF NOT EXISTS __rh_meta_tables (
        table_name TEXT PRIMARY KEY,
        original_file_name TEXT NOT NULL,
        readable_name TEXT,
        imported_at INTEGER NOT NULL
    )`;

export async function ensureMetaTable(source: DataSource): Promise<void> {
    const db = await getSourceDb(source);
    await db.execRaw(META_DDL);
}

export async function putTableMeta(source: DataSource, meta: ImportedTableMeta): Promise<void> {
    await ensureMetaTable(source);
    const db = await getSourceDb(source);
    await db.execRaw(
        `INSERT INTO __rh_meta_tables (table_name, original_file_name, readable_name, imported_at)
         VALUES ('${escSq(meta.tableName)}', '${escSq(meta.originalFileName)}',
                 ${meta.readableName ? `'${escSq(meta.readableName)}'` : 'NULL'},
                 ${meta.importedAt})
         ON CONFLICT(table_name) DO UPDATE SET
            original_file_name = excluded.original_file_name,
            readable_name = excluded.readable_name,
            imported_at = excluded.imported_at`,
    );
}

export async function deleteTableMeta(source: DataSource, tableName: string): Promise<void> {
    await ensureMetaTable(source);
    const db = await getSourceDb(source);
    await db.execRaw(`DELETE FROM __rh_meta_tables WHERE table_name = '${escSq(tableName)}'`);
}

export async function listTableMeta(source: DataSource): Promise<ImportedTableMeta[]> {
    await ensureMetaTable(source);
    const db = await getSourceDb(source);
    const res = await db.execRaw(
        `SELECT table_name, original_file_name, readable_name, imported_at
         FROM __rh_meta_tables`,
        100_000,
    );
    return res.rows.map((r) => ({
        tableName: String(r.table_name),
        originalFileName: String(r.original_file_name),
        readableName: r.readable_name == null ? undefined : String(r.readable_name),
        importedAt: Number(r.imported_at),
    }));
}

/**
 * Strict sqlite identifier check used by every CREATE / DROP / INSERT
 * path. Acts as a defence-in-depth against caller-side bugs since we
 * splice identifiers into SQL directly (sqlite doesn't allow bound
 * parameters for table / column names).
 */
export function assertSafeIdentifier(name: string): void {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new Error(`Unsafe sqlite identifier: ${JSON.stringify(name)}`);
    }
}

function escSq(s: string): string {
    return s.replace(/'/g, "''");
}
