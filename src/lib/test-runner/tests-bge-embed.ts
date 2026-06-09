/**
 * Browser-testbed coverage for the bge-embed engine (the self-contained C
 * bge-small-en-v1.5 in bge-embed.wasm; see wasm/bge-embed/).
 *
 *   1. throughput  — single-thread ms/passage over a uniform corpus.
 *   2. generation  — vectors are L2-normalized and semantically structured
 *      (synonyms beat unrelated pairs).
 *   3. agreement   — bge-embed (q8_0 weights, f32 compute) vs ONNX async
 *      (q8, transformers.js pipeline). Same model, different quantization
 *      scheme; cosine must stay ≥ 0.97. Loaded dynamically so the ONNX
 *      pipeline is only fetched when this test actually runs.
 *
 * Soft-skips (logs + passes) when bge-embed.wasm / the GGUF aren't built:
 *     make bge-embed && make embed-model
 */

import type { TestDef } from './runner';
import {
    warmupBgeEmbed,
    embedTextsSync,
    isBgeEmbedReady,
    bgeDim,
    benchBgeEmbed,
} from '@/lib/bge-embed/runtime';

const SAMPLES = [
    'The cat sat quietly on the warm windowsill.', // 0 ~ 1
    'A feline rested calmly by the sunny window.', // 1 ~ 0
    'Quarterly revenue grew 12% year over year.', // 2 ~ 3
    'Our Q3 sales rose compared with the prior year.', // 3 ~ 2
];

const LOREM =
    'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat'.split(
        ' ',
    );

function makeCorpus(count: number, words: number): string[] {
    const out: string[] = [];
    for (let i = 0; i < count; i++) {
        const w: string[] = [];
        for (let k = 0; k < words; k++) w.push(LOREM[(i * 7 + k * 13) % LOREM.length]!);
        out.push(w.join(' '));
    }
    return out;
}

/** Vectors come back L2-normalized, so cosine == dot product. */
function dot(a: number[], b: number[]): number {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
    return s;
}

function meanPairwiseCosine(a: number[][], b: number[][]): number {
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += dot(a[i]!, b[i]!);
    return sum / a.length;
}

export const BGE_EMBED_TESTS: TestDef[] = [
    {
        id: 'bge-embed-engine',
        name: 'bge-embed (self-contained C/wasm): throughput + generation + ONNX agreement',
        // First run fetches the ~67 MB GGUF (then browser-cached).
        timeoutMs: 300_000,
        fn: async (ctx) => {
            try {
                await warmupBgeEmbed();
            } catch (e) {
                ctx.log(
                    `bge-embed assets not built (run \`make semantic && make embed-model\`); skipping — ${
                        e instanceof Error ? e.message : String(e)
                    }`,
                );
                return;
            }
            ctx.expect.truthy(isBgeEmbedReady(), 'bge-embed warmed up');
            ctx.expect.equal(bgeDim(), 384, 'output dimensionality is 384');

            // --- throughput + head-to-head vs the bare-ORT single-thread baseline
            // (`ort-wasm-simd-threaded.wasm`, numThreads:1 — what sync query
            // embedding used before bge-embed). BOTH are measured here, on the SAME
            // corpus, in the SAME warm run, with the SAME protocol (repeats sweeps,
            // each side warmed untimed first), so the ratio is real — not a
            // cross-test / cross-moment / different-warmth artifact. ---
            const corpus = makeCorpus(32, 30);
            const REPEATS = 3; // average several sweeps so the ratio is stable
            const bench = benchBgeEmbed(corpus, SAMPLES, {
                repeats: REPEATS,
                onLog: (m) => ctx.log(m),
            });
            ctx.log(
                `--- bge-embed (q8_0, f32 SIMD+FMA) single-thread: ${bench.msPerPassage.toFixed(1)} ms/passage · ` +
                    `${bench.passagesPerSec.toFixed(1)} passages/s · warmup ${bench.warmupMs.toFixed(0)} ms ---`,
            );

            // --- generation correctness ---
            ctx.expect.equal(bench.sampleVectors.length, SAMPLES.length, 'embedded all samples');
            for (let i = 0; i < bench.sampleVectors.length; i++) {
                const n = dot(bench.sampleVectors[i]!, bench.sampleVectors[i]!);
                ctx.expect.truthy(
                    Math.abs(n - 1) < 1e-3,
                    `sample ${i} is L2-normalized (‖v‖² ${n.toFixed(4)} ≈ 1)`,
                );
            }
            const within =
                (dot(bench.sampleVectors[0]!, bench.sampleVectors[1]!) +
                    dot(bench.sampleVectors[2]!, bench.sampleVectors[3]!)) /
                2;
            const cross =
                (dot(bench.sampleVectors[0]!, bench.sampleVectors[2]!) +
                    dot(bench.sampleVectors[1]!, bench.sampleVectors[3]!)) /
                2;
            ctx.log(`within-pair ${within.toFixed(3)} vs cross-pair ${cross.toFixed(3)}`);
            ctx.expect.truthy(
                within > cross + 0.05,
                `synonyms (${within.toFixed(3)}) score above unrelated (${cross.toFixed(3)})`,
            );

            // --- agreement with the ONNX async path ---
            // Dynamically imported so the ONNX pipeline is only fetched when
            // this test actually runs — not bundled into the tests page chunk.
            try {
                const { warmupOnnxEmbed, onnxEmbed } = await import('./onnx-embed');
                await warmupOnnxEmbed();
                const onnxVecs = await onnxEmbed(SAMPLES);
                const cos = meanPairwiseCosine(bench.sampleVectors, onnxVecs);
                ctx.log(`bge-embed(q8_0) vs ONNX(q8) mean cosine = ${cos.toFixed(4)} (≥ 0.97)`);
                ctx.expect.truthy(
                    cos >= 0.97,
                    `bge-embed agrees with ONNX on the same model (cosine ${cos.toFixed(4)} ≥ 0.97)`,
                );
            } catch (e) {
                ctx.log(
                    `ONNX embeddings unavailable (run \`make transformers\`); skipping agreement — ${
                        e instanceof Error ? e.message : String(e)
                    }`,
                );
            }
        },
    },
    {
        id: 'bge-embed-vs-onnx-perf',
        name: 'bge-embed vs ONNX runtime: throughput head-to-head',
        // Downloads the ONNX model (~33 MB) + bge-embed GGUF (~35 MB) on first run.
        timeoutMs: 600_000,
        fn: async (ctx) => {
            // ---------- bge-embed ----------
            try {
                await warmupBgeEmbed();
            } catch (e) {
                ctx.log(
                    `bge-embed assets not built (run \`make semantic && make embed-model\`); skipping — ${
                        e instanceof Error ? e.message : String(e)
                    }`,
                );
                return;
            }

            // ---------- ONNX pipeline ----------
            let warmupOnnxEmbed: (() => Promise<void>) | null = null;
            let onnxEmbed: ((texts: string[]) => Promise<number[][]>) | null = null;
            try {
                const mod = await import('./onnx-embed');
                warmupOnnxEmbed = mod.warmupOnnxEmbed;
                onnxEmbed = mod.onnxEmbed;
                await warmupOnnxEmbed();
            } catch (e) {
                ctx.log(
                    `ONNX pipeline unavailable (run \`make transformers\`); skipping — ${
                        e instanceof Error ? e.message : String(e)
                    }`,
                );
                return;
            }

            // Same corpus, same protocol for both engines: one untimed warmup
            // pass, then REPEATS full sweeps timed inside ONE bracket so
            // performance.now()'s privacy coarsening is paid exactly once.
            const corpus = makeCorpus(32, 30);
            const REPEATS = 3;

            // -- bge-embed: sequential (one text at a time, internal C loop) --
            embedTextsSync(corpus); // warmup untimed
            const bgeT0 = performance.now();
            for (let r = 0; r < REPEATS; r++) embedTextsSync(corpus);
            const bgeTotalMs = performance.now() - bgeT0;
            const bgeMsPerPassage = bgeTotalMs / (REPEATS * corpus.length);

            // -- ONNX full-batch: all texts in one pipeline call (transformer
            //    processes the whole batch in parallel) --
            await onnxEmbed(corpus); // warmup untimed
            const onnxBatchT0 = performance.now();
            for (let r = 0; r < REPEATS; r++) await onnxEmbed(corpus);
            const onnxBatchMs = (performance.now() - onnxBatchT0) / (REPEATS * corpus.length);

            // -- ONNX sequential: one text per call (same access pattern as
            //    bge-embed — apples-to-apples single-text latency) --
            await onnxEmbed([corpus[0]!]); // warmup untimed
            const onnxSeqT0 = performance.now();
            for (let r = 0; r < REPEATS; r++) {
                for (const text of corpus) await onnxEmbed([text]);
            }
            const onnxSeqMs = (performance.now() - onnxSeqT0) / (REPEATS * corpus.length);

            const fmt = (ms: number) => `${ms.toFixed(1)} ms/passage (${Math.round(1000 / ms)}/s)`;
            const ratio = (onnxMs: number) => {
                const r = onnxMs / bgeMsPerPassage;
                return r >= 1
                    ? `bge-embed ${r.toFixed(2)}× faster`
                    : `ONNX ${(1 / r).toFixed(2)}× faster`;
            };

            ctx.log(`corpus: ${corpus.length} passages × 30 words, ${REPEATS} repeats`);
            ctx.log(`bge-embed  (sequential)  : ${fmt(bgeMsPerPassage)}`);
            ctx.log(`ONNX       (full batch)  : ${fmt(onnxBatchMs)}  →  ${ratio(onnxBatchMs)}`);
            ctx.log(`ONNX       (sequential)  : ${fmt(onnxSeqMs)}  →  ${ratio(onnxSeqMs)}`);

            // Only assert on correctness, not absolute perf numbers (machine-dependent).
            ctx.expect.truthy(bgeMsPerPassage > 0, 'bge-embed produced a timing');
            ctx.expect.truthy(onnxBatchMs > 0, 'ONNX batch produced a timing');
        },
    },
];
