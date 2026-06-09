/**
 * Browser/worker loader for the NER head of `semantic.wasm` — the self-contained,
 * single-thread C BERT engine (see wasm/semantic/). The SAME wasm binary the
 * bge-embed runtime uses for embeddings runs token-classification here, driven by
 * a different GGUF (gravitee-io/bert-small-pii-detection, which carries a
 * `classifier.weight` head, so `sem_init` loads it as a TOKEN_CLS model).
 *
 * This replaces the transformers.js + onnxruntime-web NER pipeline in the
 * production path: tokenize (WordPiece) + 4-layer BERT encoder + per-token
 * classifier + softmax/argmax run entirely in wasm, returning per content token a
 * label id, score, and the [start,end) BYTE offsets into the input. BIO
 * aggregation + char mapping live in ./decode.ts.
 *
 * Reactor wasi-sdk module (same loader shape as bge-embed): the only imports are
 * WASI stdio stubs (referenced by snprintf, never called on the inference path),
 * satisfied by @bjorn3/browser_wasi_shim.
 *
 * `warmupBertNer()` does the async work (fetch the .wasm + the GGUF, sem_init);
 * after it resolves `inferTokensSync()` returns tokens with NO Promise.
 */
import { WASI, File, OpenFile, ConsoleStdout } from '@bjorn3/browser_wasi_shim';
import type { NerToken } from './decode';

interface SemExports {
    memory: WebAssembly.Memory;
    _initialize?: () => void;
    malloc: (n: number) => number;
    free: (p: number) => void;
    /** (ggufPtr, len) -> 0 on success, negative sem error code. */
    sem_init: (ptr: number, len: number) => number;
    /** SEM_KIND_EMBED (0) | SEM_KIND_TOKEN_CLS (1), or <0 if not initialized. */
    sem_kind: () => number;
    /** classifier label count (51 for the PII model). */
    sem_num_labels: () => number;
    /**
     * (textPtr, textLen, outPtr, maxTokens) -> content-token count written (>=0)
     * or negative error. `out` is 4*maxTokens int32 slots: labels | starts |
     * ends | scores(float bits). See semantic.h.
     */
    sem_ner_infer: (textPtr: number, textLen: number, outPtr: number, maxTokens: number) => number;
    sem_strerror: (rc: number) => number; // -> C string ptr
}

const SEM_KIND_TOKEN_CLS = 1;
/** Model context is 512 incl. [CLS]/[SEP]; content tokens fit well under this. */
const MAX_TOKENS = 512;

/**
 * Resolved URL of the NER GGUF asset (fetch + cache/size probes). Computed lazily
 * inside a function — NOT at module load — so importing this module under Node/
 * vitest (where the `@/` asset alias isn't a real path) never trips. Mirrors the
 * bge-embed loader's in-function `new URL(...)`.
 */
export function nerGgufUrl(): string {
    return new URL('@/assets/models/bert-small-pii-detection-q8_0.gguf', import.meta.url).href;
}

/**
 * Browser Cache the GGUF persists into, so a later session loads it instantly and
 * Settings can show "✓ Downloaded" without booting the model. Mirrors how
 * transformers.js cached the ONNX under env.cacheKey.
 */
export const NER_CACHE_NAME = 'semantic-ner-model';

/**
 * GGUF magic: the file starts with the ASCII bytes "GGUF". We validate this on
 * every fetch AND on cache hits, because the dev server answers an unknown asset
 * path with the SPA index.html (HTTP 200) — so a `/pii` visit BEFORE `make
 * ner-model` produced the file would otherwise cache that HTML under the GGUF URL
 * and serve it forever (the "malformed GGUF" bug). Validating + evicting bad
 * entries makes the loader self-heal on the next load.
 */
function isGgufBytes(b: Uint8Array): boolean {
    return b.length >= 4 && b[0] === 0x47 && b[1] === 0x47 && b[2] === 0x55 && b[3] === 0x46;
}

/** Source loaders, overridable for Node/vitest (no HTTP server, read from fs). */
export interface BertNerLoaders {
    wasm: () => Promise<Response> | Response | BufferSource | Promise<BufferSource>;
    gguf: () => Promise<Uint8Array> | Uint8Array;
}

const defaultLoaders: BertNerLoaders = {
    wasm: () => fetch(new URL('@/assets/wasm/semantic.wasm', import.meta.url)),
    gguf: async () => {
        const url = nerGgufUrl();
        const fetchFresh = async (): Promise<Uint8Array> => {
            const res = await fetch(url);
            const bytes = new Uint8Array(await res.arrayBuffer());
            if (!res.ok || !isGgufBytes(bytes)) {
                throw new Error(
                    `[bert-ner] ${url} did not return a GGUF (HTTP ${res.status}, ` +
                        `content-type ${res.headers.get('content-type') ?? '?'}, ${bytes.length} bytes). ` +
                        `Run \`make ner-model\` and hard-reload.`,
                );
            }
            return bytes;
        };
        // Persist into a named Cache so isNerModelCached() can probe it and a
        // repeat boot skips the network. Falls back to a plain fetch where the
        // Cache API is unavailable.
        if (typeof caches !== 'undefined') {
            const cache = await caches.open(NER_CACHE_NAME);
            const hit = await cache.match(url);
            if (hit) {
                const cached = new Uint8Array(await hit.arrayBuffer());
                if (isGgufBytes(cached)) return cached;
                // Poisoned entry (e.g. an SPA-fallback HTML cached before the asset
                // existed) — evict and refetch.
                await cache.delete(url);
            }
            const bytes = await fetchFresh();
            // Store the validated bytes (not res.clone() — the body is consumed).
            await cache.put(
                url,
                new Response(bytes, {
                    headers: {
                        'content-type': 'application/octet-stream',
                        'content-length': String(bytes.byteLength),
                    },
                }),
            );
            return bytes;
        }
        return fetchFresh();
    },
};

/**
 * True if a VALID GGUF is already in the browser Cache (instant next boot). A
 * poisoned/HTML entry counts as not-cached (and the loader will evict it).
 * Best-effort: false on any error.
 */
export async function isNerModelCached(): Promise<boolean> {
    if (typeof caches === 'undefined') return false;
    try {
        const cache = await caches.open(NER_CACHE_NAME);
        const hit = await cache.match(nerGgufUrl());
        if (!hit) return false;
        return isGgufBytes(new Uint8Array(await hit.arrayBuffer()));
    } catch (e) {
        console.error('[bert-ner] cache probe failed:', e);
        return false;
    }
}

let loaders = defaultLoaders;
let exports: SemExports | null = null;
let numLabels = 0;
let warmupPromise: Promise<void> | null = null;

const encoder = new TextEncoder();

/** Override where the wasm + gguf bytes come from. Call before warmup. */
export function setBertNerLoaders(next: Partial<BertNerLoaders>): void {
    if (warmupPromise) throw new Error('[bert-ner] setBertNerLoaders called after warmup started');
    loaders = { ...loaders, ...next };
}

/** True once `warmupBertNer()` has resolved and `inferTokensSync()` is callable. */
export function isBertNerReady(): boolean {
    return exports !== null;
}

/** Classifier label count (51) once warmed, else 0. */
export function nerNumLabels(): number {
    return numLabels;
}

/**
 * Fetch + instantiate the wasm, load the NER GGUF, and run sem_init. Idempotent:
 * concurrent/repeat calls share one boot; a failure clears the cached promise so
 * a later call retries (mirrors warmupBgeEmbed()).
 */
export function warmupBertNer(): Promise<void> {
    warmupPromise ??= doWarmup().catch((err) => {
        warmupPromise = null;
        throw err;
    });
    return warmupPromise;
}

async function doWarmup(): Promise<void> {
    // WASI: inference does no I/O, but snprintf pulls in fd_write/seek/close refs.
    const fds = [
        new OpenFile(new File([])),
        ConsoleStdout.lineBuffered((m: string) => console.log('[bert-ner]', m)),
        ConsoleStdout.lineBuffered((m: string) => console.warn('[bert-ner]', m)),
    ];
    const wasi = new WASI([], [], fds);
    const importObject = { wasi_snapshot_preview1: wasi.wasiImport };

    const source = await loaders.wasm();
    let inst: WebAssembly.Instance;
    if (
        source instanceof Uint8Array ||
        source instanceof ArrayBuffer ||
        (typeof SharedArrayBuffer !== 'undefined' && source instanceof SharedArrayBuffer)
    ) {
        inst = (await WebAssembly.instantiate(source as BufferSource, importObject)).instance;
    } else {
        inst = (
            await WebAssembly.instantiateStreaming(
                source as Response | Promise<Response>,
                importObject,
            )
        ).instance;
    }
    wasi.initialize(
        inst as unknown as { exports: { memory: WebAssembly.Memory; _initialize?: () => unknown } },
    );
    const exp = inst.exports as unknown as SemExports;

    const gguf = await loaders.gguf();
    const ptr = exp.malloc(gguf.byteLength);
    if (!ptr) throw new Error('[bert-ner] malloc for gguf failed');
    new Uint8Array(exp.memory.buffer).set(gguf, ptr);
    const rc = exp.sem_init(ptr, gguf.byteLength);
    exp.free(ptr);
    if (rc !== 0)
        throw new Error(
            `[bert-ner] sem_init failed: ${readCStr(exp, exp.sem_strerror(rc))} (${rc})`,
        );
    if (exp.sem_kind() !== SEM_KIND_TOKEN_CLS)
        throw new Error('[bert-ner] GGUF is not a token-classification model (no classifier head)');

    numLabels = exp.sem_num_labels();
    exports = exp;
}

/**
 * Classify `text` **synchronously**: returns one NerToken per content token (the
 * [CLS]/[SEP] framing excluded), each carrying its argmax label id, softmax
 * score, and [start,end) BYTE offsets into the UTF-8 input. BIO aggregation +
 * byte->char mapping happen in ./decode.ts. Throws if called before warmup.
 */
export function inferTokensSync(text: string): NerToken[] {
    const exp = exports;
    if (!exp)
        throw new Error('[bert-ner] inferTokensSync() called before warmupBertNer() resolved');
    const bytes = encoder.encode(text);

    const tptr = exp.malloc(Math.max(1, bytes.byteLength));
    if (!tptr) throw new Error('[bert-ner] malloc for text failed');
    // 4 int32 blocks of MAX_TOKENS: labels | starts | ends | scores.
    const outBytes = MAX_TOKENS * 4 * 4;
    const out = exp.malloc(outBytes);
    if (!out) {
        exp.free(tptr);
        throw new Error('[bert-ner] malloc for output failed');
    }
    try {
        new Uint8Array(exp.memory.buffer).set(bytes, tptr);
        const n = exp.sem_ner_infer(tptr, bytes.byteLength, out, MAX_TOKENS);
        if (n < 0) {
            throw new Error(
                `[bert-ner] sem_ner_infer failed: ${readCStr(exp, exp.sem_strerror(n))} (${n})`,
            );
        }
        if (n === 0) return [];
        // Re-read views AFTER the call (inference allocates scratch; memory may
        // have grown, detaching earlier views).
        const buf = exp.memory.buffer;
        const labels = new Int32Array(buf, out, n);
        const starts = new Int32Array(buf, out + MAX_TOKENS * 4, n);
        const ends = new Int32Array(buf, out + MAX_TOKENS * 8, n);
        const scores = new Float32Array(buf, out + MAX_TOKENS * 12, n);
        const tokens: NerToken[] = new Array(n);
        for (let i = 0; i < n; i++) {
            tokens[i] = { label: labels[i]!, score: scores[i]!, start: starts[i]!, end: ends[i]! };
        }
        return tokens;
    } finally {
        exp.free(out);
        exp.free(tptr);
    }
}

/** Drop the instance; `warmupBertNer()` must be called again afterwards. */
export function releaseBertNer(): void {
    exports = null;
    numLabels = 0;
    warmupPromise = null;
}

function readCStr(exp: SemExports, ptr: number): string {
    if (!ptr) return '';
    const mem = new Uint8Array(exp.memory.buffer);
    let end = ptr;
    while (mem[end] !== 0 && end < mem.length) end++;
    return new TextDecoder().decode(mem.subarray(ptr, end));
}
