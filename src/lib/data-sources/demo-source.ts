import { importDemoIntoOpfs, getSqliteDb, destroySqliteOpfs } from '@/lib/sqlite/client';
import { assertSqliteBytes, DataSourceUnreadableError } from '@/lib/wa-sqlite/validate';
import { DEMO_ABOUT, type DemoSpec } from './about';
import { putTableMeta } from './db';
import { listSources, makeDataSourceId, makeDbFile, putSource, takenDbLeaves } from './store';
import { dedupHumanName } from './identifier';
import { autoIndexAfterImport } from './semantic-index';
import type { DataSource } from './types';

export type DemoProgress = {
    /** Bytes downloaded so far. */
    loaded: number;
    /**
     * Total bytes expected. May be 0 if the server omits Content-Length;
     * the UI should fall back to an indeterminate spinner in that case.
     */
    total: number;
};

export type CreateDemoOptions = {
    onProgress?(p: DemoProgress): void;
    /** Override the AbortSignal — lets the dialog cancel mid-download. */
    signal?: AbortSignal;
};

// `DEMO_ASSET_BASE` is injected by vite.config.ts: `/<content-hash>/demo` in
// a build, `/src/assets/demo` in dev. The content-hash keeps the URL stable
// across releases when the demo `.sqlite` files are unchanged, so deploy can
// skip re-uploading ~235 MB of databases.
const ASSET_BASE = DEMO_ASSET_BASE;

/**
 * Download a pre-built demo .sqlite from `/demo/<spec>.sqlite`, drop it
 * straight into the OPFS SAH pool, register a DataSource row pointing at
 * it, and stamp the `__rh_meta_tables` rows so the Tables tab on the
 * Data Sources page treats it the same way as imported sources.
 *
 * Persistence is forced to `'persistent'` — downloading 100 MB only to
 * have it disappear on tab close is wasteful. The dialog doesn't expose
 * a persistence picker for demos.
 *
 * Idempotent on the OPFS side: if a slot already exists for the chosen
 * `dbFile`, `pool.importDb` overwrites it.
 */
export async function createDemoSource(
    spec: DemoSpec,
    displayName: string,
    opts: CreateDemoOptions = {},
): Promise<DataSource> {
    const about = DEMO_ABOUT[spec];
    const id = makeDataSourceId();
    const now = Date.now();
    // Dedup against existing source names + OPFS leaves so the user sees
    // unique display names and the OPFS file gets a unique snake_case leaf.
    const all = await listSources();
    const takenNames = new Set(all.map((s) => s.name));
    const finalDisplayName = dedupHumanName(displayName, takenNames);
    const dbFile = makeDbFile(finalDisplayName, 'persistent', takenDbLeaves(all), id);
    const source: DataSource = {
        id,
        name: finalDisplayName,
        dbFile,
        kind: 'demo',
        persistence: 'persistent',
        demoSpec: spec,
        isDefault: false,
        createdAt: now,
        updatedAt: now,
    };

    // 1. Download with progress reporting (streamed if the server cooperates).
    const bytes = await fetchWithProgress(
        `${ASSET_BASE}/${spec}.sqlite`,
        opts.onProgress,
        opts.signal,
        about.fileSizeBytesApprox,
    );

    // 1a. Reject non-databases BEFORE touching OPFS or registering a row. A
    //     missing `/demo/<spec>.sqlite` is served by the dev server / a CDN as
    //     the SPA-fallback `index.html` (HTTP 200 with HTML), and a half-
    //     finished download is truncated — either would register a source that
    //     can never be opened and (historically) wedged the whole viewer.
    assertSqliteBytes(bytes, `Demo "${spec}"`);

    // 2. Materialize into OPFS — no schema sniffing, no DDL, no indexes.
    //    The pool's importDb replaces the file verbatim. The helper
    //    drops the caller-side `dbProxies[dbFile]` entry (which would
    //    otherwise reference the SqliteDb instance the worker is about
    //    to close as part of import) and transfers ownership of the
    //    ArrayBuffer through Comlink so 100 MB demos don't
    //    structured-clone-copy across the SharedWorker boundary.
    await importDemoIntoOpfs(dbFile, dbFile, bytes);

    // 2a. A valid header doesn't prove the rest of the file is intact. Probe
    //     the freshly-written OPFS db; if it won't open, unlink it and bail
    //     WITHOUT registering a row — better no source than a broken one.
    try {
        const db = await getSqliteDb(dbFile, { filename: dbFile });
        await db.assertReadable();
    } catch (e) {
        try {
            await destroySqliteOpfs(dbFile, dbFile);
        } catch (cleanupErr) {
            console.warn(`[demo] rollback of unreadable import "${dbFile}" failed`, cleanupErr);
        }
        throw e instanceof DataSourceUnreadableError
            ? e
            : new DataSourceUnreadableError(
                  `Demo "${spec}" downloaded but could not be opened as a database.`,
                  e,
              );
    }

    // 3. Persist the row + table meta so the Tables tab finds them. Only now
    //    that the file is proven openable — so a failed download never leaves
    //    a registered, unopenable source behind.
    await putSource(source);
    const originalFileName = `(demo: ${spec})`;
    for (const t of about.tables) {
        try {
            await putTableMeta(source, {
                tableName: t.name,
                originalFileName,
                importedAt: now,
            });
        } catch {
            // Best-effort: tables list in About may include rows that the
            // upstream DB doesn't actually have (e.g. zero-row optional
            // tables). Stamp what we can and continue.
        }
    }

    // Best-effort, non-blocking: embed high-cardinality free-text columns (e.g.
    // retail `claims.description`) so vector_search works on the demo too. Gated
    // inside on the `semanticSearchEnabled` setting, so it no-ops unless the user
    // opted in. Demo tables are freshly written, so none are "overwritten".
    autoIndexAfterImport(
        source,
        about.tables.map((t) => ({ name: t.name, overwritten: false })),
    );
    return source;
}

/**
 * Fetch a binary asset with optional progress reporting. Falls back to
 * `response.arrayBuffer()` when the runtime can't stream — caller still
 * sees the loaded=total update at the end.
 */
async function fetchWithProgress(
    url: string,
    onProgress: ((p: DemoProgress) => void) | undefined,
    signal: AbortSignal | undefined,
    sizeHint: number,
): Promise<ArrayBuffer> {
    const res = await fetch(url, { signal });
    if (!res.ok) {
        throw new Error(`Failed to download demo asset ${url}: HTTP ${res.status}`);
    }
    const total = Number(res.headers.get('Content-Length')) || sizeHint || 0;

    if (!res.body || !onProgress) {
        const buf = await res.arrayBuffer();
        onProgress?.({ loaded: buf.byteLength, total: total || buf.byteLength });
        return buf;
    }

    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.byteLength;
        onProgress({ loaded, total });
    }
    // Concatenate into a single ArrayBuffer; ~100 MB is fine in a single
    // contiguous buffer in the browser.
    const merged = new Uint8Array(loaded);
    let offset = 0;
    for (const c of chunks) {
        merged.set(c, offset);
        offset += c.byteLength;
    }
    return merged.buffer;
}
