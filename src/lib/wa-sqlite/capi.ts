/**
 * Manual cwrap bindings for sqlite3 capi functions that wa-sqlite's JS
 * wrapper doesn't expose. Pass the Emscripten Module instance returned by
 * `SQLiteESMFactory()`. Each binding is a closure over `Module.cwrap`, so
 * this is cheap to call once per module instance and cache the result
 * alongside the wa-sqlite API.
 */

interface EmscriptenModuleLike {
    cwrap: <T>(name: string, returnType: string | null, argTypes: string[]) => T;
}

export interface ExtraCapi {
    /**
     * `sqlite3_stmt_readonly(stmt)` — returns non-zero if the prepared
     * statement makes no direct changes to the database. Used by
     * `execQuery`/`validateQuery` to refuse DDL/DML on the read-only paths.
     */
    stmt_readonly: (stmt: number) => number;

    /**
     * `sqlite3_column_decltype(stmt, iCol)` — declared type of the i-th
     * column in the most recent prepared statement, as a string (or null
     * if the column is computed / has no declared type). Used by
     * `execQuery` to populate `QueryResult.declaredTypes`, which
     * `ts-from-columns.ts` maps to TS primitive affinities.
     *
     * Returns `''` when sqlite returns NULL (computed columns). We never
     * pass a null back to JS callers — empty string is the canonical
     * "unknown" signal in `ts-from-columns`.
     */
    column_decltype: (stmt: number, iCol: number) => string;

    /**
     * `sqlite3_column_origin_name(stmt, iCol)` — the name of the base-table
     * column that the i-th result column maps to, or NULL when the column is
     * a computed expression (CASE, literal, aggregate, function call,
     * arithmetic, …). Requires the build to be compiled with
     * `SQLITE_ENABLE_COLUMN_METADATA` (see CMakeLists.txt).
     *
     * The obfuscation engine (`sample-sanitizer.ts`) uses this to fence its
     * literal-passthrough: only expression columns (NULL origin) are eligible
     * to pass an author-supplied SQL literal through unmasked. A non-NULL
     * origin means the column is raw data and is always sanitized — even if a
     * cell value happens to coincide with a literal in the query text.
     *
     * Returns `''` when sqlite returns NULL, mirroring `column_decltype` — we
     * never hand a null back to JS callers. Callers read `''` as "expression
     * column / no base-table origin".
     */
    column_origin_name: (stmt: number, iCol: number) => string;

    /**
     * `sqlite3_deserialize(db, zSchema, pData, szDb, szBuf, mFlags)` —
     * mounts an in-memory database from a contiguous byte buffer. Used by
     * `loadFile` to populate a `:memory:` connection from a .sqlite blob.
     */
    deserialize: (
        db: number,
        zSchema: number,
        pData: number,
        szDb: number,
        szBuf: number,
        mFlags: number,
    ) => number;

    /**
     * `sqlite3_serialize(db, zSchema, piSize, mFlags)` — returns a pointer
     * to a heap-allocated buffer containing the serialized database for
     * the named schema. Caller must `sqlite3_free()` the returned pointer
     * (unless SQLITE_SERIALIZE_NOCOPY was passed). Used by `serialize()`
     * to export `:memory:` databases as `.sqlite` blobs.
     */
    serialize: (db: number, zSchema: number, piSize: number, mFlags: number) => number;

    /** `sqlite3_free(ptr)` — release a buffer allocated by sqlite. */
    free: (ptr: number) => void;
}

export function bindExtraCapi(module: unknown): ExtraCapi {
    const m = module as EmscriptenModuleLike;
    return {
        stmt_readonly: m.cwrap<(stmt: number) => number>('sqlite3_stmt_readonly', 'number', [
            'number',
        ]),
        column_decltype: (function () {
            const raw = m.cwrap<(stmt: number, iCol: number) => string | null>(
                'sqlite3_column_decltype',
                'string',
                ['number', 'number'],
            );
            return (stmt: number, iCol: number): string => raw(stmt, iCol) ?? '';
        })(),
        column_origin_name: (function () {
            const raw = m.cwrap<(stmt: number, iCol: number) => string | null>(
                'sqlite3_column_origin_name',
                'string',
                ['number', 'number'],
            );
            return (stmt: number, iCol: number): string => raw(stmt, iCol) ?? '';
        })(),
        deserialize: m.cwrap<
            (
                db: number,
                zSchema: number,
                pData: number,
                szDb: number,
                szBuf: number,
                mFlags: number,
            ) => number
        >('sqlite3_deserialize', 'number', [
            'number',
            'number',
            'number',
            'number',
            'number',
            'number',
        ]),
        serialize: m.cwrap<(db: number, zSchema: number, piSize: number, mFlags: number) => number>(
            'sqlite3_serialize',
            'number',
            ['number', 'number', 'number', 'number'],
        ),
        free: m.cwrap<(ptr: number) => void>('sqlite3_free', null, ['number']),
    };
}

/** SQLITE_DESERIALIZE_* flags. */
export const SQLITE_DESERIALIZE_FREEONCLOSE = 1;
export const SQLITE_DESERIALIZE_RESIZEABLE = 2;

/**
 * SQLITE_SERIALIZE_NOCOPY (0x001): for in-memory databases, return a pointer
 * directly into the existing memory buffer rather than allocating a new copy.
 * The caller must NOT call sqlite3_free() on the returned pointer.
 */
export const SQLITE_SERIALIZE_NOCOPY = 0x001;
