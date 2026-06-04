/**
 * "Import table" flow targeting an existing table. The UX promise is:
 *
 *  - If the incoming file's column shape matches the existing table
 *    exactly (same names in the same order, same SQL types), replace
 *    just the data — keep the table definition, swap out the rows.
 *  - If anything in the column shape differs, ask the user whether to
 *    replace the structure too. On yes → drop + recreate + insert; on
 *    no → cancel without touching the existing table.
 *
 * "Re-import" (in the table side panel) is the unconditional variant:
 * it always drops and recreates. This module is for the per-grid
 * "Import table" button where we want a safety net.
 */
import type { DataSource } from './types';
import { getSourceDb, putTableMeta, assertSafeIdentifier } from './db';
import { coerceCell, type ColumnSniff } from './type-sniff';
import { stageFile, type ImportJob } from './import';

export type ColumnInfo = { name: string; type: string };

export type StructureMismatch = {
    current: ColumnInfo[];
    incoming: ColumnInfo[];
    /** Friendly summary of the differences, ready to show in a dialog. */
    reasons: string[];
};

export type ImportIntoResult =
    | { mode: 'data-only'; rowCount: number }
    | { mode: 'structure-and-data'; rowCount: number }
    | { mode: 'cancelled' };

/**
 * Read the existing table's schema. We use PRAGMA table_info, which
 * returns rows even when the table has zero rows (so the comparison is
 * structural, not row-dependent).
 */
async function getCurrentColumns(
    source: DataSource,
    tableName: string,
): Promise<ColumnInfo[]> {
    const db = await getSourceDb(source);
    const safe = tableName.replace(/"/g, '""');
    const res = await db.execRaw(`PRAGMA table_info("${safe}")`, 10_000);
    return res.rows.map((r) => ({
        name: String(r.name),
        type: String(r.type ?? '').toUpperCase(),
    }));
}

function diffColumns(
    current: ColumnInfo[],
    incoming: ColumnInfo[],
): string[] {
    const reasons: string[] = [];
    if (current.length !== incoming.length) {
        reasons.push(
            `Column count differs: ${current.length} (current) vs ${incoming.length} (incoming).`,
        );
    }
    const max = Math.max(current.length, incoming.length);
    for (let i = 0; i < max; i++) {
        const a = current[i];
        const b = incoming[i];
        if (!a && b) {
            reasons.push(`Extra column #${i + 1}: "${b.name}" (${b.type}).`);
            continue;
        }
        if (a && !b) {
            reasons.push(`Missing column #${i + 1}: "${a.name}" (${a.type}).`);
            continue;
        }
        if (a && b && a.name !== b.name) {
            reasons.push(
                `Column #${i + 1} name differs: "${a.name}" vs "${b.name}".`,
            );
        }
        if (a && b && a.type !== b.type) {
            reasons.push(
                `Column #${i + 1} ("${a.name}") type differs: ${a.type || '(none)'} vs ${b.type || '(none)'}.`,
            );
        }
    }
    return reasons;
}

const BATCH_INSERT = 500;

function sqlLiteral(v: string | number | null): string {
    if (v === null) return 'NULL';
    if (typeof v === 'number') {
        if (!Number.isFinite(v)) return 'NULL';
        return String(v);
    }
    return `'${v.replace(/'/g, "''")}'`;
}

async function bulkInsert(
    source: DataSource,
    tableName: string,
    columnNames: string[],
    sniffs: ColumnSniff[],
    rows: ReadonlyArray<readonly unknown[]>,
): Promise<number> {
    assertSafeIdentifier(tableName);
    for (const c of columnNames) assertSafeIdentifier(c);
    const db = await getSourceDb(source);
    const quotedCols = columnNames.map((c) => `"${c}"`).join(', ');
    let inserted = 0;
    for (let start = 0; start < rows.length; start += BATCH_INSERT) {
        const chunk = rows.slice(start, start + BATCH_INSERT);
        const parts: string[] = [];
        for (const row of chunk) {
            const bindings: string[] = [];
            for (let c = 0; c < columnNames.length; c++) {
                const v = coerceCell(row[c], sniffs[c]!);
                bindings.push(sqlLiteral(v));
            }
            parts.push(`(${bindings.join(', ')})`);
        }
        await db.execRaw(
            `INSERT INTO "${tableName}" (${quotedCols}) VALUES ${parts.join(', ')}`,
        );
        inserted += chunk.length;
    }
    return inserted;
}

/**
 * Replace rows in `tableName` using the parsed `job`. Same-shape only —
 * caller must have already confirmed structures match (or this function
 * skips that check and trusts the caller).
 */
async function replaceDataOnly(
    source: DataSource,
    tableName: string,
    job: ImportJob,
): Promise<number> {
    assertSafeIdentifier(tableName);
    const db = await getSourceDb(source);
    await db.execRaw('BEGIN');
    try {
        await db.execRaw(`DELETE FROM "${tableName}"`);
        const inserted = await bulkInsert(
            source,
            tableName,
            job.columnNames,
            job.sniffs,
            job.rows,
        );
        await db.execRaw('COMMIT');
        await putTableMeta(source, {
            tableName,
            originalFileName: job.originLabel,
            importedAt: Date.now(),
        });
        return inserted;
    } catch (e) {
        try {
            await db.execRaw('ROLLBACK');
        } catch {
            // ignore
        }
        throw e;
    }
}

async function replaceStructureAndData(
    source: DataSource,
    tableName: string,
    job: ImportJob,
): Promise<number> {
    assertSafeIdentifier(tableName);
    for (const c of job.columnNames) assertSafeIdentifier(c);
    const db = await getSourceDb(source);
    const colDdl = job.columnNames
        .map((name, i) => `"${name}" ${job.sniffs[i]!.sqlType}`)
        .join(', ');
    await db.execRaw('BEGIN');
    try {
        await db.execRaw(`DROP TABLE IF EXISTS "${tableName}"`);
        await db.execRaw(`CREATE TABLE "${tableName}" (${colDdl})`);
        const inserted = await bulkInsert(
            source,
            tableName,
            job.columnNames,
            job.sniffs,
            job.rows,
        );
        await db.execRaw('COMMIT');
        await putTableMeta(source, {
            tableName,
            originalFileName: job.originLabel,
            importedAt: Date.now(),
        });
        return inserted;
    } catch (e) {
        try {
            await db.execRaw('ROLLBACK');
        } catch {
            // ignore
        }
        throw e;
    }
}

/**
 * Parse the file, compare to the target table, and apply data-only OR
 * delegate the structure-change decision to the caller via the
 * `onStructureMismatch` callback. XLSX workbooks with multiple sheets
 * only use the FIRST sheet — this is the per-table import button, not
 * the multi-file batch.
 */
export async function importIntoExisting(
    source: DataSource,
    targetTable: string,
    file: File,
    onStructureMismatch: (
        mismatch: StructureMismatch,
    ) => Promise<'replace-structure' | 'cancel'>,
): Promise<ImportIntoResult> {
    const jobs = await stageFile(file, [], new Set());
    const job = jobs[0];
    if (!job || job.columnNames.length === 0) {
        throw new Error('Could not parse any columns out of the file.');
    }
    // Force the job to land at the target name regardless of what
    // stageFile inferred from the filename.
    job.tableName = targetTable;

    const current = await getCurrentColumns(source, targetTable);
    const incoming = job.columnNames.map((name, i) => ({
        name,
        type: job.sniffs[i]!.sqlType,
    }));
    const reasons = diffColumns(current, incoming);
    if (reasons.length === 0) {
        const n = await replaceDataOnly(source, targetTable, job);
        return { mode: 'data-only', rowCount: n };
    }
    const decision = await onStructureMismatch({
        current,
        incoming,
        reasons,
    });
    if (decision === 'cancel') return { mode: 'cancelled' };
    const n = await replaceStructureAndData(source, targetTable, job);
    return { mode: 'structure-and-data', rowCount: n };
}
