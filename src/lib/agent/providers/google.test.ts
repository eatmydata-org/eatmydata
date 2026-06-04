import { describe, expect, it } from 'vitest';
import { googleAdapter } from './google';
import {
    DEV_DEFAULT_GOOGLE_AI_STUDIO_KEY,
    type ProviderInstance,
} from '@/lib/runtime/state/settings-types';

const cfg = (apiKey?: string): ProviderInstance => ({
    id: 'google',
    kind: 'google-ai-studio',
    label: 'Google AI Studio',
    enabled: true,
    apiKey,
    models: [],
});

describe('googleAdapter.fetchPrices — committed static map', () => {
    it('applies known prices and omits unknown models', async () => {
        const prices = await googleAdapter.fetchPrices!(cfg(), [
            'gemini-2.5-flash',
            'totally-not-a-real-model',
        ]);
        expect(prices['gemini-2.5-flash']).toBeDefined();
        expect(prices['gemini-2.5-flash']!.prompt).toBeGreaterThan(0);
        expect(prices['gemini-2.5-flash']!.completion).toBeGreaterThan(0);
        expect(prices['totally-not-a-real-model']).toBeUndefined();
    });
});

describe('googleAdapter.testConnection — live', () => {
    // Uses the dev key already defined in settings-types (populated under
    // vitest since import.meta.env.DEV is true). Skips if it's ever empty.
    const KEY = DEV_DEFAULT_GOOGLE_AI_STUDIO_KEY;

    it.skipIf(!KEY)(
        'verifies the dev key against generativelanguage.googleapis.com',
        async () => {
            const r = await googleAdapter.testConnection(cfg(KEY));
            if (!r.ok) throw new Error(`expected ok, got ${r.message}`);
            expect(r.ok).toBe(true);
            expect(r.label).toMatch(/models/);
        },
        20_000,
    );

    it('reports a clear error when no key is set', async () => {
        const r = await googleAdapter.testConnection(cfg(''));
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.message).toMatch(/key/i);
    });
});
