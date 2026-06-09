/**
 * Browser-testbed coverage for the PII NER path — the production setup end to end:
 * the `semantic` C/wasm token-classification engine running inside the Transformers
 * SharedWorker (via the Comlink accessor), the regex pass, and the overlap merge.
 *
 *   1. quality    — detection micro-F1 of `analyze` (C engine + regex) over the
 *      hand-labeled PII dataset; confirms the SharedWorker swap works in the real
 *      browser, with real OPFS-less wasm + Cache-backed GGUF.
 *   2. C vs ONNX  — structural agreement + per-engine timing. `analyzeOnnx` is the
 *      comparison-only path that dynamic-imports transformers.js (never bundled
 *      into app pages); this is the in-browser parity proof, parallel to the
 *      embed-variants test.
 *
 * Soft-skips (logs + passes) when assets aren't built:
 *     make semantic && make ner-model   (C engine)
 *     make transformers                 (ONNX comparison)
 */

import type { TestDef } from './runner';
import { getTransformersAccessor } from '@/lib/transformers/client';
import {
    PII_DATASET,
    resolveSpans,
    scoreDetection,
    microScore,
    type PredSpan,
    type ResolvedSpan,
    type Score,
} from '@/lib/bert-ner/pii-dataset';

const toPreds = (entities: { entity_type: string; start: number; end: number }[]): PredSpan[] =>
    entities.map((e) => ({ entity_type: e.entity_type, start: e.start, end: e.end }));

/** Treat one engine's entities as the "gold" the other is scored against. */
const asGold = (entities: { entity_type: string; start: number; end: number }[]): ResolvedSpan[] =>
    entities.map((e) => ({ type: e.entity_type, start: e.start, end: e.end }));

export const BERT_NER_TESTS: TestDef[] = [
    {
        id: 'bert-ner-quality',
        name: 'bert-ner (C/wasm): PII detection micro-F1 over the labeled dataset',
        // First run fetches the ~31 MB GGUF (then Cache-backed).
        timeoutMs: 300_000,
        fn: async (ctx) => {
            const acc = getTransformersAccessor();
            try {
                await acc.warmup('pii');
            } catch (e) {
                ctx.log(
                    `NER assets not built (run \`make semantic && make ner-model\`); skipping — ${
                        e instanceof Error ? e.message : String(e)
                    }`,
                );
                return;
            }
            ctx.expect.truthy(await acc.isWarm('pii'), 'NER engine warmed up');

            const det: Score[] = [];
            let inferTotal = 0;
            for (const c of PII_DATASET) {
                const { entities, stats } = await acc.analyze(c.text, { withSources: true });
                inferTotal += stats.inferMs;
                det.push(scoreDetection(toPreds(entities), resolveSpans(c)));
            }
            const s = microScore(det);
            ctx.log(
                `detection micro-F1 ${s.f1.toFixed(3)} (P=${s.precision.toFixed(3)} R=${s.recall.toFixed(3)}) ` +
                    `over ${PII_DATASET.length} cases · avg infer ${(inferTotal / PII_DATASET.length).toFixed(1)} ms`,
            );
            ctx.expect.truthy(s.f1 >= 0.78, `detection micro-F1 ${s.f1.toFixed(3)} ≥ 0.78`);
            ctx.expect.truthy(s.recall >= 0.85, `recall ${s.recall.toFixed(3)} ≥ 0.85`);
        },
    },
    {
        id: 'bert-ner-vs-onnx',
        name: 'bert-ner C vs ONNX: structural agreement + throughput head-to-head',
        // Downloads the ONNX model (~109 MB) on first run.
        timeoutMs: 600_000,
        fn: async (ctx) => {
            const acc = getTransformersAccessor();
            try {
                await acc.warmup('pii');
            } catch (e) {
                ctx.log(
                    `NER C engine not built (run \`make semantic && make ner-model\`); skipping — ${
                        e instanceof Error ? e.message : String(e)
                    }`,
                );
                return;
            }

            // Probe the ONNX comparison path once; skip if transformers assets absent.
            try {
                await acc.analyzeOnnx('warmup probe');
            } catch (e) {
                ctx.log(
                    `ONNX comparison unavailable (run \`make transformers\`); skipping — ${
                        e instanceof Error ? e.message : String(e)
                    }`,
                );
                return;
            }

            // Use the entity-bearing subset (skip the negatives — agreement is only
            // meaningful where there's PII to agree on).
            const cases = PII_DATASET.filter((c) => c.spans.length > 0);
            const agree: Score[] = [];
            let cMs = 0;
            let onnxMs = 0;
            for (const c of cases) {
                const cRes = await acc.analyze(c.text, { withSources: true });
                const oRes = await acc.analyzeOnnx(c.text, { withSources: true });
                cMs += cRes.stats.inferMs;
                onnxMs += oRes.stats.inferMs;
                // Agreement: C entities scored against ONNX entities as "gold".
                agree.push(scoreDetection(toPreds(cRes.entities), asGold(oRes.entities)));
            }
            const ag = microScore(agree);
            const cAvg = cMs / cases.length;
            const onnxAvg = onnxMs / cases.length;
            ctx.log(
                `C↔ONNX structural agreement F1 ${ag.f1.toFixed(3)} over ${cases.length} cases`,
            );
            ctx.log(
                `infer: C ${cAvg.toFixed(1)} ms/text · ONNX ${onnxAvg.toFixed(1)} ms/text · ` +
                    (onnxAvg >= cAvg
                        ? `C ${(onnxAvg / cAvg).toFixed(2)}× faster`
                        : `ONNX ${(cAvg / onnxAvg).toFixed(2)}× faster`),
            );
            // The two engines run the SAME weights; entity sets should largely agree
            // (q8_0 vs fp32 + tokenizer edge cases cause minor drift).
            ctx.expect.truthy(ag.f1 >= 0.85, `C/ONNX agreement F1 ${ag.f1.toFixed(3)} ≥ 0.85`);
            ctx.expect.truthy(cAvg > 0 && onnxAvg > 0, 'both engines produced timings');
        },
    },
];
