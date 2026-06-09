import { WASI, File, OpenFile, ConsoleStdout } from '@bjorn3/browser_wasi_shim';

interface QJSExports {
    memory: WebAssembly.Memory;
    qjs_init: () => number;
    qjs_destroy: () => void;
    /**
     * (codePtr, codeLen) -> resultPtr.
     * codeLen is the byte length of the UTF-8-encoded code (no trailing null
     * required). The returned pointer addresses a buffer of exactly
     * `qjs_eval_last_len()` bytes; DO NOT strlen — embedded NULs are valid.
     */
    qjs_eval: (codePtr: number, codeLen: number) => number;
    qjs_eval_last_len: () => number;
    malloc: (size: number) => number;
    free: (ptr: number) => void;
}

let exports: QJSExports | null = null;
let initPromise: Promise<void> | null = null;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Source for the QuickJS WASM module. The default loader uses fetch on the
 * production asset URL; tests inject a bytes loader (fs.readFile) so they can
 * run the real QuickJS in Node without an HTTP server.
 */
export type WasmLoader = () => Promise<Response> | Response | BufferSource | Promise<BufferSource>;

let wasmLoader: WasmLoader = () => fetch(new URL('@/assets/wasm/qjs.wasm', import.meta.url));

/** Override the WASM source. MUST be called before `initQJS`. */
export function setWasmLoader(loader: WasmLoader): void {
    if (initPromise) {
        throw new Error('setWasmLoader called after initQJS has started');
    }
    wasmLoader = loader;
}

async function doInit(): Promise<void> {
    const fds = [
        new OpenFile(new File([])),
        ConsoleStdout.lineBuffered((m) => console.log('[qjs]', m)),
        ConsoleStdout.lineBuffered((m) => console.warn('[qjs]', m)),
    ];
    const wasi = new WASI([], [], fds);

    const source = await wasmLoader();
    const importObject = { wasi_snapshot_preview1: wasi.wasiImport };
    let inst: WebAssembly.Instance;
    if (
        source instanceof Uint8Array ||
        source instanceof ArrayBuffer ||
        (typeof SharedArrayBuffer !== 'undefined' && source instanceof SharedArrayBuffer)
    ) {
        const result = await WebAssembly.instantiate(source as BufferSource, importObject);
        inst = result.instance;
    } else {
        const { instance } = await WebAssembly.instantiateStreaming(
            source as Response | Promise<Response>,
            importObject,
        );
        inst = instance;
    }

    // Reactor mode: call _initialize before any exports.
    wasi.initialize(
        inst as unknown as {
            exports: {
                memory: WebAssembly.Memory;
                _initialize?: () => unknown;
            };
        },
    );
    exports = inst.exports as unknown as QJSExports;

    const rc = exports.qjs_init();
    if (rc !== 0) throw new Error(`qjs_init failed (${rc})`);
}

export function initQJS(): Promise<void> {
    if (!initPromise) initPromise = doInit();
    return initPromise;
}

/** Test-only: reset the singleton so the next `initQJS` uses a fresh module. */
export function _resetQJSForTesting(): void {
    exports = null;
    initPromise = null;
    wasmLoader = () => fetch(new URL('@/assets/wasm/qjs.wasm', import.meta.url));
}

function writeBytes(s: string): { ptr: number; len: number } {
    if (!exports) throw new Error('qjs not initialized');
    const bytes = encoder.encode(s);
    // +1 for a trailing NUL so older C consumers that expect a C string still
    // work; the new qjs_eval ignores it and uses the explicit length.
    const ptr = exports.malloc(bytes.length + 1);
    if (!ptr) throw new Error('malloc failed');
    const mem = new Uint8Array(exports.memory.buffer);
    mem.set(bytes, ptr);
    mem[ptr + bytes.length] = 0;
    return { ptr, len: bytes.length };
}

export function evalJS(code: string): string {
    if (!exports) throw new Error('qjs not initialized');
    const { ptr, len } = writeBytes(code);
    try {
        const outPtr = exports.qjs_eval(ptr, len);
        const outLen = exports.qjs_eval_last_len();
        const mem = new Uint8Array(exports.memory.buffer);
        return decoder.decode(mem.subarray(outPtr, outPtr + outLen));
    } finally {
        exports.free(ptr);
    }
}
