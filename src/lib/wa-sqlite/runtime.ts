/**
 * Module factory for the wasi-sdk-built `public/wa-sqlite.wasm`. Produces
 * an Emscripten-shaped `Module` object that the upstream wa-sqlite JS
 * surface (`src/sqlite-api.js`, `src/FacadeVFS.js`, `src/examples/*VFS.js`)
 * can consume without modification.
 *
 * Two non-obvious responsibilities:
 *
 * 1. i64 legalization. wasi-sdk emits native `i64` params/results; the
 *    committed wa-sqlite JS layer was written against Emscripten's
 *    legalized convention (i64 returns split into i32 lo + `getTempRet0()`
 *    hi; i64 args split into two i32 slots). `cwrap` checks the
 *    actual export arity vs the declared arity to detect legalization
 *    callers and recombines / splits BigInts at the boundary.
 *
 * 2. The 16 libadapters dispatch imports (`ipp`, `ippp`, `vppp`, ...,
 *    `vppippii`, each with a `_async` variant). The C trampolines call
 *    these via plain `extern` declarations — we read the C-string method
 *    name from the second arg, look up the JS receiver (registered via
 *    `setCallback`), and invoke `receiver[method](...rest)` synchronously.
 *    The `_async` variants exist for the Asyncify build only; we route
 *    them through the same sync path because OPFSCoopSyncVFS is all sync.
 */

const WASM_URL = new URL('@/assets/wasm/wa-sqlite.wasm', import.meta.url);

interface FactoryOptions {
    wasmBinary?: ArrayBuffer | Uint8Array;
}

type Pointer = number;
type FunctionPointer = number;

type WasmExports = Record<string, WebAssembly.ExportValue> & {
    memory: WebAssembly.Memory;
    _initialize: () => void;
    malloc: (n: number) => Pointer;
    free: (p: Pointer) => void;
    sqlite3_malloc: (n: number) => Pointer;
    sqlite3_free: (p: Pointer) => void;
    analyst_wa_init: () => number;
};

export interface WaSqliteModule {
    HEAPU8: Uint8Array;
    HEAP32: Int32Array;
    HEAPU32: Uint32Array;
    _malloc: (n: number) => Pointer;
    _free: (p: Pointer) => void;
    _sqlite3_malloc: (n: number) => Pointer;
    _sqlite3_free: (p: Pointer) => void;
    _getSqliteFree: () => FunctionPointer;
    cwrap: (
        name: string,
        returnType: string | null,
        argTypes: string[] | null,
        opts?: { async?: boolean },
    ) => (...args: unknown[]) => unknown;
    ccall: (
        name: string,
        returnType: string | null,
        argTypes: string[] | null,
        args: unknown[],
    ) => unknown;
    getValue: (ptr: Pointer, type: string) => number;
    setValue: (ptr: Pointer, value: number, type: string) => void;
    getTempRet0: () => number;
    UTF8ToString: (ptr: Pointer, maxBytesToRead?: number) => string;
    setCallback: (key: Pointer, target: unknown) => void;
    getCallback: (key: Pointer) => unknown;
    deleteCallback: (key: Pointer) => void;
    vfs_register: (vfs: unknown, makeDefault: boolean) => number;
    create_function: (
        db: Pointer,
        zFunctionName: string,
        nArg: number,
        eTextRep: number,
        pApp: Pointer,
        xFunc: ((ctx: Pointer, argc: number, values: Pointer) => void) | null,
        xStep: ((ctx: Pointer, argc: number, values: Pointer) => void) | null,
        xFinal: ((ctx: Pointer) => void) | null,
    ) => number;
    progress_handler: (
        db: Pointer,
        nOps: number,
        xProgress: ((pApp: Pointer) => number) | null,
        userData: Pointer,
    ) => void;
    commit_hook: (db: Pointer, xCommitHook: (() => number) | null) => void;
    update_hook: (
        db: Pointer,
        xUpdateHook:
            | ((type: number, dbName: string, tblName: string, lo32: number, hi32: number) => void)
            | null,
    ) => void;
    set_authorizer: (
        db: Pointer,
        xAuthorizer:
            | ((
                  pApp: Pointer,
                  iAction: number,
                  p3: string,
                  p4: string,
                  p5: string,
                  p6: string,
              ) => number)
            | null,
        pApp: Pointer,
    ) => number;
    handleAsync: ((fn: () => unknown) => unknown) | null;
    retryOps: unknown[];
    pendingOps: unknown[];
    // Auto-populated _sqlite3_* accessors land here; declared as an open shape.
    [key: string]: unknown;
}

const SIGNATURES = [
    'ipp',
    'ippp',
    'vppp',
    'ipppj',
    'ipppi',
    'ipppp',
    'ipppip',
    'vpppip',
    'ippppi',
    'ippppij',
    'ipppiii',
    'ippppip',
    'ippipppp',
    'ipppppip',
    'ipppiiip',
    'vppippii',
] as const;

async function fetchWasm(): Promise<ArrayBuffer> {
    if (typeof process !== 'undefined' && process.versions?.node) {
        const { readFile } = await import('node:fs/promises');
        const { fileURLToPath } = await import('node:url');
        // In Node (vitest), the `WASM_URL` we built above is rooted at the
        // module's location — fileURLToPath gives us a disk path. In
        // production we resolve via vite's static asset map so this branch
        // is dev/test-only.
        const path = fileURLToPath(new URL('@/assets/wasm/wa-sqlite.wasm', import.meta.url));
        const bytes = await readFile(path);
        return bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer;
    }
    const resp = await fetch(WASM_URL);
    if (!resp.ok) {
        throw new Error(
            `failed to fetch wa-sqlite.wasm at ${WASM_URL.href}: ${resp.status} ${resp.statusText}`,
        );
    }
    return await resp.arrayBuffer();
}

/**
 * Build the wasi_snapshot_preview1 import table. wa-sqlite never actually
 * does file I/O through wasi (the VFS layer hijacks it from JS at the
 * SQLite VFS layer), but wasi-libc's startup path still calls a handful
 * of these — `environ_sizes_get` / `environ_get` (getenv), `random_get`,
 * `clock_time_get`, `fd_close` on stdio.
 *
 * Provide minimal correct implementations: zero env vars, real randomness,
 * monotonically increasing clock, no-op stdio. proc_exit must not actually
 * abort (sqlite3_os_init calls getenv, which is fine if env is empty).
 */
function wasiStub(
    getMemory: () => WebAssembly.Memory,
): Record<string, (...args: number[]) => number> {
    const NOSYS = 52;
    const ERRNO_BADF = 8;
    const u8 = () => new Uint8Array(getMemory().buffer);
    const dv = () => new DataView(getMemory().buffer);
    return {
        environ_get: (_argv: number, _buf: number) => 0,
        environ_sizes_get: (countOut: number, sizeOut: number) => {
            const d = dv();
            d.setUint32(countOut, 0, true);
            d.setUint32(sizeOut, 0, true);
            return 0;
        },
        args_get: (_argv: number, _buf: number) => 0,
        args_sizes_get: (countOut: number, sizeOut: number) => {
            const d = dv();
            d.setUint32(countOut, 0, true);
            d.setUint32(sizeOut, 0, true);
            return 0;
        },
        clock_time_get: (
            _clockId: number,
            _precision: number,
            _precision2: number,
            timeOut: number,
        ) => {
            const ns = BigInt(Date.now()) * 1_000_000n;
            dv().setBigUint64(timeOut, ns, true);
            return 0;
        },
        random_get: (bufPtr: number, bufLen: number) => {
            const view = u8().subarray(bufPtr, bufPtr + bufLen);
            if (typeof crypto === 'undefined' || !crypto.getRandomValues) {
                // Every context we run in (browser, workers, Node ≥18) has Web
                // Crypto; fail loudly rather than fall back to a weak PRNG.
                throw new Error('random_get: crypto.getRandomValues unavailable');
            }
            // getRandomValues caps at 65536 bytes per call — chunk larger buffers.
            let off = 0;
            while (off < view.length) {
                const chunk = view.subarray(off, Math.min(off + 65536, view.length));
                crypto.getRandomValues(chunk);
                off += chunk.length;
            }
            return 0;
        },
        // Stdio / FS — never used (VFS overrides), but a few sqlite3.c
        // startup paths peek at fd 0/1/2. Make them benign.
        fd_close: () => 0,
        fd_fdstat_get: () => 0,
        fd_fdstat_set_flags: () => 0,
        fd_filestat_get: () => ERRNO_BADF,
        fd_filestat_set_size: () => ERRNO_BADF,
        fd_prestat_get: () => ERRNO_BADF,
        fd_prestat_dir_name: () => ERRNO_BADF,
        fd_read: () => ERRNO_BADF,
        fd_seek: () => ERRNO_BADF,
        fd_sync: () => 0,
        fd_write: () => 0,
        path_create_directory: () => NOSYS,
        path_filestat_get: () => NOSYS,
        path_filestat_set_times: () => NOSYS,
        path_open: () => NOSYS,
        path_readlink: () => NOSYS,
        path_remove_directory: () => NOSYS,
        path_unlink_file: () => NOSYS,
        poll_oneoff: () => NOSYS,
        proc_exit: (code: number) => {
            throw new Error(
                `wa-sqlite: wasi proc_exit(${code}) called — should not happen with VFS routing`,
            );
        },
    } as Record<string, (...args: number[]) => number>;
}

/**
 * Build the libadapters dispatch table — 32 imports (16 signatures, each
 * with a `_async` companion). Each call has the signature
 *   (target_ptr, method_name_ptr, ...rest)
 * The C trampolines pass `target_ptr` as the registered receiver key (the
 * sqlite3_vfs* / pApp / etc. allocated on the wasm heap) and a C-string
 * pointer naming which method to invoke.
 *
 * Receivers can be either functions (then invoke directly with `rest`) or
 * objects with a method named by the C string. Sync only — the upstream
 * Asyncify path is not wired through this runtime.
 */
/**
 * Split an i64 (BigInt at the WASM boundary) into the (lo32, hi32) signed-
 * int pair the committed wa-sqlite JS surface expects. wa-sqlite was
 * written for Emscripten's legalized ABI — `FacadeVFS.xRead(pFile, pData,
 * iAmt, iOffsetLo, iOffsetHi)` takes two i32s; with wasi-sdk's native i64
 * the same C call would pass one BigInt. We legalize at the dispatch
 * boundary so the JS surface stays unchanged.
 *
 * Both halves are signed-i32 (Emscripten's convention) — `| 0` truncates
 * and reinterprets the sign bit. The downstream `delegalize` helper in
 * FacadeVFS undoes this correctly for both halves.
 */
function legalizeI64(big: bigint): [number, number] {
    const lo = Number(big & 0xffffffffn) | 0;
    const hi = Number((big >> 32n) & 0xffffffffn) | 0;
    return [lo, hi];
}

function buildAdapters(getModule: () => WaSqliteModule) {
    const adapters: Record<string, (...args: unknown[]) => number | void> = {};
    for (const sig of SIGNATURES) {
        // Pre-compute which argument positions (0-indexed across the C
        // arg list, including the leading two `p`s for target + method
        // name) are `j` so the hot dispatch path doesn't re-scan the
        // signature string per call.
        const argTypes = sig.slice(1);
        const j64Positions: number[] = [];
        for (let i = 0; i < argTypes.length; i++) {
            if (argTypes[i] === 'j') j64Positions.push(i);
        }
        const handler = (...args: unknown[]): number | void => {
            const mod = getModule();
            // Legalize i64 args in-place into (lo, hi) i32 pairs. Splice
            // back-to-front so earlier indices stay stable.
            if (j64Positions.length) {
                for (let i = j64Positions.length - 1; i >= 0; i--) {
                    const pos = j64Positions[i]!;
                    const big = args[pos] as bigint;
                    const [lo, hi] = legalizeI64(big);
                    args.splice(pos, 1, lo, hi);
                }
            }
            const key = args[0] as number;
            const target = mod.getCallback(key);
            if (target == null) {
                throw new Error(
                    `libadapters dispatch: no receiver registered for key=${key} (sig=${sig})`,
                );
            }
            let f: (...a: unknown[]) => unknown;
            let receiver: unknown;
            let restArgs: unknown[];
            if (typeof target === 'function') {
                f = target as (...a: unknown[]) => unknown;
                receiver = target;
                restArgs = args.slice(1);
            } else {
                const methodNamePtr = args[1] as number;
                const methodName = mod.UTF8ToString(methodNamePtr);
                const o = target as Record<string, unknown>;
                const fn = o[methodName];
                if (typeof fn !== 'function') {
                    throw new Error(
                        `libadapters dispatch: receiver has no method "${methodName}" (sig=${sig})`,
                    );
                }
                f = fn as (...a: unknown[]) => unknown;
                receiver = target;
                restArgs = args.slice(2);
            }
            const result = f.apply(receiver, restArgs);
            if (result && typeof (result as { then?: unknown }).then === 'function') {
                throw new Error(
                    `libadapters dispatch (sig=${sig}): receiver returned a Promise; sync-only runtime`,
                );
            }
            return result as number | void;
        };
        adapters[sig] = handler;
        // The _async variants are present in our import list (the
        // libadapters.h DECLARE macro generates both sync + async). Route
        // them through the same sync path — OPFSCoopSyncVFS never declares
        // its methods as async, so the C side only ever picks the sync
        // branch in practice. Wire async to the sync handler so the
        // import is satisfied at instantiate time regardless.
        adapters[`${sig}_async`] = handler;
    }
    return adapters;
}

/**
 * Build a `cwrap`-shaped binder over the wasm exports. Handles the i64
 * legalization mismatch between the committed wa-sqlite JS callers
 * (Emscripten convention: lo32+hi32 pairs) and wasi-sdk's native i64.
 *
 * Strategy:
 *   * On RETURN — if the underlying export returns BigInt, store the high
 *     32 bits in tempRet0 and return the lo32 as a Number.
 *   * On ARGS — if the declared `argTypes` count exceeds the actual export
 *     arity by N, we know there are N i64 args being passed as lo+hi
 *     pairs. Detect by walking the actual params (we infer i64 slots by
 *     position from a small static table; failing that, assume the last
 *     mismatched pair).
 *
 * The static i64-arg table covers exactly the sqlite3 entry points that
 * the committed sqlite-api.js calls with legalized arity. We can't
 * runtime-introspect param types without wasm type reflection, which
 * Node ships but not browsers as of writing.
 */
const I64_ARG_POSITIONS: Record<string, number[]> = {
    sqlite3_bind_int64: [2],
    sqlite3_bind_zeroblob64: [2],
    sqlite3_bind_blob64: [3],
    sqlite3_bind_text64: [3],
    sqlite3_result_int64: [1],
    sqlite3_result_zeroblob64: [1],
    sqlite3_result_text64: [2],
    sqlite3_result_blob64: [2],
    sqlite3_malloc64: [0],
    sqlite3_realloc64: [1],
    sqlite3_uri_int64: [2],
    sqlite3_deserialize: [3, 4],
};

function buildCwrap(
    exports: WasmExports,
    state: { tempRet0: number },
    getModule: () => WaSqliteModule,
) {
    const textDecoder = new TextDecoder('utf-8', { fatal: false });
    const textEncoder = new TextEncoder();

    function readCString(ptr: Pointer): string {
        if (ptr === 0) return '';
        const heap = getModule().HEAPU8;
        let end = ptr;
        while (heap[end] !== 0 && end < heap.length) end++;
        return textDecoder.decode(heap.subarray(ptr, end));
    }

    function allocCString(s: string): Pointer {
        const bytes = textEncoder.encode(s);
        const ptr = exports.malloc(bytes.byteLength + 1);
        const heap = getModule().HEAPU8;
        heap.set(bytes, ptr);
        heap[ptr + bytes.byteLength] = 0;
        return ptr;
    }

    function coerceArg(v: unknown, argType: string | undefined, tempAllocs: Pointer[]): unknown {
        if (argType === 'string') {
            if (typeof v === 'string') {
                const p = allocCString(v);
                tempAllocs.push(p);
                return p;
            }
            if (v == null) return 0;
        }
        if (argType === 'array') {
            const bytes = v as Uint8Array | number[];
            const len = bytes instanceof Uint8Array ? bytes.byteLength : bytes.length;
            const p = exports.malloc(len);
            tempAllocs.push(p);
            getModule().HEAPU8.set(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), p);
            return p;
        }
        return v;
    }

    function cwrap(
        name: string,
        returnType: string | null,
        argTypes: string[] | null,
        _opts?: { async?: boolean },
    ): (...args: unknown[]) => unknown {
        const fn = exports[name] as ((...a: unknown[]) => unknown) | undefined;
        if (typeof fn !== 'function') {
            throw new Error(`cwrap: export "${name}" not found`);
        }
        const argList = argTypes ?? [];
        const actualArity = (fn as { length: number }).length;
        const declaredArity = argList.length;
        const i64Positions = I64_ARG_POSITIONS[name] ?? [];
        // "Legalized" mode: each i64 arg gets passed as two i32 slots, so
        // the JS-side declared arity is bigger than the C export's. The
        // committed sqlite-api.js does this for bind_int64 and result_int64.
        const isLegalized =
            i64Positions.length > 0 && declaredArity === actualArity + i64Positions.length;
        const i64Set = new Set(i64Positions);

        return (...args: unknown[]): unknown => {
            const stringTempAllocs: Pointer[] = [];
            try {
                let callArgs: unknown[];
                if (isLegalized) {
                    callArgs = new Array(actualArity);
                    let declIdx = 0;
                    for (let actIdx = 0; actIdx < actualArity; actIdx++) {
                        if (i64Set.has(actIdx)) {
                            const lo = (args[declIdx++] as number) >>> 0;
                            const hi = args[declIdx++] as number;
                            callArgs[actIdx] = (BigInt(hi) << 32n) | BigInt(lo);
                        } else {
                            callArgs[actIdx] = coerceArg(
                                args[declIdx++],
                                argList[actIdx],
                                stringTempAllocs,
                            );
                        }
                    }
                } else {
                    callArgs = args.map((v, i) => {
                        if (i64Set.has(i)) {
                            // Direct (non-legalized) i64 arg: declared arity
                            // matches actual; just convert the JS Number /
                            // BigInt to a BigInt for the wasm boundary.
                            if (typeof v === 'bigint') return v;
                            return BigInt(v as number);
                        }
                        return coerceArg(v, argList[i], stringTempAllocs);
                    });
                }
                const raw = fn(...callArgs);

                if (returnType === 'string') {
                    return readCString(raw as Pointer);
                }
                if (returnType == null) return undefined;
                if (typeof raw === 'bigint') {
                    const big = raw as bigint;
                    state.tempRet0 = Number((big >> 32n) & 0xffffffffn) | 0;
                    return Number(big & 0xffffffffn) | 0;
                }
                return raw;
            } finally {
                for (const p of stringTempAllocs) exports.free(p);
            }
        };
    }

    return { cwrap, readCString, allocCString };
}

export async function createWaSqliteModule(options: FactoryOptions = {}): Promise<WaSqliteModule> {
    const wasmBytes = options.wasmBinary
        ? options.wasmBinary instanceof Uint8Array
            ? (options.wasmBinary.buffer.slice(
                  options.wasmBinary.byteOffset,
                  options.wasmBinary.byteOffset + options.wasmBinary.byteLength,
              ) as ArrayBuffer)
            : options.wasmBinary
        : await fetchWasm();

    const state = { tempRet0: 0 };
    // Forward declare so the adapters can read it during dispatch.
    let mod!: WaSqliteModule;

    const adapters = buildAdapters(() => mod);
    let memoryRef: WebAssembly.Memory | null = null;
    const wasi = wasiStub(() => {
        if (!memoryRef) throw new Error('wasi import called before memory ready');
        return memoryRef;
    });

    const wasmMod = await WebAssembly.compile(wasmBytes);
    const inst = await WebAssembly.instantiate(wasmMod, {
        env: adapters,
        wasi_snapshot_preview1: wasi,
    });
    const exports = inst.exports as WasmExports;
    memoryRef = exports.memory;
    // wasi-sdk reactor: run `_initialize` to fire ctors, then our shim
    // (calls sqlite3_initialize). We elected to call sqlite3_initialize
    // explicitly rather than rely on a C constructor — order-of-init across
    // sqlite3.c is finicky to reason about.
    exports._initialize();
    const initRc = exports.analyst_wa_init();
    if (initRc !== 0) {
        throw new Error(`sqlite3_initialize failed: rc=${initRc}`);
    }

    let cachedHeapU8: Uint8Array | null = null;
    let cachedHeap32: Int32Array | null = null;
    let cachedHeapU32: Uint32Array | null = null;
    function refreshHeaps() {
        cachedHeapU8 = new Uint8Array(exports.memory.buffer);
        cachedHeap32 = new Int32Array(exports.memory.buffer);
        cachedHeapU32 = new Uint32Array(exports.memory.buffer);
    }
    refreshHeaps();

    // Targets table used by the libadapters dispatch (VFS, function
    // callbacks, hooks). Keyed by the wasm pointer the C side hands us.
    const callbackTargets = new Map<number, unknown>();

    const { cwrap, readCString } = buildCwrap(exports, state, () => mod);

    function utf8ToString(ptr: Pointer): string {
        return readCString(ptr);
    }

    function getValue(ptr: Pointer, type: string): number {
        const heapU8 = cachedHeapU8!;
        const dv = new DataView(heapU8.buffer);
        switch (type) {
            case '*':
            case 'i32':
                return dv.getInt32(ptr, true);
            case 'i8':
                return dv.getInt8(ptr);
            case 'i16':
                return dv.getInt16(ptr, true);
            case 'i64':
                // Truncated low-32 view — callers that need the full int64
                // use getValue('*') and read both halves manually.
                return dv.getInt32(ptr, true);
            case 'float':
                return dv.getFloat32(ptr, true);
            case 'double':
                return dv.getFloat64(ptr, true);
            default:
                throw new Error(`getValue: unsupported type "${type}"`);
        }
    }

    function setValue(ptr: Pointer, value: number, type: string): void {
        const heapU8 = cachedHeapU8!;
        const dv = new DataView(heapU8.buffer);
        switch (type) {
            case '*':
            case 'i32':
                dv.setInt32(ptr, value | 0, true);
                return;
            case 'i8':
                dv.setInt8(ptr, value | 0);
                return;
            case 'i16':
                dv.setInt16(ptr, value | 0, true);
                return;
            case 'float':
                dv.setFloat32(ptr, value, true);
                return;
            case 'double':
                dv.setFloat64(ptr, value, true);
                return;
            default:
                throw new Error(`setValue: unsupported type "${type}"`);
        }
    }

    function ccall(
        name: string,
        returnType: string | null,
        argTypes: string[] | null,
        args: unknown[],
    ): unknown {
        const fn = cwrap(name, returnType, argTypes);
        return fn(...args);
    }

    // Live heap views — invalidated by memory.grow. We accept the cost of
    // recomputing on each access via a getter (refresh on demand if the
    // buffer reference moved).
    const heapAccessor = (): { u8: Uint8Array; i32: Int32Array; u32: Uint32Array } => {
        if (cachedHeapU8!.buffer !== exports.memory.buffer) {
            refreshHeaps();
        }
        return {
            u8: cachedHeapU8!,
            i32: cachedHeap32!,
            u32: cachedHeapU32!,
        };
    };

    // Auto-expose all `sqlite3_*` exports as `_sqlite3_*` plus a few
    // others the JS layer pokes (`_RegisterExtensionFunctions`, `_main`).
    // Done via a property descriptor so growth-resilience for the heaps
    // is handled separately above.
    const moduleObject: Partial<WaSqliteModule> = {
        get HEAPU8() {
            return heapAccessor().u8;
        },
        get HEAP32() {
            return heapAccessor().i32;
        },
        get HEAPU32() {
            return heapAccessor().u32;
        },
        _malloc: (n: number) => exports.malloc(n),
        _free: (p: Pointer) => exports.free(p),
        _sqlite3_malloc: (n: number) => exports.sqlite3_malloc(n),
        _sqlite3_free: (p: Pointer) => exports.sqlite3_free(p),
        _getSqliteFree: () => (exports.getSqliteFree as () => FunctionPointer)(),
        cwrap,
        ccall,
        getValue,
        setValue,
        getTempRet0: () => state.tempRet0,
        UTF8ToString: utf8ToString,
        setCallback: (key, target) => callbackTargets.set(key, target),
        getCallback: (key) => callbackTargets.get(key),
        deleteCallback: (key) => callbackTargets.delete(key),
        handleAsync: null,
        retryOps: [],
        pendingOps: [],
    };

    // Auto-expose `_<export>` for every function-like wasm export. The
    // committed JS layer reaches into Module._sqlite3_xxx directly in
    // several places (sqlite-api.js _sqlite3_malloc, _sqlite3_free,
    // _sqlite3_deserialize, etc.).
    for (const [name, value] of Object.entries(exports)) {
        if (typeof value === 'function') {
            (moduleObject as Record<string, unknown>)[`_${name}`] = value;
        }
    }

    // VFS / function / hook / progress / authorizer post-js implementations
    // — ported verbatim from contrib/wa-sqlite/src/lib*.js so the JS
    // surface that consumes them stays untouched. Function bodies match
    // their counterparts; we just translate the global helper references
    // (`ccall`, `setValue`, `Module`) to our locals.

    const VFS_METHODS = [
        'xOpen',
        'xDelete',
        'xAccess',
        'xFullPathname',
        'xRandomness',
        'xSleep',
        'xCurrentTime',
        'xGetLastError',
        'xCurrentTimeInt64',
        'xClose',
        'xRead',
        'xWrite',
        'xTruncate',
        'xSync',
        'xFileSize',
        'xLock',
        'xUnlock',
        'xCheckReservedLock',
        'xFileControl',
        'xSectorSize',
        'xDeviceCharacteristics',
        'xShmMap',
        'xShmLock',
        'xShmBarrier',
        'xShmUnmap',
    ];

    const mapVFSNameToKey = new Map<string, number>();
    moduleObject.vfs_register = (vfs: unknown, makeDefault: boolean) => {
        const v = vfs as { name: string; mxPathname: number } & Record<string, unknown>;
        let methodMask = 0;
        let asyncMask = 0;
        VFS_METHODS.forEach((method, i) => {
            if (v[method]) {
                methodMask |= 1 << i;
                if ((v.hasAsyncMethod as (m: string) => boolean)(method)) {
                    asyncMask |= 1 << i;
                }
            }
        });
        const vfsReturn = exports.sqlite3_malloc(4);
        try {
            const result = ccall(
                'libvfs_vfs_register',
                'number',
                ['string', 'number', 'number', 'number', 'number', 'number'],
                [v.name, v.mxPathname, methodMask, asyncMask, makeDefault ? 1 : 0, vfsReturn],
            ) as number;
            if (!result) {
                if (mapVFSNameToKey.has(v.name)) {
                    const oldKey = mapVFSNameToKey.get(v.name)!;
                    callbackTargets.delete(oldKey);
                }
                const key = getValue(vfsReturn, '*');
                mapVFSNameToKey.set(v.name, key);
                callbackTargets.set(key, vfs);
            }
            return result;
        } finally {
            exports.sqlite3_free(vfsReturn);
        }
    };

    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
        ...args: string[]
    ) => unknown;
    const FUNC_METHODS = ['xFunc', 'xStep', 'xFinal'];
    const mapFunctionNameToKey = new Map<string, number>();
    moduleObject.create_function = (
        db,
        zFunctionName,
        nArg,
        eTextRep,
        _pApp,
        xFunc,
        xStep,
        xFinal,
    ) => {
        const pAsyncFlags = exports.sqlite3_malloc(4);
        const target = { xFunc, xStep, xFinal } as Record<string, unknown>;
        const mask = FUNC_METHODS.reduce((m, method, i) => {
            if (target[method] instanceof AsyncFunction) return m | (1 << i);
            return m;
        }, 0);
        setValue(pAsyncFlags, mask, 'i32');
        const result = ccall(
            'libfunction_create_function',
            'number',
            ['number', 'string', 'number', 'number', 'number', 'number', 'number', 'number'],
            [
                db,
                zFunctionName,
                nArg,
                eTextRep,
                pAsyncFlags,
                xFunc ? 1 : 0,
                xStep ? 1 : 0,
                xFinal ? 1 : 0,
            ],
        ) as number;
        if (!result) {
            if (mapFunctionNameToKey.has(zFunctionName)) {
                const oldKey = mapFunctionNameToKey.get(zFunctionName)!;
                callbackTargets.delete(oldKey);
            }
            mapFunctionNameToKey.set(zFunctionName, pAsyncFlags);
            callbackTargets.set(pAsyncFlags, { xFunc, xStep, xFinal });
        }
        return result;
    };

    let authorizerAsyncFlagsPtr = 0;
    moduleObject.set_authorizer = (db, xAuthorizer, pApp) => {
        if (authorizerAsyncFlagsPtr) {
            callbackTargets.delete(authorizerAsyncFlagsPtr);
            exports.sqlite3_free(authorizerAsyncFlagsPtr);
            authorizerAsyncFlagsPtr = 0;
        }
        authorizerAsyncFlagsPtr = exports.sqlite3_malloc(4);
        setValue(authorizerAsyncFlagsPtr, xAuthorizer instanceof AsyncFunction ? 1 : 0, 'i32');
        const result = ccall(
            'libauthorizer_set_authorizer',
            'number',
            ['number', 'number', 'number'],
            [db, xAuthorizer ? 1 : 0, authorizerAsyncFlagsPtr],
        ) as number;
        if (!result && xAuthorizer) {
            callbackTargets.set(
                authorizerAsyncFlagsPtr,
                (_: Pointer, iAction: number, p3: Pointer, p4: Pointer, p5: Pointer, p6: Pointer) =>
                    xAuthorizer(
                        pApp,
                        iAction,
                        utf8ToString(p3),
                        utf8ToString(p4),
                        utf8ToString(p5),
                        utf8ToString(p6),
                    ),
            );
        }
        return result;
    };

    let updateHookAsyncFlagsPtr = 0;
    moduleObject.update_hook = (db, xUpdateHook) => {
        if (updateHookAsyncFlagsPtr) {
            callbackTargets.delete(updateHookAsyncFlagsPtr);
            exports.sqlite3_free(updateHookAsyncFlagsPtr);
            updateHookAsyncFlagsPtr = 0;
        }
        updateHookAsyncFlagsPtr = exports.sqlite3_malloc(4);
        setValue(updateHookAsyncFlagsPtr, xUpdateHook instanceof AsyncFunction ? 1 : 0, 'i32');
        ccall(
            'libhook_update_hook',
            'void',
            ['number', 'number', 'number'],
            [db, xUpdateHook ? 1 : 0, updateHookAsyncFlagsPtr],
        );
        if (xUpdateHook) {
            callbackTargets.set(
                updateHookAsyncFlagsPtr,
                (
                    _: Pointer,
                    iUpdateType: number,
                    dbName: Pointer,
                    tblName: Pointer,
                    lo32: number,
                    hi32: number,
                ) =>
                    xUpdateHook(
                        iUpdateType,
                        utf8ToString(dbName),
                        utf8ToString(tblName),
                        lo32,
                        hi32,
                    ),
            );
        }
    };

    let commitHookAsyncFlagsPtr = 0;
    moduleObject.commit_hook = (db, xCommitHook) => {
        if (commitHookAsyncFlagsPtr) {
            callbackTargets.delete(commitHookAsyncFlagsPtr);
            exports.sqlite3_free(commitHookAsyncFlagsPtr);
            commitHookAsyncFlagsPtr = 0;
        }
        commitHookAsyncFlagsPtr = exports.sqlite3_malloc(4);
        setValue(commitHookAsyncFlagsPtr, xCommitHook instanceof AsyncFunction ? 1 : 0, 'i32');
        ccall(
            'libhook_commit_hook',
            'void',
            ['number', 'number', 'number'],
            [db, xCommitHook ? 1 : 0, commitHookAsyncFlagsPtr],
        );
        if (xCommitHook) {
            callbackTargets.set(commitHookAsyncFlagsPtr, () => xCommitHook());
        }
    };

    let progressAsyncFlagsPtr = 0;
    moduleObject.progress_handler = (db, nOps, xProgress, pApp) => {
        if (progressAsyncFlagsPtr) {
            callbackTargets.delete(progressAsyncFlagsPtr);
            exports.sqlite3_free(progressAsyncFlagsPtr);
            progressAsyncFlagsPtr = 0;
        }
        progressAsyncFlagsPtr = exports.sqlite3_malloc(4);
        setValue(progressAsyncFlagsPtr, xProgress instanceof AsyncFunction ? 1 : 0, 'i32');
        ccall(
            'libprogress_progress_handler',
            'number',
            ['number', 'number', 'number', 'number'],
            [db, nOps, xProgress ? 1 : 0, progressAsyncFlagsPtr],
        );
        if (xProgress) {
            callbackTargets.set(progressAsyncFlagsPtr, () => xProgress(pApp));
        }
    };

    mod = moduleObject as WaSqliteModule;
    return mod;
}

// Default export shape matches `SQLiteESMFactory` from
// `wa-sqlite/dist/wa-sqlite.mjs` so we can swap the import wholesale.
export default createWaSqliteModule;
