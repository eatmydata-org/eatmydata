/**
 * Browser/worker loader for bge-embed.wasm — the self-contained, single-thread
 * C inference engine for bge-small-en-v1.5 (see wasm/bge-embed/). It replaces
 * the bare-ORT `sync-embed.ts` path for SYNCHRONOUS query embedding: the C
 * module tokenizes (WordPiece), runs the BERT encoder, CLS-pools and
 * L2-normalizes entirely in wasm, so there is no ORT ABI to transcribe and no
 * transformers.js tokenizer to load — just the GGUF weights + the .wasm.
 *
 * Reactor wasi-sdk module (same toolchain/loader shape as src/libs/qjs.ts): the
 * only imports are WASI stdio stubs (referenced by snprintf, never called on
 * the embed path), satisfied by @bjorn3/browser_wasi_shim. Everything else is
 * malloc/free + the bge_* exports operating on one flat linear memory.
 *
 * `warmupBgeEmbed()` does the async work (fetch the .wasm + the GGUF, call
 * bge_init); after it resolves `embedTextsSync()` returns vectors with NO
 * Promise — safe to call from inside a synchronous SQLite `xFilter`.
 */
import { WASI, File, OpenFile, ConsoleStdout } from '@bjorn3/browser_wasi_shim';

interface BgeExports {
    memory: WebAssembly.Memory;
    _initialize?: () => void;
    malloc: (n: number) => number;
    free: (p: number) => void;
    /** (ggufPtr, len) -> 0 on success, negative sem error code. */
    sem_init: (ptr: number, len: number) => number;
    /** (textPtr, textLen, outPtr) -> 0 on success; writes sem_dim() floats. */
    sem_embed: (textPtr: number, textLen: number, outPtr: number) => number;
    sem_dim: () => number;
    sem_strerror: (rc: number) => number; // -> C string ptr
}

/** Source loaders, overridable for Node/vitest (no HTTP server, read from fs). */
export interface BgeLoaders {
    /** The compiled bge-embed.wasm bytes (or a Response to stream). */
    wasm: () => Promise<Response> | Response | BufferSource | Promise<BufferSource>;
    /** The bge-small-en-v1.5 F16 GGUF weight bytes. */
    gguf: () => Promise<Uint8Array> | Uint8Array;
}

const defaultLoaders: BgeLoaders = {
    wasm: () => fetch(new URL('@/assets/wasm/semantic.wasm', import.meta.url)),
    gguf: async () => {
        // Q8_0 (~33 MB, near-lossless) is the shipped default; the engine also
        // accepts the F16/F32 GGUF if the default is changed here.
        const url = new URL('@/assets/models/bge-small-en-v1.5-q8_0.gguf', import.meta.url);
        const res = await fetch(url, { cache: 'force-cache' });
        if (!res.ok) throw new Error(`[bge-embed] fetch gguf failed (HTTP ${res.status})`);
        return new Uint8Array(await res.arrayBuffer());
    },
};

let loaders = defaultLoaders;
let exports: BgeExports | null = null;
let dim = 0;
let warmupPromise: Promise<void> | null = null;

const encoder = new TextEncoder();

/** Override where the wasm + gguf bytes come from. Call before warmup. */
export function setBgeLoaders(next: Partial<BgeLoaders>): void {
    if (warmupPromise) throw new Error('[bge-embed] setBgeLoaders called after warmup started');
    loaders = { ...loaders, ...next };
}

/** True once `warmupBgeEmbed()` has resolved and `embedTextsSync()` is callable. */
export function isBgeEmbedReady(): boolean {
    return exports !== null;
}

/** Output dimensionality (384) once warmed, else 0. */
export function bgeDim(): number {
    return dim;
}

/**
 * Fetch + instantiate the wasm, load the GGUF, and run bge_init. Idempotent:
 * concurrent/repeat calls share one boot; a failure clears the cached promise
 * so a later call retries (mirrors warmupSyncEmbed()).
 */
export function warmupBgeEmbed(): Promise<void> {
    warmupPromise ??= doWarmup().catch((err) => {
        warmupPromise = null;
        throw err;
    });
    return warmupPromise;
}

async function doWarmup(): Promise<void> {
    // WASI: the embed path does no I/O, but snprintf pulls in fd_write/seek/close
    // refs. A console-backed stdio (as in qjs.ts) satisfies them harmlessly.
    const fds = [
        new OpenFile(new File([])),
        ConsoleStdout.lineBuffered((m: string) => console.log('[bge-embed]', m)),
        ConsoleStdout.lineBuffered((m: string) => console.warn('[bge-embed]', m)),
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
    // Reactor mode: run _initialize before any export.
    wasi.initialize(
        inst as unknown as { exports: { memory: WebAssembly.Memory; _initialize?: () => unknown } },
    );
    const exp = inst.exports as unknown as BgeExports;

    // Stage the GGUF bytes into wasm memory and hand them to bge_init. bge_init
    // copies the weights it needs (it does not retain the buffer), so we free
    // the staging copy right after.
    const gguf = await loaders.gguf();
    const ptr = exp.malloc(gguf.byteLength);
    if (!ptr) throw new Error('[bge-embed] malloc for gguf failed');
    // Re-acquire the heap view AFTER malloc (it may have grown memory).
    new Uint8Array(exp.memory.buffer).set(gguf, ptr);
    const rc = exp.sem_init(ptr, gguf.byteLength);
    exp.free(ptr);
    if (rc !== 0)
        throw new Error(
            `[bge-embed] sem_init failed: ${readCStr(exp, exp.sem_strerror(rc))} (${rc})`,
        );

    dim = exp.sem_dim();
    exports = exp;
}

/**
 * Embed one or more strings **synchronously**: CLS-pooled, L2-normalized 384-dim
 * vectors (the C does the pooling + norm). Throws if called before warmup.
 * Matches the ONNX `embedSync` signature so it is a drop-in for the host hook.
 */
export function embedTextsSync(texts: string | string[]): number[][] {
    const exp = exports;
    if (!exp)
        throw new Error('[bge-embed] embedTextsSync() called before warmupBgeEmbed() resolved');
    const list = Array.isArray(texts) ? texts : [texts];
    if (list.length === 0) return [];

    const out = exp.malloc(dim * 4);
    if (!out) throw new Error('[bge-embed] malloc for output failed');
    try {
        const result: number[][] = [];
        for (const text of list) {
            const bytes = encoder.encode(text);
            const tptr = exp.malloc(Math.max(1, bytes.byteLength));
            if (!tptr) throw new Error('[bge-embed] malloc for text failed');
            try {
                new Uint8Array(exp.memory.buffer).set(bytes, tptr);
                const rc = exp.sem_embed(tptr, bytes.byteLength, out);
                if (rc !== 0) {
                    throw new Error(
                        `[bge-embed] sem_embed failed: ${readCStr(exp, exp.sem_strerror(rc))} (${rc})`,
                    );
                }
                // Re-read the view AFTER the call (sem_embed allocates scratch and
                // may have grown memory, detaching any earlier view).
                const f = new Float32Array(exp.memory.buffer, out, dim);
                result.push(Array.from(f));
            } finally {
                exp.free(tptr);
            }
        }
        return result;
    } finally {
        exp.free(out);
    }
}

/** Drop the instance; `warmupBgeEmbed()` must be called again afterwards. */
export function releaseBgeEmbed(): void {
    exports = null;
    dim = 0;
    warmupPromise = null;
}

function readCStr(exp: BgeExports, ptr: number): string {
    if (!ptr) return '';
    const mem = new Uint8Array(exp.memory.buffer);
    let end = ptr;
    while (mem[end] !== 0 && end < mem.length) end++;
    return new TextDecoder().decode(mem.subarray(ptr, end));
}

// --- testbed bench ---------------------------------------------------------

export interface BgeBenchResult {
    label: string;
    /** First (untimed) inference latency — ms. */
    warmupMs: number;
    passages: number;
    msPerPassage: number;
    passagesPerSec: number;
    /** L2-normalized embeddings of the `samples` set, for the quality cross-check. */
    sampleVectors: number[][];
}

/**
 * Throughput + quality measurement for the embeddings testbed. Mirrors
 * benchEmbedVariants' single-bracket timing (one performance.now() span over
 * `repeats` sweeps) so the numbers sit directly alongside the ONNX variants.
 * Assumes warmupBgeEmbed() has resolved.
 */
export function benchBgeEmbed(
    corpus: string[],
    samples: string[],
    opts?: { repeats?: number; onLog?: (m: string) => void },
): BgeBenchResult {
    if (!isBgeEmbedReady()) throw new Error('[bge-embed] benchBgeEmbed() before warmup');
    const repeats = Math.max(1, opts?.repeats ?? 1);
    const log = opts?.onLog ?? (() => {});

    const w0 = performance.now();
    const sampleVectors = embedTextsSync(samples);
    const warmupMs = performance.now() - w0;

    const t0 = performance.now();
    for (let r = 0; r < repeats; r++) embedTextsSync(corpus);
    const totalMs = performance.now() - t0;

    const totalPasses = repeats * corpus.length;
    const msPerPassage = totalPasses > 0 ? totalMs / totalPasses : 0;
    const passagesPerSec = totalMs > 0 ? (totalPasses / totalMs) * 1000 : 0;
    log(
        `[bge-embed] ${msPerPassage.toFixed(1)} ms/passage (${passagesPerSec.toFixed(1)} passages/s)`,
    );
    return {
        label: 'bge-embed/q8_0-f32-simd-fma',
        warmupMs,
        passages: corpus.length,
        msPerPassage,
        passagesPerSec,
        sampleVectors,
    };
}
