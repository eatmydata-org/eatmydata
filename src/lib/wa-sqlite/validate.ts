/**
 * Validation + error-classification for "is this actually a SQLite database".
 *
 * This module is deliberately leaf-level and dependency-free (no `wa-sqlite`
 * import, no WASM) so it is cheap to pull into the main thread (the demo
 * importer, the data-sources UI) as well as the worker.
 *
 * Two failure modes motivate it:
 *
 *  1. A demo asset that doesn't exist gets served by the dev server / a CDN
 *     SPA-fallback as `index.html` with HTTP 200. The bytes are HTML, not a
 *     database — `assertSqliteBytes` rejects them *before* they're written to
 *     OPFS or a `DataSource` row is registered.
 *  2. A file that opens lazily but is corrupt/truncated: sqlite only notices
 *     on the first real read and throws SQLITE_NOTADB ("file is not a
 *     database") / SQLITE_CORRUPT. Worker-side code classifies those into a
 *     {@link DataSourceUnreadableError}; this error's `name` survives the
 *     Comlink boundary (custom fields like `.code` do not), so main-thread
 *     consumers can recognise it via {@link isUnreadableDbError}.
 */

/** The 16-byte magic string at the start of every SQLite database file. */
export const SQLITE_HEADER = 'SQLite format 3\0';

/** SQLite result codes we treat as "this file is not a usable database". */
export const SQLITE_CORRUPT = 11;
export const SQLITE_NOTADB = 26;

/**
 * A data source whose backing file can't be opened as a SQLite database —
 * corrupt, truncated, or never a database to begin with (e.g. an HTML error
 * page saved as a `.sqlite`). Distinct from transient SQLITE_BUSY, which is
 * retryable; this is permanent for the file as-is. The `name` is set so it
 * survives Comlink's error serialization (which keeps only name/message/stack).
 */
export class DataSourceUnreadableError extends Error {
    /** Preserved cause for logging; not transferred across the worker boundary. */
    readonly originalError?: unknown;
    constructor(message: string, originalError?: unknown) {
        super(message);
        this.name = 'DataSourceUnreadableError';
        this.originalError = originalError;
    }
}

function toBytes(data: ArrayBuffer | Uint8Array): Uint8Array {
    return data instanceof Uint8Array ? data : new Uint8Array(data);
}

/** True iff the first 16 bytes are the SQLite magic header. */
export function looksLikeSqliteHeader(data: ArrayBuffer | Uint8Array): boolean {
    const bytes = toBytes(data);
    if (bytes.byteLength < SQLITE_HEADER.length) return false;
    for (let i = 0; i < SQLITE_HEADER.length; i++) {
        if (bytes[i] !== SQLITE_HEADER.charCodeAt(i)) return false;
    }
    return true;
}

/** A short, printable preview of the first bytes — turns "got HTML" into a
 *  legible diagnostic instead of a hex dump. Non-printable bytes become `.`. */
function previewBytes(bytes: Uint8Array, max = 24): string {
    let out = '';
    const n = Math.min(bytes.byteLength, max);
    for (let i = 0; i < n; i++) {
        const c = bytes[i]!;
        out += c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : '.';
    }
    if (bytes.byteLength > max) out += '…';
    return out;
}

/**
 * Throw {@link DataSourceUnreadableError} unless `data` begins with the SQLite
 * magic header. `label` is used in the message (e.g. the demo spec). Catches
 * the empty-file and "served an HTML page instead of the asset" cases before
 * anything is persisted.
 */
export function assertSqliteBytes(data: ArrayBuffer | Uint8Array, label: string): void {
    const bytes = toBytes(data);
    if (bytes.byteLength === 0) {
        throw new DataSourceUnreadableError(
            `${label} is empty (0 bytes) — the download likely failed.`,
        );
    }
    if (!looksLikeSqliteHeader(bytes)) {
        throw new DataSourceUnreadableError(
            `${label} is not a valid SQLite database — the file failed to ` +
                `download or was served as something else ` +
                `(starts with "${previewBytes(bytes)}").`,
        );
    }
}

const UNREADABLE_MESSAGE_RE =
    /\b(file is not a database|not a database|disk image is malformed|file is encrypted|is not a valid sqlite database)\b/i;

/**
 * Recognise an "unreadable database" failure on either side of the Comlink
 * boundary. Matches our own {@link DataSourceUnreadableError} (by `name`,
 * which survives serialization) and the raw sqlite messages for
 * SQLITE_NOTADB / SQLITE_CORRUPT / encrypted DBs (by `message`, since the
 * numeric `.code` does *not* survive serialization).
 */
export function isUnreadableDbError(e: unknown): boolean {
    if (!e) return false;
    if ((e as { name?: string }).name === 'DataSourceUnreadableError') return true;
    const msg = e instanceof Error ? e.message : String(e);
    return UNREADABLE_MESSAGE_RE.test(msg);
}

/** User-facing copy for a source whose file won't open. Single source of truth. */
export const UNREADABLE_DB_MESSAGE =
    'This data source is not a valid database. Its file may be corrupt or ' +
    'have failed to download. Delete it and re-import.';
