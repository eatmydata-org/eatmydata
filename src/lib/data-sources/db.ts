import { getSqliteDb } from '@/lib/sqlite/client';
import type { DataSource, ImportedTableMeta } from './types';
import { LOW_CARD_MAX_DISTINCT, isLowCardinality } from './low-cardinality';

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
 * The slice of the sqlite handle the meta-table helpers need. Satisfied by
 * both a `Comlink.Remote<WaSqliteDb>` (browser, via `getSourceDb`/`resolveDb`)
 * and a raw `WaSqliteDb` (Node scripts + vitest), so callers pass whichever
 * handle they already hold without re-resolving.
 */
export type MetaDbHandle = {
    execRaw(sql: string, limit?: number): Promise<{ rows: Array<Record<string, unknown>> }>;
};

/**
 * Internal bookkeeping tables that should be hidden from any
 * user-facing surface (data-source UI, agent schema exploration, etc.).
 * Keep additions here so new meta tables are excluded automatically.
 */
export const META_TABLES: readonly string[] = ['__rh_meta_tables', '__rh_meta_columns'];

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
    // Drop any cached per-column cardinality verdicts too so a re-created
    // table of the same name doesn't inherit stale marks.
    await clearColumnCardinality(db, tableName);
}

/**
 * Per-column cardinality verdicts, cached so `describe_table` doesn't
 * re-scan a table on every call. One row per analyzed column (categorical or
 * not), so the presence of *any* row for a table means "already analyzed" —
 * including tables that turned out to have no categorical columns. Keyed by
 * (table, column). `distinct_count` is the observed distinct count for
 * low-cardinality columns, NULL otherwise.
 */
const COL_META_DDL = `CREATE TABLE IF NOT EXISTS __rh_meta_columns (
        table_name TEXT NOT NULL,
        column_name TEXT NOT NULL,
        low_cardinality INTEGER NOT NULL DEFAULT 0,
        distinct_count INTEGER,
        PRIMARY KEY (table_name, column_name)
    )`;

export async function ensureColumnMetaTable(db: MetaDbHandle): Promise<void> {
    await db.execRaw(COL_META_DDL);
}

/**
 * Forget the cached cardinality verdicts for one table. Called whenever the
 * table's data changes (import / re-import / drop) so the next describe
 * re-analyzes against the new rows instead of trusting stale marks.
 */
export async function clearColumnCardinality(db: MetaDbHandle, tableName: string): Promise<void> {
    await ensureColumnMetaTable(db);
    await db.execRaw(`DELETE FROM __rh_meta_columns WHERE table_name = '${escSq(tableName)}'`);
}

type ColumnVerdict = { column: string; lowCard: boolean; distinctCount: number | null };

/**
 * Analyze `columnNames` of `tableName` against the live data and cache the
 * cardinality verdict for each — unless the table is already analyzed, in
 * which case this is a cheap indexed no-op. Idempotent and safe to call on
 * every describe. Detection runs straight off SQL, so it's independent of
 * how the table was created (file import, demo blob, default DB).
 */
export async function ensureCardinalityAnalyzed(
    db: MetaDbHandle,
    tableName: string,
    columnNames: readonly string[],
): Promise<void> {
    await ensureColumnMetaTable(db);
    const seen = await db.execRaw(
        `SELECT 1 FROM __rh_meta_columns WHERE table_name = '${escSq(tableName)}' LIMIT 1`,
    );
    if (seen.rows.length > 0) return;
    const verdicts = await analyzeColumnCardinality(db, tableName, columnNames);
    await storeColumnCardinality(db, tableName, verdicts);
}

async function analyzeColumnCardinality(
    db: MetaDbHandle,
    tableName: string,
    columnNames: readonly string[],
): Promise<ColumnVerdict[]> {
    const t = escId(tableName);
    const totalRow = await db.execRaw(`SELECT COUNT(*) AS n FROM "${t}"`);
    const total = Number(totalRow.rows[0]?.n ?? 0);

    const verdicts: ColumnVerdict[] = [];
    for (const column of columnNames) {
        const c = escId(column);
        // Distinct count, but bailing out at the cap+1: the inner DISTINCT …
        // LIMIT lets sqlite stop as soon as it has seen one too many distinct
        // values, so high-cardinality columns (ids, free text) cost an early
        // exit instead of a full distinct materialization.
        const distinctRow = await db.execRaw(
            `SELECT COUNT(*) AS d FROM (
                 SELECT DISTINCT "${c}" FROM "${t}" WHERE "${c}" IS NOT NULL
                 LIMIT ${LOW_CARD_MAX_DISTINCT + 1}
             )`,
        );
        const distinctCount = Number(distinctRow.rows[0]?.d ?? 0);
        const lowCard = isLowCardinality(distinctCount, total);
        verdicts.push({ column, lowCard, distinctCount: lowCard ? distinctCount : null });
    }
    return verdicts;
}

async function storeColumnCardinality(
    db: MetaDbHandle,
    tableName: string,
    verdicts: readonly ColumnVerdict[],
): Promise<void> {
    if (verdicts.length === 0) return;
    const values = verdicts
        .map(
            (v) =>
                `('${escSq(tableName)}', '${escSq(v.column)}', ${v.lowCard ? 1 : 0}, ` +
                `${v.distinctCount == null ? 'NULL' : Math.trunc(v.distinctCount)})`,
        )
        .join(', ');
    // Upsert so concurrent analyzers (multi-tab) converge instead of colliding
    // on the (table, column) primary key.
    await db.execRaw(
        `INSERT INTO __rh_meta_columns (table_name, column_name, low_cardinality, distinct_count)
         VALUES ${values}
         ON CONFLICT(table_name, column_name) DO UPDATE SET
            low_cardinality = excluded.low_cardinality,
            distinct_count = excluded.distinct_count`,
    );
}

/**
 * Read the columns of `tableName` cached as low-cardinality. Returns column
 * names only — `describe_table` queries the live distinct values itself so
 * the listed set is never stale.
 */
export async function getLowCardColumns(db: MetaDbHandle, tableName: string): Promise<string[]> {
    await ensureColumnMetaTable(db);
    const res = await db.execRaw(
        `SELECT column_name FROM __rh_meta_columns
         WHERE table_name = '${escSq(tableName)}' AND low_cardinality = 1`,
        100_000,
    );
    return res.rows.map((r) => String(r.column_name));
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
    if (!/^[A-Za-z_]\w*$/.test(name)) {
        throw new Error(`Unsafe sqlite identifier: ${JSON.stringify(name)}`);
    }
}

function escSq(s: string): string {
    return s.replace(/'/g, "''");
}

/** Escape a double-quoted sqlite identifier. */
function escId(s: string): string {
    return s.replace(/"/g, '""');
}
