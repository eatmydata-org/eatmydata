/**
 * Semantic-search index builder — BROWSER orchestration.
 *
 * The engine-only logic (candidate selection, sidecar build, vector_init /
 * vector_quantize / map-row commit) lives in `./semantic-index-core.ts`, which
 * has NO browser-only imports so the demo-data build scripts can PREBUILD the
 * same `_rhvec_*` artifacts under plain Node. This module adds the browser
 * pieces on top: the bge-embed embedder (routed through the wa-sqlite
 * DedicatedWorker to avoid blocking the main thread), the `semanticSearchEnabled`
 * gate, the Data-Sources progress banner, and the transient-error retry that
 * survives a mid-build worker respawn.
 *
 * Embedding runs via `sqliteEmbed()` — bge-embed C engine in the DedicatedWorker
 * — in batches so a large table never freezes the OPFS handle: we read a page,
 * release, embed (no lock held), then do a quick INSERT. Query-path and index-path
 * both use bge-embed, so cosine search is valid across them.
 */
import type { DataSource } from './types';
import { getSourceDb } from './db';
import { sqliteEmbed } from '@/lib/sqlite/client';
import { getSettings } from '@/lib/runtime/state/settings';
import {
    reportIndexStart,
    reportIndexProgress,
    reportIndexDone,
    reportIndexError,
} from './semantic-index-status';
import {
    type Embedder,
    type IndexProgress,
    buildColumnIndex,
    clearSemanticIndex,
    findSemanticCandidates,
    isAlreadyIndexed,
} from './semantic-index-core';

// Re-export the core surface so existing importers (tests, callers) keep
// resolving these from `./semantic-index`.
export {
    EMBED_DIM,
    EMBED_MODEL,
    type Embedder,
    type IndexDb,
    type IndexProgress,
    buildColumnIndex,
    clearSemanticIndex,
    findSemanticCandidates,
    isAlreadyIndexed,
    sidecarName,
} from './semantic-index-core';

/** Per-column build attempts before giving up on a transient OPFS/lock error. */
const INDEX_MAX_ATTEMPTS = 3;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Transient errors worth retrying with a fresh connection: the per-tab sqlite
 * worker can be torn down + respawned mid-build (HMR in dev, tab freeze/bfcache,
 * or cross-tab handoff), and the old worker's OPFS handle release can briefly
 * race the new worker's `createSyncAccessHandle` ("Access Handles cannot be
 * created if there is another open Access Handle…"), plus the usual
 * cross-tab SQLITE_BUSY/LOCKED. Re-resolving getSourceDb after a short backoff
 * picks up the respawned worker and the released handle.
 */
function isTransientDbError(e: unknown): boolean {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    return /access handle|createSyncAccessHandle|NoModificationAllowed|InvalidStateError|database is locked|SQLITE_BUSY|SQLITE_LOCKED|CANTOPEN/i.test(
        msg,
    );
}

/** bge-embed embedder via the wa-sqlite DedicatedWorker (non-blocking). */
function workerEmbedder(): Embedder {
    return (texts: string[]) => sqliteEmbed(texts);
}

/**
 * Auto-index every high-cardinality free-text column of `table`. With
 * `rebuild`, existing indexes for the table are cleared first (for an
 * overwritten table whose rowids changed); otherwise already-indexed columns
 * are skipped. Returns the columns indexed this run.
 */
export async function autoIndexHighCardText(
    source: DataSource,
    table: string,
    opts?: { rebuild?: boolean; onProgress?: (p: IndexProgress) => void },
): Promise<string[]> {
    const db = await getSourceDb(source);
    if (opts?.rebuild) await clearSemanticIndex(db, table);
    const candidates = await findSemanticCandidates(db, table);
    const embed = workerEmbedder();
    const indexed: string[] = [];
    for (const col of candidates) {
        if (!opts?.rebuild && (await isAlreadyIndexed(db, table, col))) continue;
        // Surface live progress to the Data Sources page; a column is reported
        // `done` only after buildColumnIndex atomically commits its map row.
        reportIndexStart(source.id, source.name, table, col);
        if (await buildColumnWithRetry(source, table, col, embed, opts?.onProgress)) {
            reportIndexDone(source.id, table, col);
            indexed.push(col);
        }
    }
    return indexed;
}

/**
 * Build one column's index, retrying transient OPFS/lock errors with a fresh
 * connection. Returns true on success, false after a non-fatal failure (which
 * is reported + logged). Extracted from {@link autoIndexHighCardText} verbatim
 * — same attempt budget, backoff, and reporting — to keep the loop's cognitive
 * complexity bounded.
 */
async function buildColumnWithRetry(
    source: DataSource,
    table: string,
    col: string,
    embed: Embedder,
    onProgress?: (p: IndexProgress) => void,
): Promise<boolean> {
    for (let attempt = 1; attempt <= INDEX_MAX_ATTEMPTS; attempt++) {
        try {
            // Re-resolve each attempt: a worker torn down mid-build (HMR /
            // freeze / cross-tab handoff) respawns here with a fresh handle.
            // buildColumnIndex restarts cleanly (drops the sidecar + map row
            // up front), so a retry is idempotent.
            const db = await getSourceDb(source);
            await buildColumnIndex(db, table, col, embed, (p) => {
                reportIndexProgress(source.id, table, col, p.done, p.total);
                onProgress?.(p);
            });
            return true;
        } catch (e) {
            if (attempt < INDEX_MAX_ATTEMPTS && isTransientDbError(e)) {
                console.warn(
                    `[semantic-index] transient error indexing ${table}.${col} (attempt ${attempt}); retrying`,
                    e,
                );
                await sleep(250 * attempt);
                continue;
            }
            // Per-column failure is non-fatal: report it and keep indexing
            // the rest. The failed column stays invisible (no map row).
            reportIndexError(source.id, table, col, e instanceof Error ? e.message : String(e));
            console.warn(`[semantic-index] failed indexing ${table}.${col}:`, e);
            return false;
        }
    }
    return false;
}

/**
 * On-demand (re)index of an already-loaded source — the counterpart to
 * autoIndexAfterImport for a source that's already in OPFS (a demo imported
 * before indexing existed, or before the user opted in). UNLIKE the import
 * path it is NOT gated on the `semanticSearchEnabled` setting: the user
 * clicked "Index for search", so the click IS the opt-in. Ensures the BGE
 * model is cached first (downloads once if absent), then indexes the
 * high-cardinality free-text columns of every base table. Already-indexed
 * columns are skipped (idempotent). Returns the `table.column` pairs indexed
 * this run. Progress streams to the Data Sources banner via the same
 * report* hooks autoIndexHighCardText uses.
 */
export async function indexSourceForSearch(source: DataSource): Promise<string[]> {
    const db = await getSourceDb(source);
    const schema = await db.getSchema();
    // getSchema already hides sqlite_* and _rhvec_* objects; also skip our meta
    // table and views (only base tables carry embeddable rows + stable rowids).
    const tables = schema
        .filter((t) => t.type === 'table' && t.name !== '__rh_meta_tables')
        .map((t) => t.name);
    const indexed: string[] = [];
    for (const name of tables) {
        const cols = await autoIndexHighCardText(source, name);
        for (const c of cols) indexed.push(`${name}.${c}`);
    }
    return indexed;
}

/**
 * Best-effort, non-blocking auto-index of freshly imported tables. Gated on the
 * `semanticSearchEnabled` setting (off by default) — a user who hasn't opted in
 * never pays a model download or embedding cost. When on, the BGE model is
 * ensured via the Cache API (downloaded once if absent), then high-card text
 * columns are embedded in the background. Overwritten tables are rebuilt (their
 * rowids changed). Failures are logged, never surfaced to the import outcome.
 */
export function autoIndexAfterImport(
    source: DataSource,
    tables: ReadonlyArray<{ name: string; overwritten: boolean }>,
    onProgress?: (p: IndexProgress) => void,
): void {
    if (!getSettings().semanticSearchEnabled) return;
    void (async () => {
        try {
            for (const t of tables) {
                await autoIndexHighCardText(source, t.name, {
                    rebuild: t.overwritten,
                    onProgress,
                });
            }
        } catch (e) {
            console.warn('[semantic-index] auto-index after import failed:', e);
        }
    })();
}
