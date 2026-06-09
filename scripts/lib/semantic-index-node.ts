/**
 * Node-side semantic index builder for the demo-data pipeline.
 *
 * The browser builds `_rhvec_*` indexes online via bge-embed (single-thread
 * C WASM in the wa-sqlite DedicatedWorker). This PREBUILDS the identical
 * artifacts at `make demo-data` time: same model (BAAI/bge-small-en-v1.5, q8),
 * same `vector_init` + `vector_quantize` + `_rhvec_search_map` commit, just
 * driven by a transformers.js pipeline running under Node (no COOP/COEP,
 * multi-thread ORT → thousands of passages/s).
 *
 * Shared by `build-demo-retail.ts` (indexes the in-memory `WaSqliteDb` before
 * serialize) and `build-demo-index.ts` (post-processes a finished `.sqlite`).
 * Reuses the production engine logic in
 * `src/lib/data-sources/semantic-index-core.ts` so the prebuilt index is
 * byte-for-byte the shape the browser query path expects.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { pipeline, env, type FeatureExtractionPipeline } from '@huggingface/transformers';
import type { WaSqliteDb } from '../../src/lib/wa-sqlite/db.ts';
import {
    type Embedder,
    EMBED_MODEL,
    buildColumnIndex,
    findSemanticCandidates,
} from '../../src/lib/data-sources/semantic-index-core.ts';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
/** Repo root (scripts/lib/ → ../../). */
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..');
/** The deploy tree `make transformers` lays the ONNX models into. */
const ASSET_BASE = resolve(REPO_ROOT, 'src/assets/transformers');

interface ManifestEmbeddings {
    model_id: string;
    dtype: string;
}

function readEmbeddingsEntry(): ManifestEmbeddings {
    const manifestPath = resolve(ASSET_BASE, 'manifest.json');
    let raw: string;
    try {
        raw = readFileSync(manifestPath, 'utf8');
    } catch {
        throw new Error(
            `Transformers assets not found at ${manifestPath}. ` +
                `Run \`make transformers\` first to export the BGE embeddings model.`,
        );
    }
    const manifest = JSON.parse(raw) as { models?: { embeddings?: ManifestEmbeddings } };
    const emb = manifest.models?.embeddings;
    if (!emb?.model_id) {
        throw new Error(`manifest.json has no models.embeddings entry (at ${manifestPath})`);
    }
    return emb;
}

/** A warmed Node embedder plus a disposer. */
export interface NodeEmbedder {
    embed: Embedder;
    modelId: string;
    dispose(): void;
}

/**
 * Warm a transformers.js feature-extraction pipeline against the locally-built
 * ONNX assets (same model + dtype the browser ships, read from manifest.json).
 * Returns an `embed()` matching the core {@link Embedder} contract: CLS pooling
 * + L2 normalize, one `number[]` per input — compatible with the browser's
 * bge-embed query path (same model weights, close enough for cosine search).
 */
export async function createNodeEmbedder(): Promise<NodeEmbedder> {
    const entry = readEmbeddingsEntry();

    // Pin transformers.js to the local deploy tree; never hit the HF CDN. This
    // mirrors the worker's applyGlobalEnv(), minus the browser cacheKey/wasmPaths.
    env.localModelPath = ASSET_BASE + '/';
    env.allowRemoteModels = false;
    env.allowLocalModels = true;

    // dtype comes from manifest.json (e.g. 'q8'); transformers.js types it as a
    // DataType union, so cast through the pipeline options shape.
    const pipe = (await pipeline('feature-extraction', entry.model_id, {
        dtype: entry.dtype as 'q8' | 'fp32' | 'fp16' | 'int8' | 'uint8',
    })) as FeatureExtractionPipeline;

    // Clamp the tokenizer to the model's real context (the shipped config says
    // 1e19, which crashes ORT on long input). Mirrors worker.applyMaxLengthFix.
    const cfg = (pipe.model as { config?: { max_position_embeddings?: number } }).config;
    const max = cfg?.max_position_embeddings;
    if (typeof max === 'number' && max > 0) {
        (
            pipe.tokenizer as { _tokenizerConfig?: { model_max_length?: number } }
        )._tokenizerConfig!.model_max_length = max;
    }

    const embed: Embedder = async (texts) => {
        if (!texts.length) return [];
        const out = await pipe(texts, { pooling: 'cls', normalize: true });
        return out.tolist() as number[][];
    };

    return {
        embed,
        modelId: entry.model_id,
        dispose: () => {
            pipe.dispose().catch((e: unknown) => {
                console.error('failed to dispose embedder pipeline:', e);
            });
        },
    };
}

/**
 * Return every `{table, col}` pair that qualifies for semantic indexing without
 * building any indexes. Same candidate filter as `indexAllTables` (base tables,
 * not `__rh_meta_tables`, high-cardinality free-text, safe identifier). Tables
 * whose names trip `assertSafeIdentifier` (e.g. northwind's "Order Details")
 * are silently skipped.
 *
 * Cheap to call on a read-only db (no writes, just COUNT DISTINCT queries).
 */
export async function findAllCandidates(
    db: WaSqliteDb,
): Promise<Array<{ table: string; col: string }>> {
    const schema = await db.getSchema();
    const tables = schema
        .filter((t) => t.type === 'table' && t.name !== '__rh_meta_tables')
        .map((t) => t.name);

    const results: Array<{ table: string; col: string }> = [];
    for (const table of tables) {
        let candidates: string[];
        try {
            candidates = await findSemanticCandidates(db, table);
        } catch {
            continue;
        }
        for (const col of candidates) results.push({ table, col });
    }
    return results;
}

/**
 * Prebuild semantic indexes for every high-cardinality free-text column of
 * every base table in `db`, using `embed`. Mirrors the browser's
 * `indexSourceForSearch` → `autoIndexHighCardText` walk (base tables only, skip
 * views + meta + already-hidden `_rhvec_*`), minus the OPFS-handoff retry that
 * a single-process Node build doesn't need. Returns the `table.column` pairs
 * indexed. Per-column failures are logged and skipped, never fatal.
 */
/**
 * Index every semantic candidate column of one base table, appending each
 * `table.column` built to `indexed`. Per-column failures are logged and
 * skipped; a table whose name isn't a bare identifier (trips
 * `assertSafeIdentifier`, e.g. northwind's "Order Details") is logged and
 * skipped wholesale. Never throws — one bad table/column can't abort the walk.
 */
async function indexTableColumns(
    db: WaSqliteDb,
    table: string,
    embed: Embedder,
    log: (msg: string) => void,
    indexed: string[],
): Promise<void> {
    let candidates: string[];
    try {
        candidates = await findSemanticCandidates(db, table);
    } catch (e) {
        log(`  skipped table ${table}: ${e instanceof Error ? e.message : String(e)}`);
        return;
    }
    for (const col of candidates) {
        try {
            const t0 = Date.now();
            const n = await buildColumnIndex(db, table, col, embed);
            const ms = Date.now() - t0;
            const rate = ms > 0 ? Math.round((n / ms) * 1000) : n;
            log(
                `  indexed ${table}.${col} — ${n.toLocaleString()} rows in ${ms} ms (${rate.toLocaleString()}/s)`,
            );
            indexed.push(`${table}.${col}`);
        } catch (e) {
            log(`  FAILED ${table}.${col}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
}

export async function indexAllTables(
    db: WaSqliteDb,
    embed: Embedder,
    opts?: { log?: (msg: string) => void },
): Promise<string[]> {
    const log = opts?.log ?? (() => {});
    const schema = await db.getSchema();
    const tables = schema
        .filter((t) => t.type === 'table' && t.name !== '__rh_meta_tables')
        .map((t) => t.name);

    const indexed: string[] = [];
    for (const table of tables) {
        await indexTableColumns(db, table, embed, log, indexed);
    }
    log(`  model: ${EMBED_MODEL} → ${indexed.length} column(s) indexed`);
    return indexed;
}
