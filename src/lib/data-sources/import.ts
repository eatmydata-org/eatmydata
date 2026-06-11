import type { DataSource } from './types';
import { getSourceDb, putTableMeta, clearColumnCardinality, assertSafeIdentifier } from './db';
import { autoIndexAfterImport } from './semantic-index';
import { sanitizeColumnNames, toSnakeCase, dedupIdentifier } from './identifier';
import { sniffColumn, coerceCell, type ColumnSniff } from './type-sniff';
import { parseCsv, type CsvParseResult } from './parse-csv';
import { parseXlsx, type XlsxSheetParse } from './parse-xlsx';

export type ConflictResolution = 'overwrite' | 'rename' | 'skip';

/**
 * One staged file (or sheet within an XLSX) ready for commit. The
 * staging dialog builds an array of these and hands the whole array to
 * `importBatch`. Each job is independently committable so a bad row in
 * one file doesn't poison others.
 */
export type ImportJob = {
    /** Unique id for tracking in the UI; not persisted. */
    stageId: string;
    /** Human-readable origin: filename (+ ":<sheet>" for XLSX). */
    originLabel: string;
    /**
     * Sanitized snake_case table name the user picked. Must be unique
     * within the batch — collisions are resolved in the staging dialog
     * via `conflict.resolution`.
     */
    tableName: string;
    /** Optional human-readable label, stored in __rh_meta_tables. */
    readableName?: string;
    /** Conflict against existing table (decided in the dialog). */
    conflict?: { existing: true; resolution: ConflictResolution };
    /** Column sniffs (one per column). */
    sniffs: ColumnSniff[];
    /** Sanitized column names (snake_case). */
    columnNames: string[];
    /** Original header text, kept for the preview/UI. */
    originalHeaders: string[];
    /** Row data, may be string[][] (CSV) or unknown[][] (XLSX). */
    rows: ReadonlyArray<readonly unknown[]>;
};

export type ImportJobOutcome = {
    stageId: string;
    tableName: string;
    /** 'imported' for fresh, 'overwritten' for re-imports, 'skipped' for skipped, 'failed' for errors. */
    status: 'imported' | 'overwritten' | 'skipped' | 'failed';
    rowCount: number;
    /** Final landed name (might differ from tableName when resolution=rename). */
    finalTableName: string;
    error?: string;
};

export type ProgressTick = {
    completed: number;
    total: number;
    current?: string;
    /**
     * 'import' (default) = staging/landing tables; 'index' = building the
     * semantic-search indexes the dialog blocks on before closing. During 'index'
     * completed/total are ROWS embedded for `current` (the "table.column").
     */
    phase?: 'import' | 'index';
};

/**
 * Read a file into a staged ImportJob (one per CSV, one per XLSX sheet).
 * Returns 0+ jobs — a workbook with multiple sheets yields multiple.
 * Throws on unrecoverable read errors.
 */
export async function stageFile(
    file: File,
    existingTableNames: ReadonlyArray<string>,
    batchTaken: Set<string>,
): Promise<ImportJob[]> {
    const ext = file.name.toLowerCase().split('.').pop() ?? '';
    if (ext === 'csv' || ext === 'tsv' || ext === 'txt') {
        const text = await file.text();
        const parsed = parseCsv(text, {
            delimiter: ext === 'tsv' ? '\t' : undefined,
        });
        return [stageFromCsv(file.name, parsed, existingTableNames, batchTaken)];
    }
    if (ext === 'xlsx' || ext === 'xls') {
        const buf = await file.arrayBuffer();
        const sheets = parseXlsx(buf);
        return sheets
            .filter((s) => s.headers.length > 0)
            .map((sheet) => stageFromXlsxSheet(file.name, sheet, existingTableNames, batchTaken));
    }
    throw new Error(`Unsupported file type: .${ext}`);
}

function stageFromCsv(
    fileName: string,
    parsed: CsvParseResult,
    existingTableNames: ReadonlyArray<string>,
    batchTaken: Set<string>,
): ImportJob {
    const columnNames = sanitizeColumnNames(parsed.headers);
    const sniffs = sniffPerColumn(parsed.rows, columnNames.length);
    const baseTableName = toSnakeCase(fileName);
    return buildJob({
        stageId: crypto.randomUUID(),
        originLabel: fileName,
        baseTableName,
        existingTableNames,
        batchTaken,
        originalHeaders: parsed.headers,
        columnNames,
        sniffs,
        rows: parsed.rows,
    });
}

function stageFromXlsxSheet(
    fileName: string,
    sheet: XlsxSheetParse,
    existingTableNames: ReadonlyArray<string>,
    batchTaken: Set<string>,
): ImportJob {
    const columnNames = sanitizeColumnNames(sheet.headers);
    const sniffs = sniffPerColumn(sheet.rows, columnNames.length);
    const filePart = toSnakeCase(fileName);
    const sheetPart = toSnakeCase(sheet.sheetName, 'sheet');
    // Use the sheet name alone if the workbook has only one sheet
    // (callers know this via the sheets array, but here we just append).
    const baseTableName = `${filePart}_${sheetPart}`;
    return buildJob({
        stageId: crypto.randomUUID(),
        originLabel: `${fileName} :: ${sheet.sheetName}`,
        baseTableName,
        existingTableNames,
        batchTaken,
        originalHeaders: sheet.headers,
        columnNames,
        sniffs,
        rows: sheet.rows,
    });
}

function buildJob(args: {
    stageId: string;
    originLabel: string;
    baseTableName: string;
    existingTableNames: ReadonlyArray<string>;
    batchTaken: Set<string>;
    originalHeaders: string[];
    columnNames: string[];
    sniffs: ColumnSniff[];
    rows: ReadonlyArray<readonly unknown[]>;
}): ImportJob {
    const conflictsWithExisting = args.existingTableNames.includes(args.baseTableName);
    const dedupAgainst = new Set(args.batchTaken);
    // Treat existing tables as taken too so auto-rename picks a new name
    // when the user later flips resolution → 'rename'.
    for (const t of args.existingTableNames) dedupAgainst.add(t);
    const tableName = conflictsWithExisting
        ? args.baseTableName
        : dedupIdentifier(args.baseTableName, dedupAgainst);
    args.batchTaken.add(tableName);
    return {
        stageId: args.stageId,
        originLabel: args.originLabel,
        tableName,
        conflict: conflictsWithExisting ? { existing: true, resolution: 'rename' } : undefined,
        sniffs: args.sniffs,
        columnNames: args.columnNames,
        originalHeaders: args.originalHeaders,
        rows: args.rows,
    };
}

/**
 * Sniff each column across a row matrix. Uses up to 200 sampled rows
 * (head + middle + tail) so we catch consistency-breaking values that
 * only appear later in the file.
 */
function sniffPerColumn(rows: ReadonlyArray<readonly unknown[]>, colCount: number): ColumnSniff[] {
    const SAMPLE = 200;
    const out: ColumnSniff[] = [];
    const sampled = sampleRows(rows, SAMPLE);
    for (let c = 0; c < colCount; c++) {
        const colSamples = sampled.map((r) => r[c] ?? null);
        out.push(sniffColumn(colSamples));
    }
    return out;
}

function sampleRows<T>(rows: ReadonlyArray<T>, max: number): T[] {
    if (rows.length <= max) return [...rows];
    const out: T[] = [];
    const step = rows.length / max;
    for (let i = 0; i < max; i++) {
        out.push(rows[Math.floor(i * step)]!);
    }
    return out;
}

const BATCH_INSERT = 500;

/**
 * Resolve final landing names for a batch, honoring user's conflict
 * choices and deduping any in-batch dupes that snuck in. Pure function;
 * returns either a name to land at or null if the job should be skipped.
 */
function resolveLandingNames(
    jobs: ReadonlyArray<ImportJob>,
    existingTableNames: ReadonlyArray<string>,
): Array<string | null> {
    const taken = new Set<string>(existingTableNames);
    return jobs.map((job) => {
        const resolution = job.conflict?.resolution;
        if (resolution === 'skip') return null;
        if (job.conflict && resolution === 'overwrite') {
            taken.add(job.tableName);
            return job.tableName;
        }
        // Either no conflict or 'rename' — dedup against running taken set.
        const final = taken.has(job.tableName)
            ? dedupIdentifier(job.tableName, taken)
            : job.tableName;
        taken.add(final);
        return final;
    });
}

/**
 * Import a batch sequentially. Failures don't roll back earlier jobs.
 * Each job runs inside a sqlite transaction so a mid-INSERT failure
 * leaves no half-table behind.
 */
export async function importBatch(
    source: DataSource,
    jobs: ReadonlyArray<ImportJob>,
    existingTableNames: ReadonlyArray<string>,
    onProgress?: (tick: ProgressTick) => void,
): Promise<ImportJobOutcome[]> {
    const finalNames = resolveLandingNames(jobs, existingTableNames);
    const outcomes: ImportJobOutcome[] = [];
    for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i]!;
        const finalTableName = finalNames[i] ?? null;
        onProgress?.({
            completed: i,
            total: jobs.length,
            current: job.originLabel,
        });
        if (finalTableName === null) {
            outcomes.push({
                stageId: job.stageId,
                tableName: job.tableName,
                finalTableName: job.tableName,
                status: 'skipped',
                rowCount: 0,
            });
            continue;
        }
        const landed: string = finalTableName;
        try {
            const isOverwrite =
                job.conflict?.resolution === 'overwrite' && existingTableNames.includes(landed);
            const rowCount = await importOne(source, job, landed);
            outcomes.push({
                stageId: job.stageId,
                tableName: job.tableName,
                finalTableName: landed,
                status: isOverwrite ? 'overwritten' : 'imported',
                rowCount,
            });
        } catch (e) {
            outcomes.push({
                stageId: job.stageId,
                tableName: job.tableName,
                finalTableName: landed,
                status: 'failed',
                rowCount: 0,
                error: e instanceof Error ? e.message : String(e),
            });
        }
    }
    onProgress?.({ completed: jobs.length, total: jobs.length });
    // Build the semantic-search indexes for the freshly landed TEXT columns BEFORE
    // returning, so the import dialog blocks (with progress) until search is ready —
    // cheap now with the Model2Vec static embedder. Index progress maps onto the
    // same ProgressTick (phase:'index'). Best-effort: never throws into the outcome.
    const landedTables = outcomes
        .filter((o) => o.status === 'imported' || o.status === 'overwritten')
        .map((o) => ({ name: o.finalTableName, overwritten: o.status === 'overwritten' }));
    if (landedTables.length > 0) {
        await autoIndexAfterImport(source, landedTables, (p) =>
            onProgress?.({
                phase: 'index',
                completed: p.done,
                total: p.total,
                current: `${p.table}.${p.column}`,
            }),
        );
    }
    return outcomes;
}

async function importOne(
    source: DataSource,
    job: ImportJob,
    finalTableName: string,
): Promise<number> {
    assertSafeIdentifier(finalTableName);
    for (const col of job.columnNames) assertSafeIdentifier(col);
    const db = await getSourceDb(source);
    const cols = job.columnNames;
    const types = job.sniffs.map((s) => s.sqlType);
    const colDdl = cols.map((name, i) => `"${name}" ${types[i]}`).join(', ');

    await db.execRaw('BEGIN');
    try {
        await db.execRaw(`DROP TABLE IF EXISTS "${finalTableName}"`);
        await db.execRaw(`CREATE TABLE "${finalTableName}" (${colDdl})`);
        const quotedCols = cols.map((c) => `"${c}"`).join(', ');

        // Prepared statements aren't proxied over Comlink, so we batch many
        // VALUES rows per INSERT to amortize the worker round-trip.
        let inserted = 0;
        for (let start = 0; start < job.rows.length; start += BATCH_INSERT) {
            const chunk = job.rows.slice(start, start + BATCH_INSERT);
            const valuesParts: string[] = [];
            for (const row of chunk) {
                const bindings: string[] = [];
                for (let c = 0; c < cols.length; c++) {
                    const v = coerceCell(row[c], job.sniffs[c]!);
                    bindings.push(sqlLiteral(v));
                }
                valuesParts.push(`(${bindings.join(', ')})`);
            }
            await db.execRaw(
                `INSERT INTO "${finalTableName}" (${quotedCols}) VALUES ${valuesParts.join(', ')}`,
            );
            inserted += chunk.length;
        }

        await db.execRaw('COMMIT');
        await putTableMeta(source, {
            tableName: finalTableName,
            originalFileName: job.originLabel,
            readableName: job.readableName,
            importedAt: Date.now(),
        });
        // Invalidate any cached cardinality verdicts for this name so the next
        // describe_table re-analyzes the freshly imported rows (categorical
        // columns are detected lazily at describe time — see low-cardinality.ts).
        // Best-effort: the import is already committed.
        try {
            await clearColumnCardinality(db, finalTableName);
        } catch (e) {
            console.warn('[data-sources/import] clearing cardinality cache failed:', e);
        }
        return inserted;
    } catch (e) {
        try {
            await db.execRaw('ROLLBACK');
        } catch (rollbackErr) {
            // The original error is rethrown below — but a failed
            // ROLLBACK means the txn state is unclear and worth
            // surfacing on its own.
            console.error(
                '[data-sources/import] ROLLBACK after import failure also failed:',
                rollbackErr,
            );
        }
        throw e;
    }
}

/**
 * SQLite literal encoder for the chunked INSERT path. We don't bind
 * parameters because the worker's exec API is statement-shaped and
 * binding N×500 params per round-trip would dwarf the actual insert
 * cost. The values we pass in have already been coerced by
 * `coerceCell`, so they're number | string | null only.
 */
function sqlLiteral(v: string | number | null): string {
    if (v === null) return 'NULL';
    if (typeof v === 'number') {
        if (!Number.isFinite(v)) return 'NULL';
        return String(v);
    }
    return `'${v.replace(/'/g, "''")}'`;
}
