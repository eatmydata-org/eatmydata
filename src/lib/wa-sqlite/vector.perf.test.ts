/**
 * Performance demonstration for the rh vector extension (TurboQuant).
 *
 * Shows what the quantized "index" buys you versus an exact brute-force scan:
 *   1. memory  — the quantized store is ~6-7x smaller than raw f32 (the
 *      headline win; scales with the corpus);
 *   2. quality — quantize_scan recall@k stays ~100% vs the exact scan;
 *   3. latency — measured and reported honestly. Both scans are O(N·d);
 *      TurboQuant is a *quantizer*, not an ANN partition index, so there is
 *      no sublinear speedup. With the current scalar dequant kernel (per-bit
 *      unpack + float dot) the quantized scan is actually *slower* than the
 *      exact f32 scan even out-of-cache — the per-code CPU cost outweighs the
 *      memory-bandwidth saved. Preloading does beat the on-disk shadow-table
 *      scan. A LUT/ADC scoring kernel (the paper's fast path) is what would
 *      turn the smaller footprint into a latency win; not implemented yet.
 *
 * Runs in Node against the built wasm (`make wa-sqlite` first). Timings are
 * relative within one process, so the assertions use generous bounds; the
 * printed report carries the real numbers.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WaSqliteDb } from './db';

// Scale knobs — small defaults keep the suite fast; override for a load test:
//   RH_VEC_N=40000 RH_VEC_DIM=128 pnpm vitest run src/lib/wa-sqlite/vector.perf.test.ts
const DIM = Number(process.env.RH_VEC_DIM ?? 96);
const N = Number(process.env.RH_VEC_N ?? 5000);
const K = 10;
const QUERIES = Number(process.env.RH_VEC_QUERIES ?? 20);

/** Deterministic pseudo-random vector (no Math.random in the harness path). */
function mkVec(seed: number, n: number): number[] {
    const out: number[] = [];
    let s = (seed * 2654435761) >>> 0;
    for (let i = 0; i < n; i++) {
        s = (1103515245 * s + 12345) >>> 0;
        out.push((s / 0xffffffff) * 2 - 1);
    }
    return out;
}

function median(xs: number[]): number {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
}

async function topKIds(db: WaSqliteDb, fn: string, q: number[], k: number): Promise<number[]> {
    const r = await db.execRaw(
        `SELECT rowid AS rid FROM ${fn}('docs','emb', vector_as_f32('${JSON.stringify(q)}'), ${k})` +
            ` ORDER BY distance`,
    );
    return r.rows.map((row) => Number(row.rid));
}

/** Time a scan over all QUERIES; returns total + median ms. */
async function timeScan(
    db: WaSqliteDb,
    fn: string,
    queries: number[][],
    k: number,
): Promise<{ total: number; median: number }> {
    const ts: number[] = [];
    for (const q of queries) {
        const t0 = performance.now();
        await topKIds(db, fn, q, k);
        ts.push(performance.now() - t0);
    }
    return { total: ts.reduce((a, b) => a + b, 0), median: median(ts) };
}

describe('rh vector extension — performance', () => {
    let db: WaSqliteDb;
    const data: number[][] = Array.from({ length: N }, (_, i) => mkVec(i + 1, DIM));
    const queries: number[][] = Array.from({ length: QUERIES }, (_, i) => mkVec(100000 + i, DIM));

    beforeAll(async () => {
        db = new WaSqliteDb();
        await db.init();
        await db.execRaw('CREATE TABLE docs(id INTEGER PRIMARY KEY, emb BLOB)');
        // Bulk insert in chunks to keep the load phase quick.
        const CHUNK = 250;
        for (let start = 0; start < N; start += CHUNK) {
            const values: string[] = [];
            for (let i = start; i < Math.min(start + CHUNK, N); i++) {
                values.push(`(${i + 1}, vector_as_f32('${JSON.stringify(data[i])}'))`);
            }
            await db.execRaw(`INSERT INTO docs(id, emb) VALUES ${values.join(',')}`);
        }
        await db.execRaw(`SELECT vector_init('docs','emb','dimension=${DIM}, distance=cosine')`);
    }, 120_000);

    afterAll(async () => {
        await db.close();
    });

    it('TurboQuant index: smaller memory, high recall, faster preloaded scan', async () => {
        const qbits = 4;
        const rows = await db
            .execRaw(`SELECT vector_quantize('docs','emb','qtype=turbo,qbits=${qbits}') AS v`)
            .then((r) => Number(r.rows[0].v));
        expect(rows).toBe(N);

        // --- memory ---
        const quantBytes = Number(
            (await db.execRaw(`SELECT vector_quantize_memory('docs','emb') AS v`)).rows[0].v,
        );
        const rawBytes = N * DIM * 4; // exact f32 vectors
        const codeBytes = Math.ceil((DIM * qbits) / 8);
        const rotationBytes = DIM * DIM * 4; // transient: regenerated per scan, not stored
        const ratio = rawBytes / quantBytes;

        // --- recall (exact full_scan is ground truth) ---
        let recallSum = 0;
        for (const q of queries) {
            const exact = new Set(await topKIds(db, 'vector_full_scan', q, K));
            const approx = await topKIds(db, 'vector_quantize_scan', q, K);
            recallSum += approx.filter((id) => exact.has(id)).length / K;
        }
        const recall = recallSum / queries.length;

        // --- latency ---
        await timeScan(db, 'vector_full_scan', queries.slice(0, 3), K); // warm
        const full = await timeScan(db, 'vector_full_scan', queries, K);
        const quantDisk = await timeScan(db, 'vector_quantize_scan', queries, K);
        await db.execRaw(`SELECT vector_quantize_preload('docs','emb')`);
        const quantMem = await timeScan(db, 'vector_quantize_scan', queries, K);

        // Always emitted (process.stdout.write isn't intercepted by vitest,
        // so the report shows even when the test passes).
        process.stdout.write(
            '\n' +
                [
                    ``,
                    `TurboQuant perf — N=${N} vectors, dim=${DIM}, qbits=${qbits}, k=${K}, ${QUERIES} queries`,
                    `  memory  raw f32 ........ ${(rawBytes / 1024).toFixed(0)} KB ` +
                        `(${DIM * 4} B/vec)`,
                    `          quantized store  ${(quantBytes / 1024).toFixed(0)} KB ` +
                        `(${quantBytes / N} B/vec = 8 rowid + 4 scale + ${codeBytes} code)`,
                    `          compression .... ${ratio.toFixed(1)}x smaller`,
                    `          rotation matrix  ${(rotationBytes / 1024).toFixed(0)} KB transient (not stored)`,
                    `  recall  @${K} .......... ${(recall * 100).toFixed(1)}% vs exact`,
                    `  latency full_scan ...... ${full.median.toFixed(2)} ms/query (median, exact)`,
                    `          quantize_scan .. ${quantDisk.median.toFixed(2)} ms/query (shadow table)`,
                    `          quantize_scan .. ${quantMem.median.toFixed(2)} ms/query (preloaded, in-RAM)`,
                    `          preload win .... ${(quantDisk.median / quantMem.median).toFixed(2)}x vs shadow-table scan`,
                    `          vs full_scan ... ${(full.median / quantMem.median).toFixed(2)}x (preloaded; >1 = quantized faster)`,
                    `  note: both scans are O(N·d) — TurboQuant is quantization, not an ANN index,`,
                    `        so this is a constant-factor (memory-bandwidth) play, never sublinear.`,
                    `        f32 corpus = ${(rawBytes / 1024 / 1024).toFixed(1)} MB; quantized = ${(quantBytes / 1024 / 1024).toFixed(1)} MB.`,
                    `        The latency edge needs the f32 set to exceed cache; in-cache the exact`,
                    `        scan is already sub-ms and the bit-unpack/rotation overhead dominates.`,
                    ``,
                ].join('\n') +
                '\n',
        );

        // The index demonstrably compresses and preserves quality...
        expect(ratio).toBeGreaterThanOrEqual(4);
        expect(quantBytes).toBeLessThan(rawBytes);
        expect(recall).toBeGreaterThanOrEqual(0.9);
        // ...and preloading the codes into RAM beats stepping the shadow
        // table through SQL (the candidate stage avoids N sqlite steps).
        expect(quantMem.median).toBeLessThanOrEqual(quantDisk.median * 1.15);
    }, 120_000);
});
