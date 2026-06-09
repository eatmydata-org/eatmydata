/**
 * NER quality gate: run the FULL production pipeline (the `semantic` C/wasm NER
 * engine + the regex pass + overlap merge, exactly as the app's `analyze` does)
 * over the hand-labeled PII dataset and measure micro-F1.
 *
 *   * detection F1 (headline): a gold span is caught if ANY predicted span overlaps
 *     it, type-agnostic — "did we flag the PII characters?".
 *   * typed F1 (secondary): overlap AND matching entity family.
 *
 * The thresholds are calibrated just under the measured values so a real
 * regression (a broken tokenizer/offset/quant) trips the gate while normal scoring
 * noise doesn't. The scores are logged so drift is visible in CI output.
 *
 * Imports the real worker accessor (`TransformersAccessor`) — in Node the worker's
 * `connect` listener self-skips (no `self`) and the ONNX comparison path is never
 * imported (it's behind a dynamic import). Soft-skips when assets are absent.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setBertNerLoaders } from './runtime';
import { TransformersAccessor } from '@/lib/transformers/worker';
import {
    PII_DATASET,
    resolveSpans,
    scoreDetection,
    scoreTyped,
    microScore,
    type PredSpan,
    type Score,
} from './pii-dataset';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../../..');
const WASM = resolve(ROOT, 'src/assets/wasm/semantic.wasm');
const GGUF_Q8 = resolve(ROOT, 'src/assets/models/bert-small-pii-detection-q8_0.gguf');
const GGUF_F32 = resolve(ROOT, 'src/assets/models/bert-small-pii-detection-f32.gguf');
const GGUF = existsSync(GGUF_Q8) ? GGUF_Q8 : GGUF_F32;

const ASSETS_PRESENT = existsSync(WASM) && existsSync(GGUF);
const d = describe.skipIf(!ASSETS_PRESENT);

// Calibrated just under the measured micro-F1 (detection ~0.82 / typed ~0.81 on the
// shipped q8_0 model; recall ~0.96). The small PII model + regex pass is the unit
// under test; these guard against regressions (broken tokenizer/offsets/quant would
// tank recall well below), not absolute SOTA. Inference is deterministic, so the
// headroom only absorbs future dataset/model tweaks.
const DETECTION_F1_MIN = 0.78;
const TYPED_F1_MIN = 0.72;

d('bert-ner PII quality (full pipeline)', () => {
    const acc = new TransformersAccessor();
    let detection: Score;
    let typed: Score;

    beforeAll(async () => {
        setBertNerLoaders({
            wasm: async () => await readFile(WASM),
            gguf: async () => new Uint8Array(await readFile(GGUF)),
        });
        const det: Score[] = [];
        const typ: Score[] = [];
        for (const c of PII_DATASET) {
            const { entities } = await acc.analyze(c.text, { withSources: true });
            const preds: PredSpan[] = entities.map((e) => ({
                entity_type: e.entity_type,
                start: e.start,
                end: e.end,
            }));
            const golds = resolveSpans(c);
            det.push(scoreDetection(preds, golds));
            typ.push(scoreTyped(preds, golds));
        }
        detection = microScore(det);
        typed = microScore(typ);
        // Visible in CI output for drift tracking.
        console.log(
            `[bert-ner quality] cases=${PII_DATASET.length} ` +
                `detection F1=${detection.f1.toFixed(3)} (P=${detection.precision.toFixed(3)} R=${detection.recall.toFixed(3)}) ` +
                `typed F1=${typed.f1.toFixed(3)} (P=${typed.precision.toFixed(3)} R=${typed.recall.toFixed(3)})`,
        );
    });

    it(`detection micro-F1 >= ${DETECTION_F1_MIN}`, () => {
        expect(detection.f1).toBeGreaterThanOrEqual(DETECTION_F1_MIN);
    });

    it(`type-aware micro-F1 >= ${TYPED_F1_MIN}`, () => {
        expect(typed.f1).toBeGreaterThanOrEqual(TYPED_F1_MIN);
    });

    it('every dataset case resolves its gold spans (label integrity)', () => {
        for (const c of PII_DATASET) expect(() => resolveSpans(c)).not.toThrow();
    });
});
