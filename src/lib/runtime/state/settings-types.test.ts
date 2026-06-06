import { describe, expect, it } from 'vitest';
import {
    allModels,
    buildProviders,
    CHROME_AI_MODEL_ID,
    defaultProviders,
    findModelEntryIn,
    mergeWithDefaults,
    OPENROUTER_PROVIDER_ID,
    resolveAgentModel,
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
    // The config default in the test fixture (= appConfig.defaultModelId).
    const configDefault = validId;

    it('fills new fields with defaults when absent from persisted settings', () => {
        const merged = mergeWithDefaults({});
        expect(merged.agentModels).toEqual({});
        expect(merged.apiKeys).toEqual({});
        expect(merged.providers.length).toBeGreaterThan(0);
        // No overrides → orchestrator (and thus defaultModelId) is the config default.
        expect(merged.defaultModelId).toBe(configDefault);
    });

    it('keeps raw agent picks (even one no longer in the catalog) — validity is deferred', () => {
        const merged = mergeWithDefaults({
            agentModels: { orchestrator: validId, planner: 'openrouter:does-not-exist' },
        });
        // Both retained verbatim in IDB; resolveAgentModel handles validity.
        expect(merged.agentModels.orchestrator).toBe(validId);
        expect(merged.agentModels.planner).toBe('openrouter:does-not-exist');
    });

    it('accepts a model id from a different (enabled) provider', () => {
        const googleId = googleProvider().models[0]!.id;
        const merged = mergeWithDefaults({ agentModels: { planner: googleId } });
        expect(merged.agentModels.planner).toBe(googleId);
    });

    it('defaultModelId tracks the orchestrator pick (orchestrator = primary)', () => {
        const googleId = googleProvider().models[0]!.id;
        const merged = mergeWithDefaults({ agentModels: { orchestrator: googleId } });
        expect(merged.defaultModelId).toBe(googleId);
    });

    it('defaultModelId falls back to the config default when the orchestrator pick left the catalog', () => {
        const merged = mergeWithDefaults({ agentModels: { orchestrator: 'openrouter:gone' } });
        expect(merged.defaultModelId).toBe(configDefault);
        // The raw pick is still retained for if/when that model returns.
        expect(merged.agentModels.orchestrator).toBe('openrouter:gone');
    });

    it('ignores non-string override values', () => {
        const merged = mergeWithDefaults({
            // @ts-expect-error — exercising malformed persisted data
            agentModels: { orchestrator: 123, planner: null },
        });
        expect(merged.agentModels).toEqual({});
    });
});

describe('resolveAgentModel', () => {
    const providers = defaultProviders();
    const configDefault = validId; // = appConfig.defaultModelId in the fixture

    it('returns a saved pick that is still in the enabled catalog', () => {
        const googleId = googleProvider().models[0]!.id;
        expect(resolveAgentModel(providers, { planner: googleId }, 'planner')).toBe(googleId);
        expect(resolveAgentModel(providers, { coder: CHROME_AI_MODEL_ID }, 'coder')).toBe(
            CHROME_AI_MODEL_ID,
        );
    });

    it('falls back to the config default when unset', () => {
        expect(resolveAgentModel(providers, {}, 'orchestrator')).toBe(configDefault);
    });

    it('falls back to the config default when the saved pick is not in the catalog', () => {
        expect(resolveAgentModel(providers, { coder: 'openrouter:gone' }, 'coder')).toBe(
            configDefault,
        );
    });

    it('falls back when the saved pick belongs to a disabled provider', () => {
        const disabled = providers.map((p) =>
            p.kind === 'chrome-ai' ? { ...p, enabled: false } : p,
        );
        expect(resolveAgentModel(disabled, { coder: CHROME_AI_MODEL_ID }, 'coder')).toBe(
            configDefault,
        );
    });
});

describe('mergeWithDefaults — catalog from @app-config, keys from persisted state', () => {
    it('always builds the catalog from the JSON config, ignoring a persisted providers array', () => {
        // A persisted "providers" blob with a bogus provider must NOT leak into
        // the catalog — only its keys are recovered.
        const merged = mergeWithDefaults({
            providers: [
                {
                    id: 'bogus',
                    kind: 'openrouter',
                    label: 'Bogus',
                    enabled: true,
                    models: [{ id: 'bogus:x', modelId: 'x', label: 'X' }],
                },
            ] as ProviderInstance[],
        });
        expect(merged.providers.map((p) => p.id)).toEqual(defaultProviders().map((p) => p.id));
        expect(merged.providers.some((p) => p.id === 'bogus')).toBe(false);
    });

    it('overlays a stored apiKey onto the matching provider and round-trips the map', () => {
        const merged = mergeWithDefaults({ apiKeys: { [OPENROUTER_PROVIDER_ID]: 'sk-stored' } });
        const or = merged.providers.find((p) => p.id === OPENROUTER_PROVIDER_ID)!;
        expect(or.apiKey).toBe('sk-stored');
        expect(merged.apiKeys[OPENROUTER_PROVIDER_ID]).toBe('sk-stored');
    });

    it('ignores a key for a provider absent from the catalog (not shown)', () => {
        const merged = mergeWithDefaults({ apiKeys: { 'no-such-provider': 'sk-x' } });
        expect(merged.providers.some((p) => p.id === 'no-such-provider')).toBe(false);
    });

    it('recovers a legacy single-OpenRouter global apiKey as the openrouter key', () => {
        const merged = mergeWithDefaults({ apiKey: 'sk-legacy' } as unknown as Partial<Settings>);
        const or = merged.providers.find((p) => p.id === OPENROUTER_PROVIDER_ID)!;
        expect(or.apiKey).toBe('sk-legacy');
        expect(merged.apiKeys[OPENROUTER_PROVIDER_ID]).toBe('sk-legacy');
        // Models still come from the JSON catalog, not the legacy blob.
        expect(or.models.length).toBeGreaterThan(0);
    });

    it('recovers keys from an older persisted providers array', () => {
        const blob = {
            providers: defaultProviders().map((p) =>
                p.id === OPENROUTER_PROVIDER_ID ? { ...p, apiKey: 'sk-from-blob' } : p,
            ),
        };
        const merged = mergeWithDefaults(blob);
        expect(merged.providers.find((p) => p.id === OPENROUTER_PROVIDER_ID)!.apiKey).toBe(
            'sk-from-blob',
        );
    });

    it('snaps a persisted defaultModelId that is not in the JSON catalog', () => {
        const merged = mergeWithDefaults({ defaultModelId: 'openrouter:not-in-config' });
        expect(merged.defaultModelId).toBe(validId);
    });

    it('strips legacy / removed top-level keys so they never persist', () => {
        const legacy = {
            provider: 'openrouter',
            apiKey: 'sk-legacy',
            chromeAiEnabled: true,
            models: [{ openRouterModelId: 'foo/bar', label: 'Foo' }],
            useOneModelForAll: false,
        } as unknown as Partial<Settings>;
        const merged = mergeWithDefaults(legacy) as unknown as Record<string, unknown>;
        expect(merged.provider).toBeUndefined();
        expect(merged.apiKey).toBeUndefined();
        expect(merged.chromeAiEnabled).toBeUndefined();
        expect(merged.models).toBeUndefined();
        expect(merged.useOneModelForAll).toBeUndefined();
    });

    it('is idempotent — re-merging a merged result reproduces the same providers', () => {
        const once = mergeWithDefaults({ apiKeys: { [OPENROUTER_PROVIDER_ID]: 'sk-x' } });
        const twice = mergeWithDefaults(once);
        expect(twice.providers).toEqual(once.providers);
        expect(twice.apiKeys).toEqual(once.apiKeys);
    });
});

describe('buildProviders', () => {
    it('re-applies session pricing by model fqid from a prior providers array', () => {
        const priced = defaultProviders().map((p) =>
            p.kind === 'google-ai-studio'
                ? {
                      ...p,
                      models: p.models.map((m) => ({
                          ...m,
                          pricing: { prompt: 1e-7, completion: 4e-7 },
                      })),
                  }
                : p,
        );
        const built = buildProviders({}, priced);
        const google = built.find((p) => p.kind === 'google-ai-studio')!;
        expect(google.models[0]!.pricing).toEqual({ prompt: 1e-7, completion: 4e-7 });
    });

    it('never attaches a key to the keyless chrome-ai provider', () => {
        const built = buildProviders({ 'chrome-ai': 'sk-should-be-ignored' });
        const chrome = built.find((p) => p.kind === 'chrome-ai')!;
        expect(chrome.apiKey).toBeUndefined();
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
