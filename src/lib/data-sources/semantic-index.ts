/**
 * Semantic-search index builder — BROWSER orchestration.
 *
 * The engine-only logic (candidate selection, sidecar build, vector_init /
 * vector_quantize / map-row commit) lives in `./semantic-index-core.ts`, which
 * has NO browser-only imports (Node-safe leaf). This module adds the browser
 * pieces on top: the embedder (routed through the wa-sqlite DedicatedWorker to
 * avoid blocking the main thread), the Data-Sources progress banner, and the
 * transient-error retry that survives a mid-build worker respawn.
 *
 * Indexing runs UNCONDITIONALLY at import/seed time (autoIndexAfterImport) — the
 * Model2Vec static embedder makes it cheap (~free), so there is no opt-in gate and
 * no manual "Index for search" button anymore. Embedding runs via `sqliteEmbed()`
 * (the active embedder's C engine in the DedicatedWorker) in batches so a large
 * table never freezes the OPFS handle: read a page, release, embed (no lock held),
 * then a quick INSERT. Query-path and index-path share one model, so cosine search
 * is valid across them.
 */
import type { DataSource } from './types';
import { getSourceDb } from './db';
import { sqliteEmbed } from '@/lib/sqlite/client';
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
        // Progress is surfaced through `onProgress` to the blocking import/seed
        // popup that owns this build — there is no separate page-level banner.
        if (await buildColumnWithRetry(source, table, col, embed, opts?.onProgress)) {
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
            await buildColumnIndex(db, table, col, embed, onProgress);
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
            // Per-column failure is non-fatal: log it and keep indexing the rest.
            // The failed column stays invisible (no map row).
            console.warn(`[semantic-index] failed indexing ${table}.${col}:`, e);
            return false;
        }
    }
    return false;
}

/**
 * Best-effort auto-index of freshly imported tables. Runs UNCONDITIONALLY (no
 * opt-in gate) — the Model2Vec static embedder makes indexing cheap, and the model
 * only loads at all when a source actually has high-card free-text columns to
 * embed. **Awaited by the import/seed popups** so the dialog blocks (with progress)
 * until the indexes are built, then closes — better UX than a silent background
 * build. Overwritten tables are rebuilt (their rowids changed). Best-effort:
 * failures are logged + swallowed, never surfaced to the import outcome.
 */
export async function autoIndexAfterImport(
    source: DataSource,
    tables: ReadonlyArray<{ name: string; overwritten: boolean }>,
    onProgress?: (p: IndexProgress) => void,
): Promise<void> {
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
}
