import { describe, expect, it } from 'vitest';
import {
    allModels,
    CHROME_AI_MODEL_ID,
    defaultProviders,
    findModelEntryIn,
    mergeWithDefaults,
    modelKey,
    OPENROUTER_PROVIDER_ID,
    splitModelId,
    type ProviderInstance,
    type Settings,
} from './settings-types';

const validId = defaultProviders()[0]!.models[0]!.id;
const googleProvider = () => defaultProviders().find((p) => p.kind === 'google-ai-studio')!;
const chromeDisabled = (): ProviderInstance[] =>
    defaultProviders().map((p) => (p.kind === 'chrome-ai' ? { ...p, enabled: false } : p));

describe('splitModelId', () => {
    it('splits on the FIRST colon so :free slugs survive', () => {
        expect(splitModelId('openrouter:openai/gpt-oss-120b:free')).toEqual({
            providerId: 'openrouter',
            modelId: 'openai/gpt-oss-120b:free',
        });
    });
    it('handles ids without a colon', () => {
        expect(splitModelId('bare')).toEqual({ providerId: '', modelId: 'bare' });
    });
});

describe('mergeWithDefaults — per-agent model fields', () => {
    it('fills new fields with defaults when absent from persisted settings', () => {
        const merged = mergeWithDefaults({});
        expect(merged.useOneModelForAll).toBe(true);
        expect(merged.agentModels).toEqual({});
        expect(merged.providers.length).toBeGreaterThan(0);
    });

    it('keeps valid agent overrides and drops ids not in any provider', () => {
        const merged = mergeWithDefaults({
            agentModels: { orchestrator: validId, planner: 'openrouter:does-not-exist' },
        });
        expect(merged.agentModels.orchestrator).toBe(validId);
        expect(merged.agentModels.planner).toBeUndefined();
    });

    it('accepts a model id from a different (enabled) provider', () => {
        const googleId = googleProvider().models[0]!.id;
        const merged = mergeWithDefaults({ agentModels: { planner: googleId } });
        expect(merged.agentModels.planner).toBe(googleId);
    });

    it('accepts the chrome-ai model id while its provider is enabled', () => {
        const merged = mergeWithDefaults({ agentModels: { coder: CHROME_AI_MODEL_ID } });
        expect(merged.agentModels.coder).toBe(CHROME_AI_MODEL_ID);
    });

    it('drops a chrome-ai override when its provider is disabled', () => {
        const merged = mergeWithDefaults({
            providers: chromeDisabled(),
            agentModels: { coder: CHROME_AI_MODEL_ID },
        });
        expect(merged.agentModels.coder).toBeUndefined();
    });

    it('snaps a chrome-ai default to the first enabled model when its provider is disabled', () => {
        const merged = mergeWithDefaults({
            providers: chromeDisabled(),
            defaultModelId: CHROME_AI_MODEL_ID,
        });
        expect(merged.defaultModelId).toBe(validId);
    });

    it('keeps a chrome-ai default model while its provider is enabled', () => {
        const merged = mergeWithDefaults({ defaultModelId: CHROME_AI_MODEL_ID });
        expect(merged.defaultModelId).toBe(CHROME_AI_MODEL_ID);
    });

    it('ignores non-string override values', () => {
        const merged = mergeWithDefaults({
            // @ts-expect-error — exercising malformed persisted data
            agentModels: { orchestrator: 123, planner: null },
        });
        expect(merged.agentModels).toEqual({});
    });

    it('coerces a non-boolean useOneModelForAll to the default', () => {
        const merged = mergeWithDefaults({
            // @ts-expect-error — exercising malformed persisted data
            useOneModelForAll: 'yes',
        });
        expect(merged.useOneModelForAll).toBe(true);
    });

    it('preserves an explicit useOneModelForAll: false', () => {
        const merged = mergeWithDefaults({ useOneModelForAll: false });
        expect(merged.useOneModelForAll).toBe(false);
    });
});

describe('mergeWithDefaults — legacy single-OpenRouter migration', () => {
    // The pre-multi-provider persisted shape.
    const legacy = {
        provider: 'openrouter',
        apiKey: 'sk-legacy',
        chromeAiEnabled: true,
        models: [
            {
                id: 'openrouter:foo/bar',
                label: 'Foo Bar',
                openRouterModelId: 'foo/bar',
                pricing: { prompt: 0.000001, completion: 0.000002 },
            },
            {
                id: 'openrouter:baz/qux:free',
                label: 'Baz (free)',
                openRouterModelId: 'baz/qux:free',
            },
        ],
        defaultModelId: 'openrouter:foo/bar',
        agentModels: { coder: 'openrouter:baz/qux:free' },
        useOneModelForAll: false,
    } as unknown as Partial<Settings>;

    it('folds the legacy apiKey + models into an OpenRouter provider', () => {
        const merged = mergeWithDefaults(legacy);
        const or = merged.providers.find((p) => p.id === OPENROUTER_PROVIDER_ID)!;
        expect(or.kind).toBe('openrouter');
        expect(or.apiKey).toBe('sk-legacy');
        expect(or.models).toEqual([
            {
                id: 'openrouter:foo/bar',
                modelId: 'foo/bar',
                label: 'Foo Bar',
                pricing: { prompt: 0.000001, completion: 0.000002 },
            },
            {
                id: modelKey(OPENROUTER_PROVIDER_ID, 'baz/qux:free'),
                modelId: 'baz/qux:free',
                label: 'Baz (free)',
            },
        ]);
    });

    it('keeps the existing fully-qualified default + agent ids valid through migration', () => {
        const merged = mergeWithDefaults(legacy);
        expect(merged.defaultModelId).toBe('openrouter:foo/bar');
        expect(merged.agentModels.coder).toBe('openrouter:baz/qux:free');
        expect(merged.useOneModelForAll).toBe(false);
    });

    it('strips legacy top-level keys so they never persist', () => {
        const merged = mergeWithDefaults(legacy) as unknown as Record<string, unknown>;
        expect(merged.apiKey).toBeUndefined();
        expect(merged.provider).toBeUndefined();
        expect(merged.chromeAiEnabled).toBeUndefined();
        expect(merged.models).toBeUndefined();
    });

    it('is idempotent — re-merging a migrated result is a no-op on providers', () => {
        const once = mergeWithDefaults(legacy);
        const twice = mergeWithDefaults(once);
        expect(twice.providers).toEqual(once.providers);
    });

    it('also migrates when only a legacy apiKey is present (no models array)', () => {
        const merged = mergeWithDefaults({ apiKey: 'sk-only' } as unknown as Partial<Settings>);
        const or = merged.providers.find((p) => p.id === OPENROUTER_PROVIDER_ID)!;
        expect(or.apiKey).toBe('sk-only');
        // Falls back to the default model list when none were persisted.
        expect(or.models.length).toBeGreaterThan(0);
    });
});

describe('allModels / findModelEntryIn', () => {
    it('flattens only enabled providers', () => {
        const all = allModels(defaultProviders());
        expect(all.some((m) => m.id === validId)).toBe(true);
        const noneEnabled = defaultProviders().map((p) => ({ ...p, enabled: false }));
        expect(allModels(noneEnabled)).toEqual([]);
    });

    it('resolves a model across providers, even a disabled one', () => {
        const entry = findModelEntryIn(chromeDisabled(), CHROME_AI_MODEL_ID);
        expect(entry.id).toBe(CHROME_AI_MODEL_ID);
    });

    it('falls back to the first enabled model for an unknown id', () => {
        const entry = findModelEntryIn(defaultProviders(), 'nope:nope');
        expect(entry.id).toBe(validId);
    });
});
