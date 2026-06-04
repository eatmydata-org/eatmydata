import { describe, expect, it, vi } from 'vitest';
import type { ProviderInstance } from '@/lib/runtime/state/settings-types';

// Drive the registry off a mutable holder rather than the real IDB-backed store.
const providersHolder: { current: ProviderInstance[] } = { current: [] };
vi.mock('@/lib/runtime/state/settings', () => ({
    getSettings: () => ({ providers: providersHolder.current }),
}));

const { getRegistry } = await import('./registry');

const openrouter = (id: string, apiKey: string): ProviderInstance => ({
    id,
    kind: 'openrouter',
    label: id,
    apiKey,
    enabled: true,
    models: [{ id: `${id}:x/y`, modelId: 'x/y', label: 'XY' }],
});

describe('provider registry resolution', () => {
    it('resolves openrouter:<slug> to a CHAT model (not completion)', () => {
        providersHolder.current = [openrouter('openrouter', 'sk-test')];
        const model = getRegistry().languageModel('openrouter:x/y');
        expect(model.modelId).toBe('x/y');
        // The OpenRouter provider's `.languageModel` defaults every slug to
        // the chat model (only the legacy gpt-3.5-turbo-instruct goes to
        // completion) — lock that against a future provider bump.
        expect(model.constructor.name).toBe('OpenRouterChatLanguageModel');
    });

    it('splits on the FIRST colon so :free slugs resolve', () => {
        providersHolder.current = [openrouter('openrouter', 'sk-test')];
        const model = getRegistry().languageModel('openrouter:openai/gpt-oss-120b:free');
        expect(model.modelId).toBe('openai/gpt-oss-120b:free');
    });

    it('memoizes and rebuilds only when provider config changes', () => {
        providersHolder.current = [openrouter('openrouter', 'sk-1')];
        const r1 = getRegistry();
        expect(getRegistry()).toBe(r1); // same signature → cached
        providersHolder.current = [openrouter('openrouter', 'sk-2')]; // apiKey changed
        expect(getRegistry()).not.toBe(r1);
    });
});
