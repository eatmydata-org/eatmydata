import { describe, expect, it } from 'vitest';
import { parseOpenRouterPricing } from './openrouter-pricing';

describe('parseOpenRouterPricing', () => {
    it('returns an empty map when the payload has no data array', () => {
        expect(parseOpenRouterPricing(null)).toEqual({});
        expect(parseOpenRouterPricing({})).toEqual({});
        expect(parseOpenRouterPricing({ data: 'oops' })).toEqual({});
    });

    it('parses decimal-string prices into numbers', () => {
        const result = parseOpenRouterPricing({
            data: [
                {
                    id: 'openai/gpt-oss-120b:free',
                    pricing: { prompt: '0', completion: '0' },
                },
                {
                    id: 'z-ai/glm-4.7',
                    pricing: {
                        prompt: '0.0000003',
                        completion: '0.0000012',
                        internal_reasoning: '0.0000015',
                    },
                },
            ],
        });
        expect(result['openai/gpt-oss-120b:free']).toEqual({
            prompt: 0,
            completion: 0,
        });
        expect(result['z-ai/glm-4.7']).toEqual({
            prompt: 0.0000003,
            completion: 0.0000012,
            reasoning: 0.0000015,
        });
    });

    it('picks up cache-read pricing under either field name', () => {
        const r1 = parseOpenRouterPricing({
            data: [
                {
                    id: 'a/foo',
                    pricing: {
                        prompt: '1',
                        completion: '2',
                        input_cache_read: '0.5',
                    },
                },
            ],
        });
        expect(r1['a/foo']?.cacheRead).toBe(0.5);

        const r2 = parseOpenRouterPricing({
            data: [
                {
                    id: 'a/bar',
                    pricing: {
                        prompt: '1',
                        completion: '2',
                        cache_read: '0.25',
                    },
                },
            ],
        });
        expect(r2['a/bar']?.cacheRead).toBe(0.25);
    });

    it('skips malformed entries without crashing', () => {
        const result = parseOpenRouterPricing({
            data: [
                null,
                { /* no id */ pricing: { prompt: '1', completion: '2' } },
                { id: 'a/no-pricing' },
                {
                    id: 'a/non-numeric',
                    pricing: { prompt: 'abc', completion: 'def' },
                },
                {
                    id: 'a/ok',
                    pricing: { prompt: '0.5', completion: '1' },
                },
            ],
        });
        expect(Object.keys(result)).toEqual(['a/ok']);
        expect(result['a/ok']).toEqual({ prompt: 0.5, completion: 1 });
    });

    it('defaults missing prompt or completion to 0 when only one side is given', () => {
        const result = parseOpenRouterPricing({
            data: [
                { id: 'a/in-only', pricing: { prompt: '0.5' } },
                { id: 'a/out-only', pricing: { completion: '1' } },
            ],
        });
        expect(result['a/in-only']).toEqual({ prompt: 0.5, completion: 0 });
        expect(result['a/out-only']).toEqual({ prompt: 0, completion: 1 });
    });
});
