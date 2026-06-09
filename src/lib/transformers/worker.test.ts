import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { describe, expect, it, beforeAll, afterEach, vi } from 'vitest';
import { env, pipeline, type TokenClassificationPipeline } from '@huggingface/transformers';
import { TransformersAccessor } from './worker';
import { NER_CACHE_NAME } from '@/lib/bert-ner/runtime';

// build.py writes the ONNX deploy tree to src/assets/transformers (served under
// TRANSFORMERS_ASSET_BASE). The ONNX-pipeline suite below is skipped unless `make
// transformers` populated it. This is the model behind the COMPARISON path
// (analyzeOnnx); the production NER engine is the `semantic` C/wasm one.
const DEPLOY_DIR = fileURLToPath(new URL('../../../src/assets/transformers/', import.meta.url));

// https://huggingface.co/gravitee-io/bert-small-pii-detection
const PII_MODEL_ID = 'gravitee-io/bert-small-pii-detection';

const SAMPLE =
    'Hi, my name is Alice Smith and I live at 742 Evergreen Terrace, Springfield, OR 62704, USA. ' +
    'You can reach me on +1 (415) 555-0132 or at alice.smith@example.com. ' +
    'My account number is 8810-447-2219.';

// Reproduce the user-reported failure: pasting the sample ~11 times tokenises
// well past the model's 512 position-embedding limit.
const LONG_SAMPLE = SAMPLE.repeat(11);

const HAS_PII_MODEL = existsSync(`${DEPLOY_DIR}${PII_MODEL_ID}/onnx/model.onnx`);

// Replicates what `bootOnnxPipe` does (the analyzeOnnx comparison path), minus the
// browser-only asset-base wiring. The truncation override (the actual fix) is also
// applied here so the test exercises that behaviour.
async function bootLikeWorker(): Promise<TokenClassificationPipeline> {
    env.localModelPath = DEPLOY_DIR;
    env.allowLocalModels = true;
    env.allowRemoteModels = false;
    const pipe = (await pipeline('token-classification', PII_MODEL_ID, {
        dtype: 'fp32',
    })) as TokenClassificationPipeline;
    const cfg = (pipe.model as unknown as { config: { max_position_embeddings?: number } }).config;
    const max = cfg.max_position_embeddings;
    if (typeof max === 'number' && max > 0) {
        (
            pipe.tokenizer as unknown as { _tokenizerConfig: { model_max_length: number } }
        )._tokenizerConfig.model_max_length = max;
    }
    return pipe;
}

describe.skipIf(!HAS_PII_MODEL)('onnx comparison pipeline (long input)', () => {
    let pipe: TokenClassificationPipeline;

    beforeAll(async () => {
        pipe = await bootLikeWorker();
    }, 60_000);

    it('does not throw on input longer than the model context', async () => {
        // Without the model_max_length override, BERT-small (512 position
        // embeddings) crashes ORT broadcasting against the longer sequence.
        const out = await pipe(LONG_SAMPLE, {
            aggregation_strategy: 'none',
            ignore_labels: [],
        } as never);
        expect(Array.isArray(out)).toBe(true);
    }, 60_000);

    it('still works on a short input afterwards', async () => {
        const out = (await pipe(SAMPLE, {
            aggregation_strategy: 'none',
            ignore_labels: [],
        } as never)) as Array<{
            word: string;
        }>;
        expect(out.some((t) => t.word.toLowerCase().includes('alice'))).toBe(true);
    }, 60_000);
});

// The production accessor now backs 'pii' with the semantic C/wasm engine: model
// size is the GGUF asset's Content-Length, and isCached probes the browser Cache
// the GGUF is stored under (NER_CACHE_NAME) — no ONNX manifest involved.
describe('TransformersAccessor.modelSizeBytes (GGUF asset)', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('HEADs the GGUF asset URL and returns its Content-Length', async () => {
        const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
            expect(init?.method).toBe('HEAD');
            return Promise.resolve(
                new Response(null, { status: 200, headers: { 'content-length': '30901664' } }),
            );
        });
        vi.stubGlobal('fetch', fetchMock);
        const size = await new TransformersAccessor().modelSizeBytes('pii');
        expect(size).toBe(30901664);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('throws on a 404 (wrong path) instead of silently returning null', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(() => Promise.resolve(new Response(null, { status: 404 }))),
        );
        await expect(new TransformersAccessor().modelSizeBytes('pii')).rejects.toThrow(/HTTP 404/);
    });

    it('returns null when an OK response omits Content-Length', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(() => Promise.resolve(new Response(null, { status: 200 }))),
        );
        expect(await new TransformersAccessor().modelSizeBytes('pii')).toBeNull();
    });
});

describe('TransformersAccessor.isCached (browser Cache)', () => {
    afterEach(() => vi.unstubAllGlobals());

    // A cache hit must carry valid GGUF magic ("GGUF") — isCached now validates the
    // cached bytes so a poisoned (HTML) entry reads as not-cached.
    const GGUF_MAGIC = new Uint8Array([0x47, 0x47, 0x55, 0x46]);
    function stubCaches(hit: boolean) {
        const cache = {
            match: vi.fn(() => Promise.resolve(hit ? new Response(GGUF_MAGIC) : undefined)),
        };
        const open = vi.fn(() => Promise.resolve(cache));
        vi.stubGlobal('caches', { open });
        return { cache, open };
    }

    it('returns false when the Cache API is unavailable', async () => {
        vi.stubGlobal('caches', undefined);
        expect(await new TransformersAccessor().isCached('pii')).toBe(false);
    });

    it('returns true when the GGUF is in the browser cache', async () => {
        const { open } = stubCaches(true);
        expect(await new TransformersAccessor().isCached('pii')).toBe(true);
        // Must probe the same named cache the runtime stores the GGUF under.
        expect(open).toHaveBeenCalledWith(NER_CACHE_NAME);
    });

    it('returns false when the GGUF is not cached', async () => {
        stubCaches(false);
        expect(await new TransformersAccessor().isCached('pii')).toBe(false);
    });

    it('treats a poisoned (HTML) cache entry as not-cached', async () => {
        // The dev server answers an unknown asset with the SPA index.html (HTTP
        // 200); if that got cached under the GGUF URL, isCached must NOT report it
        // as a ready model (the loader evicts + refetches).
        const cache = {
            match: vi.fn(() => Promise.resolve(new Response('<!doctype html><html></html>'))),
        };
        vi.stubGlobal('caches', { open: vi.fn(() => Promise.resolve(cache)) });
        expect(await new TransformersAccessor().isCached('pii')).toBe(false);
    });
});
