/**
 * Worker-side semantic embedding on the SHARED wa-sqlite module.
 *
 * The BGE encoder is compiled straight INTO wa-sqlite.wasm (see wasm/semantic +
 * CMakeLists.txt), so the C `vector_search` vtab embeds its query phrase with a
 * direct in-module call (`analyst_embed_query` -> `sem_embed` in
 * runtime_shim.c) — there is NO JS embed hook. This module covers the two
 * things that still need JS:
 *
 *   1. loading the GGUF weights into the module once (`sem_init`), gated so a
 *      DB with no semantic index never pays the ~33 MB download; and
 *   2. the async batch INDEX embedder (`embedTexts`) the semantic-index builder
 *      drives through `accessor.embed()`.
 *
 * Both the query path (C) and these JS paths share ONE model: `getWaSqlite()`
 * caches the module as a worker singleton, so `sem_init` runs at most once per
 * worker and the ~132 MB resident weights are shared across every open DB.
 *
 * Browser/worker only (it fetches weights + writes wasm memory). Node/vitest
 * never calls these, so `sem_init` never runs there and the C query path
 * returns "not warmed" — exactly the behaviour the Node vector tests assert.
 */
import { getWaSqlite } from './db';

/**
 * Q8_0 (~33 MB, near-lossless) is the shipped default. Mirrors the bge-embed
 * standalone loader; the engine also accepts the F16/F32 GGUF if changed here.
 */
const EMBED_GGUF_URL = new URL('@/assets/models/bge-small-en-v1.5-q8_0.gguf', import.meta.url);

/**
 * The auto-exposed (`_`-prefixed) wasm exports we need off the shared module
 * object — `sem_*` from the in-tree semantic engine plus malloc/free/HEAPU8.
 */
interface SemModule {
    HEAPU8: Uint8Array;
    _malloc: (n: number) => number;
    _free: (p: number) => void;
    _sem_init: (ptr: number, len: number) => number;
    _sem_embed: (textPtr: number, textLen: number, outPtr: number) => number;
    _sem_dim: () => number;
    _sem_strerror: (rc: number) => number;
}

const encoder = new TextEncoder();

let warmPromise: Promise<void> | null = null;
// Embedding dimensionality (sem_dim(), 384 for bge-small) — set once warm.
let dim = 0;

async function getSemModule(): Promise<SemModule> {
    const { module } = await getWaSqlite();
    return module as SemModule;
}

function readCStr(m: SemModule, ptr: number): string {
    if (!ptr) return '';
    const mem = m.HEAPU8;
    let end = ptr;
    while (mem[end] !== 0 && end < mem.length) end++;
    return new TextDecoder().decode(mem.subarray(ptr, end));
}

/**
 * Fetch the BGE GGUF and load it into the shared wa-sqlite module via
 * `sem_init`. Idempotent + latched: concurrent/repeat calls share one boot; a
 * failure clears the latch so a later call retries (mirrors the old
 * warmupBgeEmbed). After it resolves the C query path and `embedTexts` are ready.
 */
export function warmSemanticModel(): Promise<void> {
    warmPromise ??= doWarm().catch((err) => {
        warmPromise = null;
        throw err;
    });
    return warmPromise;
}

async function doWarm(): Promise<void> {
    const m = await getSemModule();
    const res = await fetch(EMBED_GGUF_URL, { cache: 'force-cache' });
    if (!res.ok) throw new Error(`[semantic-embed] fetch gguf failed (HTTP ${res.status})`);
    const gguf = new Uint8Array(await res.arrayBuffer());

    // Stage the GGUF into wasm memory and hand it to sem_init. The engine copies
    // the weights it needs (it does not retain the buffer), so free the staging
    // copy right after. The HEAPU8 getter re-reads the view if malloc grew memory.
    const ptr = m._malloc(gguf.byteLength);
    if (!ptr) throw new Error('[semantic-embed] malloc for gguf failed');
    m.HEAPU8.set(gguf, ptr);
    const rc = m._sem_init(ptr, gguf.byteLength);
    m._free(ptr);
    if (rc !== 0) {
        throw new Error(
            `[semantic-embed] sem_init failed: ${readCStr(m, m._sem_strerror(rc))} (${rc})`,
        );
    }
    dim = m._sem_dim();
}

/**
 * Embed `texts` in the worker thread (warming the model first if needed): RAW
 * passages (NO query prefix — the C wrapper adds the BGE retrieval prefix only
 * for queries), CLS-pooled + L2-normalized `sem_dim()` vectors. This is the
 * async batch embedder the semantic-index builder drives via accessor.embed().
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    await warmSemanticModel();
    const m = await getSemModule();

    const out = m._malloc(dim * 4);
    if (!out) throw new Error('[semantic-embed] malloc for output failed');
    try {
        const result: number[][] = [];
        for (const text of texts) {
            const bytes = encoder.encode(text);
            const tptr = m._malloc(Math.max(1, bytes.byteLength));
            if (!tptr) throw new Error('[semantic-embed] malloc for text failed');
            try {
                m.HEAPU8.set(bytes, tptr);
                const rc = m._sem_embed(tptr, bytes.byteLength, out);
                if (rc !== 0) {
                    throw new Error(
                        `[semantic-embed] sem_embed failed: ${readCStr(m, m._sem_strerror(rc))} (${rc})`,
                    );
                }
                // Re-read the view AFTER the call (sem_embed allocates scratch and
                // may have grown memory, detaching any earlier view). `out` stays
                // valid — pointers survive growth; only typed-array views detach.
                const f = new Float32Array(m.HEAPU8.buffer, out, dim);
                result.push(Array.from(f));
            } finally {
                m._free(tptr);
            }
        }
        return result;
    } finally {
        m._free(out);
    }
}

/**
 * Fire-and-forget: if `db` carries a semantic index (`_rhvec_search_map`
 * exists), proactively warm the embedder so `vector_search` is ready before the
 * user asks a question. Gated so non-semantic DBs cost nothing. Never throws
 * into the caller — it runs detached.
 */
export function maybeWarmSemanticSearch(db: {
    execRaw: (sql: string, limit?: number) => Promise<{ rows: unknown[] }>;
}): void {
    if (warmPromise) return;
    void (async () => {
        try {
            const r = await db.execRaw(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='_rhvec_search_map' LIMIT 1",
                1,
            );
            if (r.rows.length > 0) {
                warmSemanticModel().catch((e) => console.error('[semantic-embed] warm failed', e));
            }
        } catch (e) {
            console.error('[semantic-embed] semantic-index warm probe failed', e);
        }
    })();
}
