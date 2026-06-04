/// <reference lib="webworker" />
/**
 * Debug worker for the `/wa-sqlite` route. Hosts an isolated wa-sqlite +
 * OPFSCoopSyncVFS connection at `wa-sqlite-probe.sqlite` and exposes five
 * demos via Comlink:
 *
 *   1. Basic open/insert/select.
 *   2. Multi-tab concurrent writes — open the route in two tabs and run
 *      the writer demo in each; the reader merges per-tab tags.
 *   3. `sqlite3_deserialize` round-trip via the manual `cwrap` binding.
 *   4. Write-heavy load under DELETE journal mode (the only mode
 *      OPFSCoopSyncVFS supports).
 *   5. JS-heap baseline via `performance.memory` where available.
 *
 * Independent of the production accessor on purpose — gives us a way to
 * reproduce engine-level issues without app state in the way.
 */
import * as Comlink from 'comlink';
import { createWaSqliteModule } from '@/lib/wa-sqlite/runtime';
import * as SQLite from 'wa-sqlite';
// @ts-expect-error — example VFSes are .js with no .d.ts companions; treat
//   the export as opaque and rely on runtime behavior.
import { OPFSCoopSyncVFS } from 'wa-sqlite/src/examples/OPFSCoopSyncVFS.js';

declare const self: DedicatedWorkerGlobalScope;

const DB_NAME = 'wa-sqlite-probe.sqlite';
const VFS_NAME = 'opfs-coop-sync-probe';

type SQLiteAPI = ReturnType<typeof SQLite.Factory>;

let modulePromise: Promise<{ sqlite3: SQLiteAPI; module: unknown }> | null = null;

async function getSqlite(): Promise<{ sqlite3: SQLiteAPI; module: unknown }> {
    if (!modulePromise) {
        modulePromise = (async () => {
            const module = await createWaSqliteModule();
            const sqlite3 = SQLite.Factory(module);
            const vfs = await OPFSCoopSyncVFS.create(VFS_NAME, module);
            sqlite3.vfs_register(vfs, true);
            return { sqlite3, module };
        })();
    }
    return modulePromise;
}

async function withDb<T>(fn: (s: SQLiteAPI, db: number) => Promise<T>): Promise<T> {
    const { sqlite3 } = await getSqlite();
    const db = await sqlite3.open_v2(DB_NAME);
    try {
        return await fn(sqlite3, db);
    } finally {
        await sqlite3.close(db);
    }
}

export interface Demo1Result {
    rowCount: number;
    firstFive: Array<{ id: number; label: string }>;
    elapsedMs: number;
}

export interface Demo2WriteResult {
    tag: string;
    written: number;
    elapsedMs: number;
    /**
     * SQLITE_BUSY retry attempts the writer accumulated before completing.
     * Should stay at 0 — OPFSCoopSyncVFS serializes via Web Locks, so writes
     * should queue, not surface BUSY. Non-zero here is a finding worth
     * digging into.
     */
    busyRetries: number;
}

export interface Demo2ReadResult {
    totalRows: number;
    byTag: Record<string, number>;
    elapsedMs: number;
}

export interface Demo3Result {
    /** Whether `module._sqlite3_deserialize` exists as a callable export. */
    rawExportPresent: boolean;
    /** Whether `module.cwrap('sqlite3_deserialize', ...)` produces a callable. */
    cwrappable: boolean;
    /**
     * If we managed to wrap + invoke it, the row count after deserializing a
     * small in-memory DB blob into a `:memory:` connection. Else null.
     */
    callResult: number | null;
    error?: string;
}

export interface Demo4Result {
    inserted: number;
    elapsedMs: number;
    rowsPerSecond: number;
    journalMode: string;
}

export interface Demo5Result {
    /**
     * `performance.memory.usedJSHeapSize` if Chromium exposes it; null on
     * Firefox / Safari where the field is gated.
     */
    usedJSHeapBytes: number | null;
    note: string;
}

class Probe {
    /**
     * Drop the probe table so demos start from a clean slate. Doesn't delete
     * the underlying OPFS file — OPFSCoopSyncVFS owns the file lifecycle.
     */
    async reset(): Promise<void> {
        await withDb(async (s, db) => {
            await s.exec(db, 'DROP TABLE IF EXISTS probe; DROP TABLE IF EXISTS load_test;');
        });
    }

    /** Demo 1 — basic CRUD. */
    async demo1(): Promise<Demo1Result> {
        const start = performance.now();
        return withDb(async (s, db) => {
            await s.exec(
                db,
                `CREATE TABLE IF NOT EXISTS probe (id INTEGER PRIMARY KEY, label TEXT);
                 INSERT INTO probe (label) VALUES ('alpha'), ('beta'), ('gamma'), ('delta'), ('epsilon');`,
            );
            let rowCount = 0;
            const firstFive: Array<{ id: number; label: string }> = [];
            await s.exec(db, 'SELECT id, label FROM probe ORDER BY id', (row) => {
                rowCount++;
                if (firstFive.length < 5) {
                    firstFive.push({ id: row[0] as number, label: row[1] as string });
                }
            });
            return {
                rowCount,
                firstFive,
                elapsedMs: Math.round(performance.now() - start),
            };
        });
    }

    /**
     * Demo 2 — writer half. Tag every row with the caller's tag so the
     * reader half can verify each tab's rows survived without corruption.
     *
     * Loop with SQLITE_BUSY retry: under OPFSCoopSyncVFS this shouldn't
     * trigger (the VFS-layer Web Lock serializes writers across tabs), but
     * if it does the writer should yield + retry, not error out.
     */
    async demo2_write(tag: string, count: number): Promise<Demo2WriteResult> {
        const start = performance.now();
        let busyRetries = 0;
        const result = await withDb(async (s, db) => {
            await s.exec(
                db,
                `CREATE TABLE IF NOT EXISTS multi_tab (
                     id INTEGER PRIMARY KEY,
                     tag TEXT NOT NULL,
                     n INTEGER NOT NULL,
                     ts INTEGER NOT NULL
                 );`,
            );
            let written = 0;
            for (let i = 0; i < count; i++) {
                while (true) {
                    try {
                        await s.exec(db, 'BEGIN IMMEDIATE');
                        await s.exec(
                            db,
                            `INSERT INTO multi_tab (tag, n, ts) VALUES ('${tag.replace(/'/g, "''")}', ${i}, ${Date.now()})`,
                        );
                        await s.exec(db, 'COMMIT');
                        written++;
                        break;
                    } catch (e) {
                        const err = e as { code?: number; message?: string };
                        if (err.code === SQLite.SQLITE_BUSY) {
                            busyRetries++;
                            try {
                                if (!s.get_autocommit(db)) {
                                    await s.exec(db, 'ROLLBACK');
                                }
                            } catch (rollbackErr) {
                                console.warn(
                                    '[wa-sqlite-probe] ROLLBACK after SQLITE_BUSY failed:',
                                    rollbackErr,
                                );
                            }
                            await new Promise((r) => setTimeout(r, 5));
                            continue;
                        }
                        throw e;
                    }
                }
            }
            return written;
        });
        return {
            tag,
            written: result,
            elapsedMs: Math.round(performance.now() - start),
            busyRetries,
        };
    }

    /** Demo 2 — reader half. Aggregates rows by tag. */
    async demo2_read(): Promise<Demo2ReadResult> {
        const start = performance.now();
        return withDb(async (s, db) => {
            await s.exec(
                db,
                `CREATE TABLE IF NOT EXISTS multi_tab (
                     id INTEGER PRIMARY KEY,
                     tag TEXT NOT NULL,
                     n INTEGER NOT NULL,
                     ts INTEGER NOT NULL
                 );`,
            );
            const byTag: Record<string, number> = {};
            let total = 0;
            await s.exec(db, 'SELECT tag, COUNT(*) FROM multi_tab GROUP BY tag', (row) => {
                const tag = row[0] as string;
                const c = row[1] as number;
                byTag[tag] = c;
                total += c;
            });
            return {
                totalRows: total,
                byTag,
                elapsedMs: Math.round(performance.now() - start),
            };
        });
    }

    /**
     * Demo 3 — `sqlite3_deserialize` accessibility check.
     *
     * Path: try `module._sqlite3_deserialize` first (Emscripten exposes C
     * functions with a leading underscore in JS-land); fall back to
     * `module.cwrap` for the binding. If both work, exercise it: open a
     * `:memory:` DB, deserialize a tiny pre-built blob, query it back.
     */
    async demo3(): Promise<Demo3Result> {
        const { sqlite3, module } = await getSqlite();
        const m = module as Record<string, unknown> & {
            cwrap?: (name: string, ret: string | null, args: string[]) => unknown;
            _malloc?: (n: number) => number;
            _free?: (p: number) => void;
            HEAPU8?: Uint8Array;
        };
        const rawExportPresent = typeof m._sqlite3_deserialize === 'function';
        const cwrappable = typeof m.cwrap === 'function';
        let callResult: number | null = null;
        let error: string | undefined;
        if (cwrappable && m.cwrap && m._malloc && m._free && m.HEAPU8) {
            try {
                // Build a tiny SQLite DB on the fly to deserialize. Easier
                // than embedding bytes: open `:memory:`, populate, serialize.
                const memDb = await sqlite3.open_v2(':memory:');
                await sqlite3.exec(
                    memDb,
                    'CREATE TABLE t(x); INSERT INTO t VALUES (1),(2),(3),(4),(5);',
                );
                // Serialize via the wrapped capi if available; otherwise hand-bind.
                let serializeRaw:
                    | ((db: number, schema: number, sizeOut: number, flags: number) => number)
                    | null = null;
                if (typeof m._sqlite3_serialize === 'function') {
                    const fn = m.cwrap('sqlite3_serialize', 'number', [
                        'number',
                        'number',
                        'number',
                        'number',
                    ]) as (db: number, schema: number, sizeOut: number, flags: number) => number;
                    serializeRaw = fn;
                }
                if (!serializeRaw) throw new Error('sqlite3_serialize not exported');

                // Allocate a "main" schema name + a uint64 size out.
                const enc = new TextEncoder().encode('main\0');
                const schemaPtr = m._malloc(enc.byteLength);
                m.HEAPU8.set(enc, schemaPtr);
                const sizePtr = m._malloc(8);
                const dataPtr = serializeRaw(memDb, schemaPtr, sizePtr, 0);
                const sizeLow = new DataView(m.HEAPU8.buffer, sizePtr, 4).getUint32(0, true);
                const blob = m.HEAPU8.slice(dataPtr, dataPtr + sizeLow);
                m._free(schemaPtr);
                m._free(sizePtr);
                await sqlite3.close(memDb);

                // Open a fresh :memory: and deserialize the blob into it.
                const deserializeRaw = m.cwrap('sqlite3_deserialize', 'number', [
                    'number',
                    'number',
                    'number',
                    'number',
                    'number',
                    'number',
                ]) as (
                    db: number,
                    schema: number,
                    data: number,
                    sz: number,
                    bufSz: number,
                    flags: number,
                ) => number;
                const memDb2 = await sqlite3.open_v2(':memory:');
                const schemaPtr2 = m._malloc(enc.byteLength);
                m.HEAPU8.set(enc, schemaPtr2);
                const blobPtr = m._malloc(blob.byteLength);
                m.HEAPU8.set(blob, blobPtr);
                // SQLITE_DESERIALIZE_FREEONCLOSE = 1, RESIZEABLE = 2
                const rc = deserializeRaw(
                    memDb2,
                    schemaPtr2,
                    blobPtr,
                    blob.byteLength,
                    blob.byteLength,
                    1 | 2,
                );
                if (rc !== 0) throw new Error(`sqlite3_deserialize rc=${rc}`);
                let counted = 0;
                await sqlite3.exec(memDb2, 'SELECT COUNT(*) FROM t', (row) => {
                    counted = row[0] as number;
                });
                m._free(schemaPtr2);
                // NB: blobPtr ownership transferred to sqlite via FREEONCLOSE; do NOT free here.
                await sqlite3.close(memDb2);
                callResult = counted;
            } catch (e) {
                error = (e as Error).message;
            }
        }
        return { rawExportPresent, cwrappable, callResult, error };
    }

    /**
     * Demo 4 — write-heavy load. Bulk-insert N rows in a single transaction
     * under DELETE journal mode (the only option under OPFSCoopSyncVFS).
     * Surfaces the effective `journal_mode` so we know we're not silently
     * running on a WAL fallback.
     */
    async demo4(insertCount: number): Promise<Demo4Result> {
        const start = performance.now();
        return withDb(async (s, db) => {
            let journalMode = '';
            await s.exec(db, 'PRAGMA journal_mode=DELETE;', (row) => {
                journalMode = String(row[0]);
            });
            await s.exec(
                db,
                `CREATE TABLE IF NOT EXISTS load_test (
                     id INTEGER PRIMARY KEY,
                     k INTEGER NOT NULL,
                     v TEXT NOT NULL
                 );
                 DELETE FROM load_test;`,
            );
            await s.exec(db, 'BEGIN');
            for (let i = 0; i < insertCount; i++) {
                // Inline values — bound parameters would be faster, but this
                // matches our existing seed.ts pattern + is enough to exercise
                // the journal under load.
                await s.exec(db, `INSERT INTO load_test (k, v) VALUES (${i}, 'val_${i}')`);
            }
            await s.exec(db, 'COMMIT');
            const elapsed = performance.now() - start;
            return {
                inserted: insertCount,
                elapsedMs: Math.round(elapsed),
                rowsPerSecond: Math.round((insertCount / elapsed) * 1000),
                journalMode,
            };
        });
    }

    /** Demo 5 — memory baseline (Chromium only). */
    async demo5(): Promise<Demo5Result> {
        // Force the sqlite + VFS to be alive so the heap reflects steady-state.
        await getSqlite();
        const perf = performance as Performance & {
            memory?: { usedJSHeapSize: number };
        };
        const used = perf.memory?.usedJSHeapSize ?? null;
        return {
            usedJSHeapBytes: used,
            note:
                used !== null
                    ? 'Open this page in N tabs and sum the per-tab values from the page footer to get the N-tab footprint.'
                    : '`performance.memory` is gated on this browser. Use the browser`s built-in task manager (Chrome: ⌥⇧Esc) to compare per-process memory across 1 → 5 tabs.',
        };
    }
}

Comlink.expose(new Probe());

export type ProbeApi = Probe;
