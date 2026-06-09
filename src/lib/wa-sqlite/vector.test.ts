/**
 * Vitest coverage for the rh vector-search extension (clean-room; TurboQuant
 * per arXiv:2504.19874), compiled into wa-sqlite.wasm and auto-registered on
 * every connection.
 *
 * Runs against `:memory:` only, mirroring db.test.ts — OPFS-dependent paths
 * live in the browser testbed (src/lib/test-runner/tests-wa-sqlite.ts).
 *
 * NOTE: these assertions exercise the *built* wasm. After editing the C
 * sources under wasm/sqlite-vector/, run `make wa-sqlite` before this suite.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WaSqliteDb } from './db';
import {
    asBytes,
    cosineDistance,
    decode,
    dot,
    hamming,
    l1,
    l2,
    type RefType,
    squaredL2,
} from './vector-reference';

/** Run a read-only scalar SQL expression and return the single cell. */
async function scalar(db: WaSqliteDb, expr: string): Promise<unknown> {
    const result = await db.execRaw(`SELECT ${expr} AS v`);
    return result.rows[0]?.v;
}

/** Encode a JS array via the C `vector_as_<type>` encoder, return raw bytes. */
async function encode(db: WaSqliteDb, type: RefType, values: number[]): Promise<Uint8Array> {
    const json = JSON.stringify(values);
    const cell = await scalar(db, `vector_as_${type}('${json}')`);
    return asBytes(cell);
}

describe('rh vector extension — registration', () => {
    it('registers vector_version() / vector_backend() on every connection', async () => {
        const db = new WaSqliteDb();
        await db.init();
        try {
            // Auto-extension fired at open: the functions resolve without any
            // explicit load step.
            expect(await scalar(db, 'vector_version()')).toBe('0.1.0');
            expect(await scalar(db, 'vector_backend()')).toBe('scalar');
            expect(await scalar(db, 'vector_turboquant_backend()')).toBe('scalar');
        } finally {
            await db.close();
        }
    });
});

describe('rh vector extension — vector_as_* encoders', () => {
    let db: WaSqliteDb;
    beforeAll(async () => {
        db = new WaSqliteDb();
        await db.init();
    });
    afterAll(async () => {
        await db.close();
    });

    it('packs float32 exactly and reports the right byte length', async () => {
        const values = [1.5, -2.25, 3.0, 0.0];
        const bytes = await encode(db, 'f32', values);
        expect(bytes.byteLength).toBe(values.length * 4);
        expect(decode('f32', bytes, values.length)).toEqual(values);
        // length() over the blob agrees with the codec.
        expect(await scalar(db, `length(vector_as_f32('${JSON.stringify(values)}'))`)).toBe(16);
    });

    it('packs f16 / bf16 within their precision and round-trips', async () => {
        const values = [1.5, -2.25, 0.1, 100.0, -0.0009765625];
        for (const type of ['f16', 'bf16'] as const) {
            const bytes = await encode(db, type, values);
            expect(bytes.byteLength).toBe(values.length * 2);
            const back = decode(type, bytes, values.length);
            // half ~ 1e-3 relative, bf16 ~ 8e-3 relative; assert close, not exact.
            const tol = type === 'f16' ? 1e-2 : 1e-1;
            for (let i = 0; i < values.length; i++) {
                expect(Math.abs(back[i] - values[i])).toBeLessThanOrEqual(
                    tol * (Math.abs(values[i]) + 1e-3),
                );
            }
        }
    });

    it('rounds + clamps i8 and u8', async () => {
        const i8 = await encode(db, 'i8', [1, -2.4, 2.6, 127, -128, 999, -999]);
        expect([...i8].map((b) => (b > 127 ? b - 256 : b))).toEqual([
            1, -2, 3, 127, -128, 127, -128,
        ]);
        const u8 = await encode(db, 'u8', [0, 1.4, 254.6, 255, 300, -5]);
        expect([...u8]).toEqual([0, 1, 255, 255, 255, 0]);
    });

    it('packs 1-bit vectors LSB-first, set when value > 0', async () => {
        const values = [1, -1, 1, 1, -1, -1, -1, -1, 1];
        const bytes = await encode(db, 'bit', values);
        expect(bytes.byteLength).toBe(Math.ceil(values.length / 8));
        // byte0 bits 0..7 = 1,0,1,1,0,0,0,0 => 0b00001101 = 0x0d; byte1 bit0 = 1.
        expect(bytes[0]).toBe(0x0d);
        expect(bytes[1]).toBe(0x01);
        expect(decode('bit', bytes, values.length)).toEqual([1, 0, 1, 1, 0, 0, 0, 0, 1]);
    });

    it('passes a BLOB argument through unchanged (already-formatted contract)', async () => {
        const direct = await encode(db, 'f32', [1, 2, 3]);
        // Wrapping an existing blob is a no-op: vector_as_f32(blob) === blob.
        const wrapped = asBytes(await scalar(db, `vector_as_f32(vector_as_f32('[1,2,3]'))`));
        expect([...wrapped]).toEqual([...direct]);
    });

    it('errors on malformed JSON input', async () => {
        await expect(db.execRaw(`SELECT vector_as_f32('[1, 2,')`)).rejects.toThrow(/JSON array/i);
        await expect(db.execRaw(`SELECT vector_as_f32('not json')`)).rejects.toThrow(/JSON array/i);
    });

    it('handles the empty array as a zero-length blob', async () => {
        expect(await scalar(db, `length(vector_as_f32('[]'))`)).toBe(0);
    });
});

describe('rh vector extension — vector_distance kernels', () => {
    let db: WaSqliteDb;
    beforeAll(async () => {
        db = new WaSqliteDb();
        await db.init();
    });
    afterAll(async () => {
        await db.close();
    });

    /** vector_distance over two float32 vectors given as JS arrays. */
    async function dist(a: number[], b: number[], metric: string): Promise<number> {
        const v = await scalar(
            db,
            `vector_distance(vector_as_f32('${JSON.stringify(a)}'),` +
                ` vector_as_f32('${JSON.stringify(b)}'), 'f32', '${metric}')`,
        );
        return v as number;
    }

    // Deterministic pseudo-random vectors (no Math.random in the harness path).
    function vec(seed: number, n: number): number[] {
        const out: number[] = [];
        let s = seed >>> 0;
        for (let i = 0; i < n; i++) {
            s = (1103515245 * s + 12345) >>> 0;
            out.push((s / 0xffffffff) * 2 - 1);
        }
        return out;
    }

    it('matches the reference oracle for every f32 metric', async () => {
        const pairs: Array<[number[], number[]]> = [
            [
                [1, 2, 3],
                [4, 5, 6],
            ],
            [vec(1, 8), vec(2, 8)],
            [vec(7, 16), vec(99, 16)],
        ];
        const close = (got: number, want: number) =>
            expect(Math.abs(got - want)).toBeLessThanOrEqual(1e-4 * (Math.abs(want) + 1));

        for (const [a, b] of pairs) {
            close(await dist(a, b, 'dot'), dot(a, b));
            close(await dist(a, b, 'squared_l2'), squaredL2(a, b));
            close(await dist(a, b, 'l2'), l2(a, b));
            close(await dist(a, b, 'l1'), l1(a, b));
            close(await dist(a, b, 'cosine'), cosineDistance(a, b));
        }
    });

    it('computes hamming over 1-bit vectors via popcount semantics', async () => {
        const a = [1, -1, 1, 1, -1, -1, -1, -1, 1];
        const b = [1, 1, 1, -1, -1, -1, 1, -1, 1];
        const got = await scalar(
            db,
            `vector_distance(vector_as_bit('${JSON.stringify(a)}'),` +
                ` vector_as_bit('${JSON.stringify(b)}'), 'bit', 'hamming')`,
        );
        const ab = a.map((x) => (x > 0 ? 1 : 0));
        const bb = b.map((x) => (x > 0 ? 1 : 0));
        expect(got).toBe(hamming(ab, bb));
    });

    it('decodes quantized types before measuring (i8 / f16)', async () => {
        const a = [10, -20, 30, 127];
        const b = [12, -18, 28, 100];
        // i8 stores exactly for these integer inputs, so the oracle on the raw
        // values is the ground truth.
        const i8 = (await scalar(
            db,
            `vector_distance(vector_as_i8('${JSON.stringify(a)}'),` +
                ` vector_as_i8('${JSON.stringify(b)}'), 'i8', 'l2')`,
        )) as number;
        expect(Math.abs(i8 - l2(a, b))).toBeLessThanOrEqual(1e-4 * (l2(a, b) + 1));

        // f16 is lossy; compare against the oracle on the f16-decoded values.
        const fa = [0.1, 0.5, -0.25, 100];
        const fb = [0.2, 0.4, -0.3, 90];
        const da = decode('f16', await encode(db, 'f16', fa), fa.length);
        const dbk = decode('f16', await encode(db, 'f16', fb), fb.length);
        const f16 = (await scalar(
            db,
            `vector_distance(vector_as_f16('${JSON.stringify(fa)}'),` +
                ` vector_as_f16('${JSON.stringify(fb)}'), 'f16', 'cosine')`,
        )) as number;
        expect(Math.abs(f16 - cosineDistance(da, dbk))).toBeLessThanOrEqual(1e-4);
    });

    it('errors on dimension mismatch and bad type/metric', async () => {
        await expect(
            db.execRaw(
                `SELECT vector_distance(vector_as_f32('[1,2,3]'),` +
                    ` vector_as_f32('[1,2]'), 'f32', 'l2')`,
            ),
        ).rejects.toThrow(/dimension mismatch/i);
        await expect(
            db.execRaw(
                `SELECT vector_distance(vector_as_f32('[1]'), vector_as_f32('[1]'), 'nope', 'l2')`,
            ),
        ).rejects.toThrow(/unknown vector type/i);
        await expect(
            db.execRaw(
                `SELECT vector_distance(vector_as_f32('[1]'), vector_as_f32('[1]'), 'f32', 'nope')`,
            ),
        ).rejects.toThrow(/unknown metric/i);
    });
});

/** Deterministic pseudo-random unit-ish vector (no Math.random in the harness). */
function mkVec(seed: number, n: number): number[] {
    const out: number[] = [];
    let s = (seed * 2654435761) >>> 0;
    for (let i = 0; i < n; i++) {
        s = (1103515245 * s + 12345) >>> 0;
        out.push((s / 0xffffffff) * 2 - 1);
    }
    return out;
}

/** Brute-force top-k rowids (1-based) for a query under a metric over `data`. */
function bruteForceTopK(
    data: number[][],
    q: number[],
    metric: (a: number[], b: number[]) => number,
    k: number,
    descending = false,
): number[] {
    const scored = data.map((v, i) => ({ id: i + 1, d: metric(q, v) }));
    scored.sort((a, b) => (descending ? b.d - a.d : a.d - b.d));
    return scored.slice(0, k).map((x) => x.id);
}

describe('rh vector extension — vector_init + vector_full_scan', () => {
    const DIM = 8;
    const N = 20;
    const data: number[][] = Array.from({ length: N }, (_, i) => mkVec(i + 1, DIM));
    let db: WaSqliteDb;

    beforeAll(async () => {
        db = new WaSqliteDb();
        await db.init();
        await db.execRaw('CREATE TABLE docs(id INTEGER PRIMARY KEY, label TEXT, emb BLOB)');
        for (let i = 0; i < N; i++) {
            await db.execRaw(
                `INSERT INTO docs(id, label, emb) VALUES (${i + 1}, 'd${i + 1}',` +
                    ` vector_as_f32('${JSON.stringify(data[i])}'))`,
            );
        }
    });
    afterAll(async () => {
        await db.close();
    });

    const oracleTopK = (
        q: number[],
        metric: (a: number[], b: number[]) => number,
        k: number,
        descending = false,
    ): number[] => bruteForceTopK(data, q, metric, k, descending);

    async function scanIds(metricName: string, q: number[], k?: number): Promise<number[]> {
        const order = metricName === 'dot' ? 'DESC' : 'ASC';
        const kArg = k === undefined ? '' : `, ${k}`;
        const r = await db.execRaw(
            `SELECT rowid AS rid, distance FROM vector_full_scan('docs','emb',` +
                ` vector_as_f32('${JSON.stringify(q)}')${kArg}) ORDER BY distance ${order}`,
        );
        return r.rows.map((row) => Number(row.rid));
    }

    it('returns exact cosine top-k matching brute force', async () => {
        await db.execRaw(`SELECT vector_init('docs','emb','dimension=${DIM}, distance=cosine')`);
        const q = mkVec(999, DIM);
        expect(await scanIds('cosine', q, 5)).toEqual(oracleTopK(q, cosineDistance, 5));
    });

    it('honors the configured metric (re-init to l2, then dot)', async () => {
        const q = mkVec(1234, DIM);

        await db.execRaw(`SELECT vector_init('docs','emb','dimension=${DIM}, distance=l2')`);
        expect(await scanIds('l2', q, 5)).toEqual(oracleTopK(q, l2, 5));

        await db.execRaw(`SELECT vector_init('docs','emb','dimension=${DIM}, distance=dot')`);
        // dot is a similarity: nearest = largest. distance column holds the dot.
        expect(await scanIds('dot', q, 5)).toEqual(oracleTopK(q, dot, 5, true));
    });

    it('streams every row when k is omitted (SQL LIMIT still works)', async () => {
        await db.execRaw(`SELECT vector_init('docs','emb','dimension=${DIM}, distance=l2')`);
        const q = mkVec(42, DIM);
        // No k: the vtab yields all N rows; SQL ORDER BY + LIMIT picks the top 3.
        const all = await db.execRaw(
            `SELECT count(*) AS n FROM vector_full_scan('docs','emb',` +
                ` vector_as_f32('${JSON.stringify(q)}'))`,
        );
        expect(all.rows[0].n).toBe(N);
        const limited = await db.execRaw(
            `SELECT rowid AS rid FROM vector_full_scan('docs','emb',` +
                ` vector_as_f32('${JSON.stringify(q)}')) ORDER BY distance LIMIT 3`,
        );
        expect(limited.rows.map((r) => Number(r.rid))).toEqual(oracleTopK(q, l2, 3));
    });

    it('reports the matched rowid and a numeric distance', async () => {
        await db.execRaw(`SELECT vector_init('docs','emb','dimension=${DIM}, distance=cosine')`);
        // Querying with an exact stored vector returns that row at distance ~0.
        const r = await db.execRaw(
            `SELECT rowid AS rid, distance FROM vector_full_scan('docs','emb',` +
                ` vector_as_f32('${JSON.stringify(data[6])}'), 1)`,
        );
        expect(Number(r.rows[0].rid)).toBe(7);
        expect(Math.abs(Number(r.rows[0].distance))).toBeLessThan(1e-5);
    });

    it('errors when the column was never vector_init-ed', async () => {
        await expect(
            db.execRaw(
                `SELECT rowid, distance FROM vector_full_scan('docs','nope',` +
                    ` vector_as_f32('[0,0,0,0,0,0,0,0]'))`,
            ),
        ).rejects.toThrow(/no vector_init/i);
    });

    it('errors on a query whose dimension does not match the config', async () => {
        await db.execRaw(`SELECT vector_init('docs','emb','dimension=${DIM}, distance=l2')`);
        await expect(
            db.execRaw(
                `SELECT rowid, distance FROM vector_full_scan('docs','emb',` +
                    ` vector_as_f32('[1,2,3]'))`,
            ),
        ).rejects.toThrow(/dimension/i);
    });
});

describe('rh vector extension — vector_quantize + vector_quantize_scan', () => {
    const DIM = 16;
    const N = 400;
    const data: number[][] = Array.from({ length: N }, (_, i) => mkVec(i + 1, DIM));
    let db: WaSqliteDb;

    beforeAll(async () => {
        db = new WaSqliteDb();
        await db.init();
        await db.execRaw('CREATE TABLE docs(id INTEGER PRIMARY KEY, emb BLOB)');
        for (let i = 0; i < N; i++) {
            await db.execRaw(
                `INSERT INTO docs(id, emb) VALUES (${i + 1},` +
                    ` vector_as_f32('${JSON.stringify(data[i])}'))`,
            );
        }
        await db.execRaw(`SELECT vector_init('docs','emb','dimension=${DIM}, distance=cosine')`);
    });
    afterAll(async () => {
        await db.close();
    });

    const oracleTopK = (
        q: number[],
        metric: (a: number[], b: number[]) => number,
        k: number,
        descending = false,
    ): number[] => bruteForceTopK(data, q, metric, k, descending);

    async function quantScanIds(q: number[], k: number, descending = false): Promise<number[]> {
        const r = await db.execRaw(
            `SELECT rowid AS rid, distance FROM vector_quantize_scan('docs','emb',` +
                ` vector_as_f32('${JSON.stringify(q)}'), ${k})` +
                ` ORDER BY distance ${descending ? 'DESC' : 'ASC'}`,
        );
        return r.rows.map((row) => Number(row.rid));
    }

    function recall(got: number[], want: number[]): number {
        const w = new Set(want);
        return got.filter((x) => w.has(x)).length / want.length;
    }

    it('vector_quantize returns the row count; memory matches the formula', async () => {
        const n = await scalar(db, `vector_quantize('docs','emb','qtype=turbo,qbits=4')`);
        expect(n).toBe(N);
        // perRow = 8 (rowid) + 4 (scale) + ceil(DIM*4/8) code bytes.
        const codeBytes = Math.ceil((DIM * 4) / 8);
        expect(await scalar(db, `vector_quantize_memory('docs','emb')`)).toBe(
            N * (8 + 4 + codeBytes),
        );
    });

    it('quantize_scan recall@10 >= 0.9 vs brute force, for qbits 2/3/4 (cosine)', async () => {
        await db.execRaw(`SELECT vector_init('docs','emb','dimension=${DIM}, distance=cosine')`);
        const queries = [mkVec(1001, DIM), mkVec(1002, DIM), mkVec(1003, DIM), mkVec(1004, DIM)];
        for (const qbits of [2, 3, 4]) {
            expect(
                await scalar(db, `vector_quantize('docs','emb','qtype=turbo,qbits=${qbits}')`),
            ).toBe(N);
            let total = 0;
            for (const q of queries) {
                const want = oracleTopK(q, cosineDistance, 10);
                const got = await quantScanIds(q, 10);
                total += recall(got, want);
            }
            const avg = total / queries.length;
            expect(avg, `qbits=${qbits} recall ${avg}`).toBeGreaterThanOrEqual(0.9);
        }
    });

    it('store is metric-independent: re-init to l2 / dot and still recall well', async () => {
        await db.execRaw(`SELECT vector_quantize('docs','emb','qtype=turbo,qbits=4')`);
        const q = mkVec(2024, DIM);

        await db.execRaw(`SELECT vector_init('docs','emb','dimension=${DIM}, distance=l2')`);
        expect(recall(await quantScanIds(q, 10), oracleTopK(q, l2, 10))).toBeGreaterThanOrEqual(
            0.9,
        );

        await db.execRaw(`SELECT vector_init('docs','emb','dimension=${DIM}, distance=dot')`);
        expect(
            recall(await quantScanIds(q, 10, true), oracleTopK(q, dot, 10, true)),
        ).toBeGreaterThanOrEqual(0.9);
    });

    it('preload matches the on-disk scan; cleanup frees and scan still works', async () => {
        await db.execRaw(`SELECT vector_init('docs','emb','dimension=${DIM}, distance=cosine')`);
        await db.execRaw(`SELECT vector_quantize('docs','emb','qtype=turbo,qbits=4')`);
        const q = mkVec(3030, DIM);
        const before = await quantScanIds(q, 10);
        await db.execRaw(`SELECT vector_quantize_preload('docs','emb')`);
        const preloaded = await quantScanIds(q, 10);
        expect(preloaded).toEqual(before); // cache path == shadow-table path
        await db.execRaw(`SELECT vector_quantize_cleanup('docs','emb')`);
        const after = await quantScanIds(q, 10);
        expect(after).toEqual(before);
    });

    it('1bit and int8 quantize succeed and remain searchable', async () => {
        await db.execRaw(`SELECT vector_init('docs','emb','dimension=${DIM}, distance=cosine')`);
        for (const qtype of ['1bit', 'int8']) {
            expect(await scalar(db, `vector_quantize('docs','emb','qtype=${qtype}')`)).toBe(N);
            const q = mkVec(4040, DIM);
            const got = await quantScanIds(q, 10);
            expect(got.length).toBe(10);
        }
    });

    it('errors when the column has not been quantized', async () => {
        await db.execRaw('CREATE TABLE other(id INTEGER PRIMARY KEY, emb BLOB)');
        await db.execRaw(
            `INSERT INTO other(id, emb) VALUES (1, vector_as_f32('${JSON.stringify(data[0])}'))`,
        );
        await db.execRaw(`SELECT vector_init('other','emb','dimension=${DIM}, distance=cosine')`);
        await expect(
            db.execRaw(
                `SELECT rowid, distance FROM vector_quantize_scan('other','emb',` +
                    ` vector_as_f32('${JSON.stringify(data[0])}'), 5)`,
            ),
        ).rejects.toThrow(/not quantized/i);
    });
});

describe('rh vector extension — persistence (serialize → reload)', () => {
    const DIM = 16;
    const N = 150;
    const data: number[][] = Array.from({ length: N }, (_, i) => mkVec(i + 1, DIM));

    /** Build a populated + quantized DB and return its serialized bytes. */
    async function buildQuantized(): Promise<{ db: WaSqliteDb; bytes: Uint8Array }> {
        const db = new WaSqliteDb();
        await db.init();
        await db.execRaw('CREATE TABLE docs(id INTEGER PRIMARY KEY, emb BLOB)');
        for (let i = 0; i < N; i++) {
            await db.execRaw(
                `INSERT INTO docs(id, emb) VALUES (${i + 1},` +
                    ` vector_as_f32('${JSON.stringify(data[i])}'))`,
            );
        }
        await db.execRaw(`SELECT vector_init('docs','emb','dimension=${DIM}, distance=cosine')`);
        await db.execRaw(`SELECT vector_quantize('docs','emb','qtype=turbo,qbits=4')`);
        const bytes = await db.serialize();
        return { db, bytes };
    }

    async function scanIds(db: WaSqliteDb, q: number[], k: number): Promise<number[]> {
        const r = await db.execRaw(
            `SELECT rowid AS rid FROM vector_quantize_scan('docs','emb',` +
                ` vector_as_f32('${JSON.stringify(q)}'), ${k}) ORDER BY distance`,
        );
        return r.rows.map((row) => Number(row.rid));
    }

    it('quantize_scan is identical after serialize→reload (rotation seed persists)', async () => {
        // The Haar rotation is NOT stored — only its seed (in _rhvec_quant_meta).
        // If the seed didn't round-trip, the reloaded DB would rebuild a
        // different rotation, the query would be projected differently from the
        // stored codes, and recall would collapse. This asserts byte-identical
        // ranking across a full serialize/deserialize cycle.
        const q = mkVec(7777, DIM);
        const { db: src, bytes } = await buildQuantized();
        const before = await scanIds(src, q, 10);
        await src.close();
        expect(before.length).toBe(10);

        const dst = new WaSqliteDb();
        await dst.init();
        await dst.loadFile(bytes);
        const after = await scanIds(dst, q, 10);

        expect(after).toEqual(before);

        // And the reloaded index still tracks the exact ranking (sanity:
        // proves the rotation is consistent with the stored codes, not just
        // self-consistent).
        const want = new Set(
            (
                await dst.execRaw(
                    `SELECT rowid AS rid FROM vector_full_scan('docs','emb',` +
                        ` vector_as_f32('${JSON.stringify(q)}'), 10) ORDER BY distance`,
                )
            ).rows.map((row) => Number(row.rid)),
        );
        const recall = after.filter((id) => want.has(id)).length / 10;
        expect(recall).toBeGreaterThanOrEqual(0.9);
        await dst.close();
    });
});

describe('rh vector extension — vector_search (map resolution + embed callback)', () => {
    const DIM = 16;
    const N = 200;
    const data: number[][] = Array.from({ length: N }, (_, i) => mkVec(i + 1, DIM));
    let db: WaSqliteDb;

    beforeAll(async () => {
        db = new WaSqliteDb();
        await db.init();
        // The user-facing base table + the embedding SIDECAR that
        // semantic-index.ts builds. vector_search reaches the sidecar via the
        // _rhvec_search_map row; it never reads `product` itself.
        await db.execRaw('CREATE TABLE product(id INTEGER PRIMARY KEY, name TEXT)');
        await db.execRaw(
            'CREATE TABLE _rhvec_emb_product_name(rowid INTEGER PRIMARY KEY, vec BLOB)',
        );
        for (let i = 0; i < N; i++) {
            await db.execRaw(`INSERT INTO product(id, name) VALUES (${i + 1}, 'p${i + 1}')`);
            await db.execRaw(
                `INSERT INTO _rhvec_emb_product_name(rowid, vec) VALUES (${i + 1},` +
                    ` vector_as_f32('${JSON.stringify(data[i])}'))`,
            );
        }
        await db.execRaw(
            `SELECT vector_init('_rhvec_emb_product_name','vec','dimension=${DIM}, distance=cosine')`,
        );
        await db.execRaw(
            `SELECT vector_quantize('_rhvec_emb_product_name','vec','qtype=turbo,qbits=4')`,
        );
        await db.execRaw(
            'CREATE TABLE _rhvec_search_map(base_tbl TEXT, base_col TEXT, store_tbl TEXT,' +
                ' store_col TEXT, model TEXT, dim INTEGER, metric TEXT,' +
                ' PRIMARY KEY(base_tbl, base_col))',
        );
        await db.execRaw(
            `INSERT INTO _rhvec_search_map VALUES('product','name',` +
                `'_rhvec_emb_product_name','vec','bge-small-en-v1.5',${DIM},'cosine')`,
        );
    });
    afterAll(async () => {
        await db.close();
    });

    it('resolves the user column to its sidecar (search == direct quantized scan)', async () => {
        const q = mkVec(777, DIM);
        const json = JSON.stringify(q);
        const viaSearch = await db.execRaw(
            `SELECT rowid AS rid FROM vector_search('product','name',` +
                ` vector_as_f32('${json}'), 10) ORDER BY distance`,
        );
        const viaScan = await db.execRaw(
            `SELECT rowid AS rid FROM vector_quantize_scan('_rhvec_emb_product_name','vec',` +
                ` vector_as_f32('${json}'), 10) ORDER BY distance`,
        );
        const ids = viaSearch.rows.map((r) => Number(r.rid));
        expect(ids).toEqual(viaScan.rows.map((r) => Number(r.rid)));
        expect(ids.length).toBe(10);
    });

    it('errors clearly when the (table,column) has no semantic index', async () => {
        await expect(
            db.execRaw(
                `SELECT rowid FROM vector_search('product','description',` +
                    ` vector_as_f32('${JSON.stringify(mkVec(1, DIM))}'), 5)`,
            ),
        ).rejects.toThrow(/no semantic index/i);
    });

    it('a TEXT phrase needs the on-device model — clean error in Node (model not warmed)', async () => {
        // The BGE engine is compiled into wa-sqlite.wasm, but Node never loads
        // the GGUF (sem_init is browser/worker-only — see semantic-embed.ts), so
        // sem_dim()==0 and the C analyst_embed_query returns 1; the vtab raises a
        // clear, non-hanging error. The browser harness covers the embedding path.
        await expect(
            db.execRaw(`SELECT rowid FROM vector_search('product','name','find me dogs', 5)`),
        ).rejects.toThrow(/not warmed up|embedding/i);
    });
});
