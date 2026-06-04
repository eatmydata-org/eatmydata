/**
 * The browser-side sqlite engine: wa-sqlite + OPFSCoopSyncVFS, hosted in a
 * DedicatedWorker. Talks to wa-sqlite's lower-level `prepare_v2`/`step`/
 * `column_*` API. A few capi functions wa-sqlite's JS layer doesn't expose
 * (`sqlite3_stmt_readonly`, `sqlite3_deserialize`) are cwrapped manually
 * via `./capi.ts`.
 */
import { createWaSqliteModule } from './runtime';
import * as SQLite from 'wa-sqlite';
// @ts-expect-error — example VFSes ship as .js with no .d.ts companions.
import { OPFSCoopSyncVFS } from 'wa-sqlite/src/examples/OPFSCoopSyncVFS.js';
import {
    bindExtraCapi,
    type ExtraCapi,
    SQLITE_DESERIALIZE_FREEONCLOSE,
    SQLITE_DESERIALIZE_RESIZEABLE,
} from './capi';
import { isBusyError, retryOnBusy } from './busy';
import {
    DataSourceUnreadableError,
    isUnreadableDbError,
    SQLITE_CORRUPT,
    SQLITE_NOTADB,
    UNREADABLE_DB_MESSAGE,
} from './validate';
import { seedRetailWa, type WaSeedOptions, type WaSeedSummary } from './seed';
import type {
    ColumnInfo,
    TableSchema,
    ForeignKey,
    QueryValidation,
    QueryResult,
    SqliteDbInitOptions,
} from './types';

export type {
    ColumnInfo,
    TableSchema,
    ForeignKey,
    QueryValidation,
    QueryResult,
    SqliteDbInitOptions,
};

type SQLiteAPI = ReturnType<typeof SQLite.Factory>;

/**
 * Module-level cache for the wa-sqlite module + VFS. Each call to
 * `createWaSqliteModule()` allocates a fresh module with its own VFS
 * registry, and OPFSCoopSyncVFS can only be registered once per module (it
 * claims unique state in OPFS root). Cache the *promise* so concurrent
 * first-time callers share one initialization.
 */
let waPromise: Promise<{
    sqlite3: SQLiteAPI;
    module: unknown;
    capi: ExtraCapi;
}> | null = null;

const DEFAULT_VFS_NAME = 'opfs-coop-sync';

/**
 * Whether to attempt OPFSCoopSyncVFS registration. We skip in environments
 * that lack OPFS — vitest's `environment: 'node'` test runner is the main
 * such case. `:memory:` opens still work without a registered VFS, so the
 * test suite can exercise the wa-sqlite layer without a browser.
 */
function canRegisterOpfsVfs(): boolean {
    return (
        typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function'
    );
}

export async function getWaSqlite(): Promise<{
    sqlite3: SQLiteAPI;
    module: unknown;
    capi: ExtraCapi;
}> {
    if (!waPromise) {
        waPromise = (async () => {
            const module = await createWaSqliteModule();
            const sqlite3 = SQLite.Factory(module);
            if (canRegisterOpfsVfs()) {
                const vfs = await OPFSCoopSyncVFS.create(DEFAULT_VFS_NAME, module);
                sqlite3.vfs_register(vfs, true);
            }
            const capi = bindExtraCapi(module);
            return { sqlite3, module, capi };
        })();
    }
    return waPromise;
}

/**
 * Trailing-SQL detection for "single statement" enforcement.
 * `sqlite3_sql(stmt)` returns the substring sqlite actually consumed;
 * anything after that in the original input is a second statement that
 * `prepare` silently dropped.
 */
function trailingSqlAfter(original: string, compiled: string): string {
    const idx = original.indexOf(compiled);
    return idx < 0 ? '' : original.slice(idx + compiled.length);
}

/**
 * Worker-side error classifier. Run on the raw error from sqlite while we
 * still have the numeric `.code` (it's stripped when the error crosses the
 * Comlink boundary). Transient SQLITE_BUSY/LOCKED is left untouched so
 * `retryOnBusy` can do its job; SQLITE_NOTADB/CORRUPT (and our own header
 * rejections) are normalised into a single {@link DataSourceUnreadableError}
 * with a stable, user-facing message. Anything else passes through.
 */
function classifyDbError(e: unknown): unknown {
    if (isBusyError(e)) return e;
    const code = (e as { code?: number }).code;
    if (code === SQLITE_NOTADB || code === SQLITE_CORRUPT || isUnreadableDbError(e)) {
        return e instanceof DataSourceUnreadableError
            ? e
            : new DataSourceUnreadableError(UNREADABLE_DB_MESSAGE, e);
    }
    return e;
}

export class WaSqliteDb {
    #sqlite3: SQLiteAPI | null = null;
    #module: unknown = null;
    #capi: ExtraCapi | null = null;
    #db: number | null = null;
    #initPromise: Promise<void> | null = null;

    async init(options: SqliteDbInitOptions = {}): Promise<void> {
        if (!this.#initPromise) {
            const filename = options.filename ?? ':memory:';
            // `options.vfs` is accepted for caller convenience but ignored —
            // OPFSCoopSyncVFS is registered as the default, so anything other
            // than `:memory:` opens against OPFS regardless.
            this.#initPromise = (async () => {
                const wa = await getWaSqlite();
                this.#sqlite3 = wa.sqlite3;
                this.#module = wa.module;
                this.#capi = wa.capi;
                this.#db = await wa.sqlite3.open_v2(filename);
            })();
        }
        return this.#initPromise;
    }

    #require(): { sqlite3: SQLiteAPI; db: number; capi: ExtraCapi; module: unknown } {
        if (!this.#sqlite3 || !this.#db || !this.#capi) {
            throw new Error('WaSqliteDb not initialized; call init() first');
        }
        return {
            sqlite3: this.#sqlite3,
            db: this.#db,
            capi: this.#capi,
            module: this.#module,
        };
    }

    /**
     * Cheap "can this database be read at all" probe. Forces sqlite to read
     * the file header (a corrupt/HTML/truncated file throws SQLITE_NOTADB or
     * SQLITE_CORRUPT here, on the first real access). Throws
     * {@link DataSourceUnreadableError} on failure. Used post-import to refuse
     * registering a broken demo, and as a fast pre-flight before exposing a
     * source to the agent.
     */
    async assertReadable(): Promise<void> {
        const { sqlite3, db } = this.#require();
        try {
            await retryOnBusy(async () => {
                await sqlite3.exec(db, 'SELECT count(*) FROM sqlite_master');
            });
        } catch (e) {
            throw classifyDbError(e);
        }
    }

    async getSchema(): Promise<TableSchema[]> {
        const { sqlite3, db } = this.#require();
        // Retry transient cross-tab SQLITE_BUSY/LOCKED with backoff (see
        // ./busy.ts) — schema reads contend for the shared OPFS handle too.
        // A corrupt/non-database file surfaces SQLITE_NOTADB on the first
        // read here; `classifyDbError` normalises it into a
        // DataSourceUnreadableError so every caller gets one recognisable
        // error instead of a raw sqlite message.
        try {
            return await retryOnBusy(async () => {
                const objects: Array<{ name: string; type: 'table' | 'view' }> = [];
                await sqlite3.exec(
                    db,
                    'SELECT name, type FROM sqlite_master ' +
                        "WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' " +
                        'ORDER BY type, name',
                    (row) => {
                        objects.push({
                            name: row[0] as string,
                            type: row[1] as 'table' | 'view',
                        });
                    },
                );

                const out: TableSchema[] = [];
                for (const { name, type } of objects) {
                    const safe = name.replace(/"/g, '""');
                    const columns: ColumnInfo[] = [];
                    await sqlite3.exec(db, `PRAGMA table_info("${safe}")`, (row) => {
                        columns.push({
                            name: row[1] as string,
                            type: row[2] as string,
                            notnull: (row[3] as number) !== 0,
                            pk: (row[5] as number) !== 0,
                        });
                    });
                    out.push({ name, type, columns });
                }
                return out;
            });
        } catch (e) {
            throw classifyDbError(e);
        }
    }

    async loadFile(data: ArrayBuffer | Uint8Array): Promise<void> {
        const { sqlite3, db, capi, module } = this.#require();
        const m = module as {
            _malloc: (n: number) => number;
            _free: (p: number) => void;
            HEAPU8: Uint8Array;
        };

        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);

        // Copy bytes into WASM memory. SQLITE_DESERIALIZE_FREEONCLOSE
        // transfers ownership to sqlite — once deserialize succeeds we
        // must NOT free. sqlite calls `sqlite3_free` on the buffer on
        // close; in this Emscripten build it's wired to the same heap as
        // `_malloc`, so the ownership transfer is safe.
        const dataPtr = m._malloc(bytes.byteLength);
        m.HEAPU8.set(bytes, dataPtr);

        // Null-terminated UTF-8 "main" schema name.
        const schemaBytes = new TextEncoder().encode('main\0');
        const schemaPtr = m._malloc(schemaBytes.byteLength);
        m.HEAPU8.set(schemaBytes, schemaPtr);

        let rc;
        try {
            rc = capi.deserialize(
                db,
                schemaPtr,
                dataPtr,
                bytes.byteLength,
                bytes.byteLength,
                SQLITE_DESERIALIZE_FREEONCLOSE | SQLITE_DESERIALIZE_RESIZEABLE,
            );
        } finally {
            // schemaPtr is copied internally by sqlite; safe to free.
            m._free(schemaPtr);
        }
        if (rc !== 0) {
            // sqlite3 did not take ownership on failure; free the buffer ourselves.
            m._free(dataPtr);
            throw new Error(`sqlite3_deserialize failed (rc=${rc})`);
        }
        // dataPtr is now owned by sqlite (FREEONCLOSE) — do not free.
        void sqlite3; // silence unused-binding lint without restructuring.
    }

    /**
     * Inverse of `loadFile`: snapshot the open database to a byte buffer.
     * Useful for tests that need a `.sqlite` blob to feed back into
     * `loadFile()`, and for exporting `:memory:` databases.
     *
     * The returned bytes own their own heap allocation — the underlying
     * sqlite-malloc buffer is freed before we return.
     */
    async serialize(): Promise<Uint8Array> {
        const { capi, module } = this.#require();
        const db = this.#db!;
        const m = module as {
            _malloc: (n: number) => number;
            _free: (p: number) => void;
            HEAPU8: Uint8Array;
        };
        const schemaBytes = new TextEncoder().encode('main\0');
        const schemaPtr = m._malloc(schemaBytes.byteLength);
        m.HEAPU8.set(schemaBytes, schemaPtr);
        const sizePtr = m._malloc(8);
        try {
            const dataPtr = capi.serialize(db, schemaPtr, sizePtr, 0);
            if (dataPtr === 0) {
                throw new Error('sqlite3_serialize returned null (out of memory or empty schema)');
            }
            // `sqlite3_serialize`'s out-size is sqlite3_int64; read as
            // little-endian. Assumes sizes < 2^53 (true for any practical
            // browser-side DB).
            const size = new DataView(m.HEAPU8.buffer, sizePtr, 8).getUint32(0, true);
            const out = new Uint8Array(size);
            out.set(m.HEAPU8.subarray(dataPtr, dataPtr + size));
            capi.free(dataPtr);
            return out;
        } finally {
            m._free(schemaPtr);
            m._free(sizePtr);
        }
    }

    async seed(options?: WaSeedOptions): Promise<WaSeedSummary> {
        const { sqlite3, db } = this.#require();
        return seedRetailWa(sqlite3, db, options);
    }

    /**
     * Compile a SQL string and verify it's a single read-only statement.
     * Returns `{ok:true}` if so, `{ok:false, error}` otherwise. Does NOT
     * execute the statement.
     */
    async validateQuery(sql: string): Promise<QueryValidation> {
        const { sqlite3, capi } = this.#require();
        const db = this.#db!;
        try {
            return await this.#withFirstStatement(sql, async (stmt, sqlConsumed) => {
                if (!stmt) return { ok: false, error: 'Empty statement.' };
                if (capi.stmt_readonly(stmt) === 0) {
                    return { ok: false, error: 'Only read-only statements are allowed.' };
                }
                const tail = trailingSqlAfter(sql, sqlConsumed);
                if (tail.trim().length > 0) {
                    return { ok: false, error: 'Multiple statements are not allowed.' };
                }
                return { ok: true };
            });
        } catch (e) {
            // Compilation errors land here — surface them as the validation error.
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
        } finally {
            void sqlite3;
            void db;
        }
    }

    /**
     * Run a read-only SELECT/WITH/EXPLAIN. Cap is 20 — used for LLM-facing
     * samples. For unbounded action execution call `execFull`.
     */
    async execQuery(sql: string, limit = 20): Promise<QueryResult> {
        return this.#execWithCap(sql, Math.max(1, Math.min(limit, 20)), true);
    }

    /**
     * Read-only query for the action executor — used when materializing a
     * saved Action against real data.
     */
    async execFull(sql: string, hardLimit = 100_000): Promise<QueryResult> {
        return this.#execWithCap(sql, Math.max(1, hardLimit), true);
    }

    /**
     * Arbitrary single-statement SQL (read-only or not) for the SQL debug
     * viewer. Returns rows when the statement produces them, plus `changes`
     * for DML.
     */
    async execRaw(sql: string, limit = 1000): Promise<QueryResult & { changes: number }> {
        const result = await this.#execWithCap(sql, Math.max(1, limit), false);
        const { sqlite3, db } = this.#require();
        return { ...result, changes: sqlite3.changes(db) };
    }

    async #execWithCap(sql: string, cap: number, readonly: boolean): Promise<QueryResult> {
        const { sqlite3, db, capi } = this.#require();
        void db; // retained for symmetry — unused in this function body
        // Retry transient cross-tab SQLITE_BUSY/LOCKED with backoff. The VFS
        // time-shares one exclusive OPFS handle between tabs, so a contended
        // open/step can briefly report BUSY (see ./busy.ts).
        return retryOnBusy(() =>
            this.#withFirstStatement(sql, async (stmt, sqlConsumed) => {
                if (!stmt) throw new Error('Empty statement.');
                if (readonly && capi.stmt_readonly(stmt) === 0) {
                    throw new Error('Only read-only statements are allowed.');
                }
                const tail = trailingSqlAfter(sql, sqlConsumed);
                if (tail.trim().length > 0) {
                    throw new Error('Multiple statements are not allowed.');
                }
                // Constants the query compiles to — the author-supplied
                // values the LLM already sees in the SQL. The obfuscation
                // engine passes these through unmasked when they surface in an
                // expression column (see `#extractSqlLiterals` + columnOrigins).
                const sqlLiterals = await this.#extractSqlLiterals(sql);
                const colCount = sqlite3.column_count(stmt);
                const columns: string[] = [];
                // `sqlite3_column_decltype` is now exported by our wasi-sdk
                // wa-sqlite build (see CMakeLists.txt). Computed columns
                // (aggregates, expressions) come back as empty strings —
                // `ts-from-columns.ts` treats those as 'unknown' and falls
                // back to inferring affinity from sampled JS values.
                const declaredTypes: string[] = [];
                // Per-column base-table origin from sqlite3_column_origin_name
                // ('' = sqlite NULL = computed expression). Index-aligned to
                // `columns`; the sanitizer reads it to fence literal-passthrough
                // to expression columns only.
                const columnOrigins: string[] = [];
                for (let i = 0; i < colCount; i++) {
                    columns.push(sqlite3.column_name(stmt, i) ?? `col${i}`);
                    declaredTypes.push(capi.column_decltype(stmt, i));
                    columnOrigins.push(capi.column_origin_name(stmt, i));
                }
                const rows: Array<Record<string, unknown>> = [];
                let truncated = false;
                while ((await sqlite3.step(stmt)) === SQLite.SQLITE_ROW) {
                    if (rows.length >= cap) {
                        truncated = true;
                        break;
                    }
                    const row: Record<string, unknown> = {};
                    for (let i = 0; i < colCount; i++) {
                        row[columns[i]!] = sqlite3.column(stmt, i);
                    }
                    rows.push(row);
                }
                return {
                    columns,
                    declaredTypes,
                    columnOrigins,
                    sqlLiterals,
                    rows,
                    truncated,
                    rowLimit: cap,
                };
            }).catch((e: unknown) => {
                // A transient BUSY/LOCKED must reach retryOnBusy with its real
                // code intact — don't relabel it as "Invalid SQL".
                if (isBusyError(e)) throw e;
                // A corrupt/non-database file (SQLITE_NOTADB/CORRUPT) is not a
                // SQL problem — surface it as the recognisable unreadable-db
                // error instead of burying it under "Invalid SQL".
                const classified = classifyDbError(e);
                if (classified instanceof DataSourceUnreadableError) throw classified;
                throw new Error(`Invalid SQL: ${e instanceof Error ? e.message : String(e)}`);
            }),
        );
    }

    /**
     * Compile `sql` and hand the FIRST compiled statement to `fn`, together
     * with the substring sqlite actually consumed (for trailing-SQL checks).
     * The statement is finalized on return. Auto-drains and finalizes any
     * additional compiled statements (caller is expected to refuse them on
     * the trailing-SQL check).
     */
    async #withFirstStatement<T>(
        sql: string,
        fn: (stmt: number | null, sqlConsumed: string) => Promise<T>,
    ): Promise<T> {
        const { sqlite3 } = this.#require();
        const db = this.#db!;
        const iter = sqlite3
            .statements(db, sql, { unscoped: true } as unknown as undefined)
            [Symbol.asyncIterator]();
        const first = await iter.next();
        if (first.done) {
            // Empty SQL — no statement compiled.
            try {
                return await fn(null, '');
            } finally {
                // No-op return on the iterator drains any compiler state.
                await iter.return?.();
            }
        }
        const stmt = first.value as number;
        try {
            const compiledSql = sqlite3.sql(stmt);
            return await fn(stmt, compiledSql);
        } finally {
            await sqlite3.finalize(stmt);
            // Drain any additional compiled statements (if the source had
            // multiple). We can't avoid compiling them — `statements()`
            // yields one at a time, and to discover there's no "next" we
            // have to call `.next()` again.
            while (true) {
                const next = await iter.next();
                if (next.done) break;
                await sqlite3.finalize(next.value as number);
            }
        }
    }

    /**
     * Extract the distinct literal constants `sql` compiles to, by running it
     * through `EXPLAIN` and scanning the VDBE program for the opcodes that load
     * a constant into a register: `String8` (string), `Integer`/`Int64`
     * (integer), `Real`. SQLite's own parser does the lexing, so this is robust
     * against comments and `''`-escapes, and it sees *constant-folded* values
     * — `'Q' || '4 2023'` surfaces as one `String8 'Q4 2023'`, which a textual
     * tokenizer would miss. Values are stringified and deduped; the obfuscation
     * engine matches them against stringified cell values.
     *
     * This is the value-level half of the literal-passthrough signal; the
     * column-level half is `sqlite3_column_origin_name`. Both are required:
     * the literal set alone is a *global* whitelist that would un-mask real
     * data coinciding with a literal (e.g. a raw `status` column full of
     * `'shipped'` when the query says `WHERE status = 'shipped'`, or the
     * ubiquitous `0`/`1`/`100` from `LIMIT`/comparisons). Origin scoping fences
     * the set to expression columns so it can only ever exempt author
     * constants. See `sample-sanitizer.ts` for the intersection.
     *
     * Best-effort: any failure (malformed SQL — for which the main query
     * surfaces its own error — or an unexplainable statement) logs a warning
     * and yields an empty set, so the sanitizer simply falls back to masking
     * everything (the safe direction).
     */
    async #extractSqlLiterals(sql: string): Promise<string[]> {
        const { sqlite3 } = this.#require();
        const out = new Set<string>();
        try {
            await this.#withFirstStatement(`EXPLAIN ${sql}`, async (stmt) => {
                if (!stmt) return;
                const colCount = sqlite3.column_count(stmt);
                // EXPLAIN's column order is fixed (addr, opcode, p1, …, p4, …)
                // but resolve by name and fall back to the documented index so
                // a future sqlite layout change degrades rather than corrupts.
                const idxOf = new Map<string, number>();
                for (let i = 0; i < colCount; i++) {
                    const n = sqlite3.column_name(stmt, i);
                    if (n) idxOf.set(n, i);
                }
                const opcodeIdx = idxOf.get('opcode') ?? 1;
                const p1Idx = idxOf.get('p1') ?? 2;
                const p4Idx = idxOf.get('p4') ?? 5;
                while ((await sqlite3.step(stmt)) === SQLite.SQLITE_ROW) {
                    const opcode = sqlite3.column(stmt, opcodeIdx);
                    if (typeof opcode !== 'string') continue;
                    switch (opcode) {
                        case 'String8': {
                            // p4 holds the UTF-8 string literal.
                            const v = sqlite3.column(stmt, p4Idx);
                            if (typeof v === 'string') out.add(v);
                            break;
                        }
                        case 'Int64':
                        case 'Real': {
                            // p4 holds a text rendering of the numeric literal.
                            const v = sqlite3.column(stmt, p4Idx);
                            if (v !== null && v !== undefined) out.add(String(v));
                            break;
                        }
                        case 'Integer': {
                            // Small integer literal lives in p1, not p4.
                            const v = sqlite3.column(stmt, p1Idx);
                            if (v !== null && v !== undefined) out.add(String(v));
                            break;
                        }
                    }
                }
            });
        } catch (e) {
            console.warn(
                '[wa-sqlite] EXPLAIN literal extraction failed; obfuscation ' +
                    'will mask all columns for this query. ' +
                    (e instanceof Error ? e.message : String(e)),
            );
        }
        return [...out];
    }

    async getForeignKeys(table: string): Promise<ForeignKey[]> {
        const { sqlite3, db } = this.#require();
        const safe = table.replace(/"/g, '""');
        const out: ForeignKey[] = [];
        await sqlite3.exec(db, `PRAGMA foreign_key_list("${safe}")`, (row) => {
            // PRAGMA foreign_key_list columns (in order):
            // 0 id, 1 seq, 2 table, 3 from, 4 to, 5 on_update, 6 on_delete, 7 match
            const fromColumn = row[3] as string;
            const toTable = row[2] as string;
            const toColumn = (row[4] as string | null) ?? fromColumn;
            out.push({ column: fromColumn, refTable: toTable, refColumn: toColumn });
        });
        return out;
    }

    async close(): Promise<void> {
        if (this.#db && this.#sqlite3) {
            await this.#sqlite3.close(this.#db);
        }
        this.#db = null;
        this.#initPromise = null;
    }
}
