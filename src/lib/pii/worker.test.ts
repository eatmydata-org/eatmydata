import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { describe, expect, it, beforeAll, afterEach, vi } from 'vitest';
import { env, pipeline, type TokenClassificationPipeline } from '@huggingface/transformers';
import { PiiAccessor } from './worker';

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

describe('PiiAccessor.modelSizeBytes', () => {
    // Minimal manifest — modelSizeBytes only reads model_id/model_file.
    const MANIFEST = {
        model_id: 'mozilla-ai/tiny-pii-tinyBERT-general-4L-312D',
        model_file: 'onnx/model.onnx',
    };
    // ASSET_BASE = PII_ASSET_BASE; vitest.config pins it to '/test/tiny-pii'.
    const BASE = '/test/tiny-pii';

    afterEach(() => vi.unstubAllGlobals());

    function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
        const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
            Promise.resolve(handler(String(input), init)),
        );
        vi.stubGlobal('fetch', fn);
        return fn;
    }

    it('HEADs the versioned ASSET_BASE and returns Content-Length', async () => {
        const fetchMock = stubFetch((url, init) => {
            if (url.endsWith('/manifest.json')) {
                return new Response(JSON.stringify(MANIFEST), { status: 200 });
            }
            expect(init?.method).toBe('HEAD');
            return new Response(null, {
                status: 200,
                headers: { 'content-length': '17825792' },
            });
        });

        const size = await new PiiAccessor().modelSizeBytes();

        expect(size).toBe(17825792);
        // The model probe must hit the same versioned base the model
        // loads from — NOT a bare `/tiny-pii/...` path (the old bug).
        const modelUrl = fetchMock.mock.calls
            .map((c) => String(c[0]))
            .find((u) => u.endsWith('model.onnx'));
        expect(modelUrl).toBe(`${BASE}/${MANIFEST.model_id}/${MANIFEST.model_file}`);
    });

    it('throws on a 404 (wrong path) instead of silently returning null', async () => {
        stubFetch((url) =>
            url.endsWith('/manifest.json')
                ? new Response(JSON.stringify(MANIFEST), { status: 200 })
                : new Response(null, { status: 404 }),
        );

        await expect(new PiiAccessor().modelSizeBytes()).rejects.toThrow(/HTTP 404/);
    });

    it('returns null when an OK response omits Content-Length', async () => {
        stubFetch((url) =>
            url.endsWith('/manifest.json')
                ? new Response(JSON.stringify(MANIFEST), { status: 200 })
                : new Response(null, { status: 200 }),
        );

        expect(await new PiiAccessor().modelSizeBytes()).toBeNull();
    });
});

describe('PiiAccessor.isCached', () => {
    const MANIFEST = {
        model_id: 'gravitee-io/bert-small-pii-detection',
        model_file: 'onnx/model.onnx',
    };
    // ASSET_BASE = PII_ASSET_BASE; vitest pins it to '/test/tiny-pii'. This is
    // the same URL `modelSizeBytes` probes AND the key transformers.js stores
    // the fetched model file under.
    const MODEL_URL = `/test/tiny-pii/${MANIFEST.model_id}/${MANIFEST.model_file}`;

    afterEach(() => vi.unstubAllGlobals());

    function stubManifest() {
        vi.stubGlobal(
            'fetch',
            vi.fn((input: RequestInfo | URL) =>
                Promise.resolve(
                    String(input).endsWith('/manifest.json')
                        ? new Response(JSON.stringify(MANIFEST), { status: 200 })
                        : new Response(null, { status: 404 }),
                ),
            ),
        );
    }

    // Minimal Cache API double: a Set of stored URL keys, with `match`
    // (exact) and `keys` (Request list) — the two methods isCached touches.
    function stubCaches(stored: Set<string>) {
        const cache = {
            match: vi.fn((url: string) =>
                Promise.resolve(stored.has(url) ? new Response(null) : undefined),
            ),
            keys: vi.fn(() =>
                Promise.resolve(
                    [...stored].map((u) => new Request(new URL(u, 'https://app.example'))),
                ),
            ),
        };
        const open = vi.fn(() => Promise.resolve(cache));
        vi.stubGlobal('caches', { open });
        return { cache, open };
    }

    it('returns false when the Cache API is unavailable', async () => {
        vi.stubGlobal('caches', undefined);
        expect(await new PiiAccessor().isCached()).toBe(false);
    });

    it('returns true when the model file is in the browser cache', async () => {
        stubManifest();
        const { open } = stubCaches(new Set([MODEL_URL]));
        expect(await new PiiAccessor().isCached()).toBe(true);
        // Must probe the *same* cache transformers writes to, not a guess.
        expect(open).toHaveBeenCalledWith(env.cacheKey);
    });

    it('matches a normalized/absolute cache key via the keys() fallback', async () => {
        stubManifest();
        // Stored under the fully-resolved absolute URL — exact match misses,
        // the endsWith(keys) fallback still finds it.
        stubCaches(new Set([`https://app.example${MODEL_URL}`]));
        expect(await new PiiAccessor().isCached()).toBe(true);
    });

    it('returns false when the model file is not cached', async () => {
        stubManifest();
        stubCaches(new Set());
        expect(await new PiiAccessor().isCached()).toBe(false);
    });
});
