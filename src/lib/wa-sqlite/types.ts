/**
 * Public types for the sqlite engine. Lives in a leaf module so consumers
 * can import the shapes without pulling in the WASM-loading machinery.
 */

export interface ColumnInfo {
    name: string;
    type: string;
    notnull: boolean;
    pk: boolean;
}

export interface TableSchema {
    name: string;
    type: 'table' | 'view';
    columns: ColumnInfo[];
}

export interface ForeignKey {
    column: string;
    refTable: string;
    refColumn: string;
}

export interface QueryValidation {
    ok: boolean;
    error?: string;
}

export interface QueryResult {
    columns: string[];
    /**
     * Per-column declared SQL type from `sqlite3_column_decltype`. Empty
     * string for computed columns (aggregates, expressions) where sqlite has
     * no declared type to trace back to. Currently always empty under
     * wa-sqlite — `_sqlite3_column_decltype` isn't in the default build's
     * exports; consumers (`ts-from-columns.ts`) fall back to inferring
     * affinity from sampled JS values.
     */
    declaredTypes: string[];
    /**
     * Per-column base-table origin from `sqlite3_column_origin_name`, aligned
     * by index to `columns`. A base-table column name means the column
     * projects raw data; an empty string means sqlite returned NULL — i.e. the
     * column is a computed expression (CASE, literal, aggregate, function,
     * arithmetic). The obfuscation engine (`sample-sanitizer.ts`) reads this
     * to fence its literal-passthrough to expression columns only.
     *
     * Index-aligned, so it survives `normalizeQueryResultColumns`'s positional
     * rename. Optional: present whenever produced by `execQuery`; a missing or
     * undefined value makes the sanitizer mask every column (the safe
     * default), so callers that synthesize a `QueryResult` need not supply it.
     */
    columnOrigins?: string[];
    /**
     * Distinct literal constants the query compiles to, extracted from the
     * VDBE program via `EXPLAIN` (String8 / Integer / Int64 / Real operands),
     * stringified. This is the set of author-supplied values the LLM already
     * sees in the SQL; the obfuscation engine passes a cell through unmasked
     * only when its value is in this set AND its column is an expression
     * column (see `columnOrigins`). Column-independent. Optional, same
     * contract as `columnOrigins`.
     */
    sqlLiterals?: string[];
    rows: Array<Record<string, unknown>>;
    truncated: boolean;
    rowLimit: number;
}

export interface SqliteDbInitOptions {
    /**
     * sqlite filename. Defaults to `:memory:`. Pass a plain OPFS leaf
     * name (e.g. `ds_abc.sqlite`) to open against OPFSCoopSyncVFS.
     */
    filename?: string;
    /**
     * Legacy hint preserved for back-compat with the previous opfs-sahpool
     * VFS — ignored under wa-sqlite + OPFSCoopSyncVFS, which is registered
     * as the default and used whenever `filename` is not `:memory:`.
     */
    vfs?: string;
}
