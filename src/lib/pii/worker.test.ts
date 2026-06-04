import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { describe, expect, it, beforeAll } from 'vitest';
import { env, pipeline, type TokenClassificationPipeline } from '@huggingface/transformers';

const DEPLOY_DIR = fileURLToPath(new URL('../../../wasm/tiny-pii/build/deploy/', import.meta.url));

// https://huggingface.co/gravitee-io/bert-small-pii-detection
const MODEL_ID = 'gravitee-io/bert-small-pii-detection';

const SAMPLE =
    'Hi, my name is Alice Smith and I live at 742 Evergreen Terrace, Springfield, OR 62704, USA. ' +
    'You can reach me on +1 (415) 555-0132 or at alice.smith@example.com. ' +
    'My account number is 8810-447-2219.';

// Reproduce the user-reported failure: pasting the sample ~11 times tokenises
// well past the model's 512 position-embedding limit.
const LONG_SAMPLE = SAMPLE.repeat(11);

const HAS_LOCAL_MODEL = existsSync(`${DEPLOY_DIR}${MODEL_ID}/onnx/model.onnx`);

// Replicates what PiiAccessor.#boot does, minus the browser-only WASM /
// asset-base wiring that has no analogue in Node. The truncation override
// (the actual fix) is also applied here so the test exercises real worker
// behaviour, not just the stock pipeline.
async function bootLikeWorker(): Promise<TokenClassificationPipeline> {
    env.localModelPath = DEPLOY_DIR;
    env.allowLocalModels = true;
    env.allowRemoteModels = false;
    const pipe = (await pipeline('token-classification', MODEL_ID, {
        dtype: 'fp32',
    })) as TokenClassificationPipeline;
    const cfg = (
        pipe.model as unknown as {
            config: { max_position_embeddings?: number };
        }
    ).config;
    const max = cfg.max_position_embeddings;
    if (typeof max === 'number' && max > 0) {
        (
            pipe.tokenizer as unknown as {
                _tokenizerConfig: { model_max_length: number };
            }
        )._tokenizerConfig.model_max_length = max;
    }
    return pipe;
}

describe.skipIf(!HAS_LOCAL_MODEL)('tiny-pii pipeline (long input)', () => {
    let pipe: TokenClassificationPipeline;

    beforeAll(async () => {
        pipe = await bootLikeWorker();
    }, 60_000);

    it('does not throw on input longer than the model context', async () => {
        // Without the model_max_length override, BERT-small (512
        // position embeddings) crashes ORT broadcasting against the
        // longer sequence: "Attempting to broadcast an axis by a
        // dimension other than 1. 512 by N".
        const out = await pipe(LONG_SAMPLE, {
            aggregation_strategy: 'none',
            ignore_labels: [],
        } as never);
        expect(Array.isArray(out)).toBe(true);
    }, 60_000);

    it('still works on a short input afterwards', async () => {
        // Smoke for the "not recovering anymore" concern: a second
        // call on a normal-sized input must still succeed.
        const out = (await pipe(SAMPLE, {
            aggregation_strategy: 'none',
            ignore_labels: [],
        } as never)) as Array<{ word: string }>;
        expect(out.some((t) => t.word.toLowerCase().includes('alice'))).toBe(true);
    }, 60_000);
});
