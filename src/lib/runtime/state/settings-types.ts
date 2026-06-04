/**
 * Settings shape and defaults, factored out so both the worker-side
 * settings module and the tab-side mirror can import without pulling
 * in Solid or localStorage code paths.
 *
 * No Solid / agent / SDK imports here — this module is a pure leaf so
 * both sides of the cross-tab boundary can share its types and helpers.
 */

/**
 * The kinds of LLM backend a {@link ProviderInstance} can be. Each kind
 * has a capability adapter (test connection, list models, fetch prices)
 * and a registry factory (see `src/lib/agent/registry.ts`).
 */
export type ProviderKind = 'openrouter' | 'google-ai-studio' | 'openai-compatible' | 'chrome-ai';

/**
 * Per-token pricing in USD. OpenRouter reports these as decimal strings
 * (converted to numbers at fetch time); Google's are filled from a
 * committed static map. Multiply by 1e6 to get $/M tokens.
 */
export interface ModelPricing {
    /** USD per input/prompt token. */
    prompt: number;
    /** USD per output/completion token. */
    completion: number;
    /** USD per cached-input read token (when the provider supports caching). */
    cacheRead?: number;
    /** USD per reasoning token, when billed separately from completion. */
    reasoning?: number;
}

export interface ModelEntry {
    /**
     * Fully-qualified id: `${providerId}:${modelId}`, unique across all
     * providers. This is the value stored in `defaultModelId` /
     * `agentModels` and resolved by the AI SDK provider registry (which
     * splits on the FIRST colon, so a `modelId` may itself contain `:`,
     * e.g. `openrouter:openai/gpt-oss-120b:free`).
     */
    id: string;
    /** Human-readable name shown in the model selector. */
    label: string;
    /**
     * Bare per-provider model id/slug, e.g. `openai/gpt-oss-120b:free`
     * (OpenRouter) or `gemini-2.5-flash` (Google). Passed verbatim to the
     * provider's `.languageModel(modelId)`.
     */
    modelId: string;
    /**
     * USD-per-token pricing. Populated by the Settings page's
     * "Download prices" — never auto-fetched in the background.
     */
    pricing?: ModelPricing;
}

/**
 * A configured provider instance. `id` is a unique slug that doubles as
 * the registry prefix and the `${providerId}:` segment of every model's
 * fully-qualified id. Several instances may share a {@link ProviderKind}
 * (e.g. two OpenRouter keys, or several OpenAI-compatible endpoints).
 */
export interface ProviderInstance {
    id: string;
    kind: ProviderKind;
    label: string;
    /** API key. Bearer for OpenRouter/OpenAI-compatible, query-param for Google. Absent for `chrome-ai`. */
    apiKey?: string;
    /** Base URL. Required for `openai-compatible`; an optional override elsewhere. */
    baseURL?: string;
    /** Whether this provider's models are offered in selectors and built into the registry. */
    enabled: boolean;
    models: ModelEntry[];
}

export type DataSourcePersistence = 'memory' | 'temp' | 'persistent';

/**
 * The agents a user can assign a model to. Kept as a local literal (rather
 * than importing `AgentId` from `src/lib/types.ts`) to preserve this file's
 * "no Solid/agent imports" boundary — both `mergeWithDefaults` and the
 * Settings UI read from it.
 */
export const AGENT_MODEL_KEYS = ['orchestrator', 'planner', 'coder'] as const;

export type AgentModelKey = (typeof AGENT_MODEL_KEYS)[number];

export interface Settings {
    /** Configured LLM providers. The flattened union of their enabled models is what selectors offer. */
    providers: ProviderInstance[];
    /** Fully-qualified id (`providerId:modelId`) of the primary model. */
    defaultModelId: string;
    /**
     * When true (the default), every agent uses {@link defaultModelId}. When
     * false, each agent uses its entry in {@link agentModels}, falling back to
     * {@link defaultModelId} where unset.
     */
    useOneModelForAll: boolean;
    /** Per-agent model overrides (fully-qualified ids), consulted only when `useOneModelForAll` is false. */
    agentModels: Partial<Record<AgentModelKey, string>>;
    piiEnabled: boolean;
    powerUser: boolean;
    showSqlConsole: boolean;
    showPiiTester: boolean;
    showQjsTester: boolean;
    /** Default persistence pre-selected in the import dialog. */
    defaultDataSourcePersistence: DataSourcePersistence;
}

/** Default provider-instance ids. Stable so persisted model ids stay valid. */
export const OPENROUTER_PROVIDER_ID = 'openrouter';
export const GOOGLE_PROVIDER_ID = 'google';
export const CHROME_AI_PROVIDER_ID = 'chrome-ai';

/**
 * Stable id of the on-device Chrome AI model. Equals
 * `${CHROME_AI_PROVIDER_ID}:gemini-nano`; the chrome-ai provider entry in
 * {@link defaultProviders} carries a matching model row.
 */
export const CHROME_AI_MODEL_ID = 'chrome-ai:gemini-nano';

// Dev-only API keys are read from gitignored env (copy `.env.example` to
// `.env.local` and fill them in) — never hardcoded, so the secret scanner
// (scripts/scan-secrets.ts) stays clean. Empty in prod and when unset.
const DEV_DEFAULT_API_KEY = import.meta.env.DEV
    ? (import.meta.env.VITE_DEV_OPENROUTER_KEY ?? '')
    : '';

/**
 * Dev-only Google AI Studio key, seeded into the default Google provider
 * and reused by tests. Sourced from `VITE_DEV_GOOGLE_AI_STUDIO_KEY` in
 * `.env.local` so the literal never lives in tracked source.
 */
export const DEV_DEFAULT_GOOGLE_AI_STUDIO_KEY = import.meta.env.DEV
    ? (import.meta.env.VITE_DEV_GOOGLE_AI_STUDIO_KEY ?? '')
    : '';

/** Build a fully-qualified model id from a provider id + bare model id. */
export function modelKey(providerId: string, modelId: string): string {
    return `${providerId}:${modelId}`;
}

/**
 * Split a fully-qualified `providerId:modelId` on the FIRST colon — the
 * same convention the AI SDK provider registry uses, so a `modelId` that
 * itself contains a colon (`...:free`) round-trips correctly.
 */
export function splitModelId(fqid: string): { providerId: string; modelId: string } {
    const i = fqid.indexOf(':');
    if (i === -1) return { providerId: '', modelId: fqid };
    return { providerId: fqid.slice(0, i), modelId: fqid.slice(i + 1) };
}

/** Convenience for a {@link ModelEntry} whose `id` is derived from its provider + slug. */
function mkModel(
    providerId: string,
    modelId: string,
    label: string,
    pricing?: ModelPricing,
): ModelEntry {
    const entry: ModelEntry = { id: modelKey(providerId, modelId), modelId, label };
    if (pricing) entry.pricing = pricing;
    return entry;
}

// Factories rather than module-level consts so every consumer gets a
// fresh, independently mutable copy — see the long-standing note about
// Solid's `reconcile()` mutating shared entries in place.
export function defaultProviders(): ProviderInstance[] {
    return [
        {
            id: OPENROUTER_PROVIDER_ID,
            kind: 'openrouter',
            label: 'OpenRouter',
            apiKey: DEV_DEFAULT_API_KEY,
            enabled: true,
            models: [
                mkModel(OPENROUTER_PROVIDER_ID, 'openai/gpt-oss-120b:free', 'GPT-OSS 120B (free)', {
                    prompt: 0,
                    completion: 0,
                }),
                mkModel(
                    OPENROUTER_PROVIDER_ID,
                    'nvidia/nemotron-3-super-120b-a12b:free',
                    'Nemotron 3 Super 120B A12B (free)',
                    { prompt: 0, completion: 0 },
                ),
                mkModel(
                    OPENROUTER_PROVIDER_ID,
                    'google/gemini-2.5-flash-lite',
                    'Gemini 2.5 Flash Lite ($)',
                    { prompt: 0, completion: 0 },
                ),
            ],
        },
        {
            id: GOOGLE_PROVIDER_ID,
            kind: 'google-ai-studio',
            label: 'Google AI Studio',
            // Dev key seeds out-of-the-box Google access; empty in prod.
            apiKey: DEV_DEFAULT_GOOGLE_AI_STUDIO_KEY,
            enabled: true,
            // No pricing baked in — Google has no pricing API; the user
            // clicks "Download prices" to fill from the committed map.
            models: [
                mkModel(GOOGLE_PROVIDER_ID, 'gemini-2.5-flash', 'Gemini 2.5 Flash'),
                mkModel(GOOGLE_PROVIDER_ID, 'gemini-2.5-flash-lite', 'Gemini 2.5 Flash Lite'),
            ],
        },
        {
            id: CHROME_AI_PROVIDER_ID,
            kind: 'chrome-ai',
            label: 'Chrome AI (on-device)',
            enabled: true,
            models: [
                mkModel(CHROME_AI_PROVIDER_ID, 'gemini-nano', 'Chrome AI (Gemini Nano)', {
                    prompt: 0,
                    completion: 0,
                }),
            ],
        },
    ];
}

export function defaultSettings(): Settings {
    const providers = defaultProviders();
    return {
        providers,
        defaultModelId: providers[0]!.models[0]!.id,
        useOneModelForAll: true,
        agentModels: {},
        piiEnabled: true,
        powerUser: import.meta.env.DEV,
        showSqlConsole: false,
        showPiiTester: false,
        showQjsTester: false,
        defaultDataSourcePersistence: 'persistent',
    };
}

/** Flatten enabled providers' models into a single list (selector source of truth). */
export function allModels(providers: ProviderInstance[]): ModelEntry[] {
    return providers.filter((p) => p.enabled).flatMap((p) => p.models);
}

/** True when the chrome-ai provider's model is offered (enabled). */
export function isChromeAiOffered(providers: ProviderInstance[]): boolean {
    return providers.some((p) => p.kind === 'chrome-ai' && p.enabled && p.models.length > 0);
}

/**
 * True when at least one enabled provider is usable enough to run a model:
 * a non-empty key (OpenRouter / Google), a base URL (OpenAI-compatible), or
 * the keyless on-device chrome-ai. Gates the landing "ready to chat" state.
 */
export function hasUsableProvider(providers: ProviderInstance[]): boolean {
    return providers.some((p) => {
        if (!p.enabled || p.models.length === 0) return false;
        if (p.kind === 'chrome-ai') return true;
        if (p.kind === 'openai-compatible') return !!p.baseURL?.trim();
        return !!p.apiKey?.trim();
    });
}

/**
 * Look up a model entry by its fully-qualified id across ALL providers
 * (enabled or not — cost/label lookups must still resolve a model whose
 * provider was just disabled). Falls back to the first enabled model,
 * then the compiled-in default.
 */
export function findModelEntryIn(providers: ProviderInstance[], id: string): ModelEntry {
    for (const p of providers) {
        const m = p.models.find((x) => x.id === id);
        if (m) return m;
    }
    return allModels(providers)[0] ?? defaultProviders()[0]!.models[0]!;
}

/**
 * Pre-multi-provider persisted shape. Only used by the migration branch
 * of {@link mergeWithDefaults}; new writes never produce these fields.
 */
interface LegacySettings {
    provider?: string;
    apiKey?: string;
    chromeAiEnabled?: boolean;
    models?: Array<{
        id?: string;
        label?: string;
        openRouterModelId?: string;
        provider?: string;
        pricing?: ModelPricing;
    }>;
}

function isModelEntry(x: unknown): x is ModelEntry {
    if (!x || typeof x !== 'object') return false;
    const m = x as Record<string, unknown>;
    return typeof m.id === 'string' && typeof m.label === 'string' && typeof m.modelId === 'string';
}

function isProviderInstance(x: unknown): x is ProviderInstance {
    if (!x || typeof x !== 'object') return false;
    const p = x as Record<string, unknown>;
    return (
        typeof p.id === 'string' &&
        typeof p.kind === 'string' &&
        Array.isArray(p.models) &&
        (p.models as unknown[]).every(isModelEntry)
    );
}

/** Re-derive each model's `id` from its provider, dropping malformed rows. */
function normalizeProvider(pr: ProviderInstance): ProviderInstance {
    const next: ProviderInstance = {
        id: pr.id,
        kind: pr.kind,
        label: typeof pr.label === 'string' && pr.label.length > 0 ? pr.label : pr.id,
        enabled: pr.enabled !== false,
        models: (pr.models ?? []).map((m) => {
            const entry: ModelEntry = {
                id: modelKey(pr.id, m.modelId),
                modelId: m.modelId,
                label: m.label,
            };
            if (m.pricing) entry.pricing = m.pricing;
            return entry;
        }),
    };
    if (typeof pr.apiKey === 'string') next.apiKey = pr.apiKey;
    if (typeof pr.baseURL === 'string') next.baseURL = pr.baseURL;
    return next;
}

/**
 * Resolve the providers array, migrating the legacy single-OpenRouter
 * shape on first load. Idempotent: once a valid `providers` array exists,
 * it is reused (normalized) on every subsequent merge.
 */
function resolveProviders(p: Partial<Settings> & LegacySettings): ProviderInstance[] {
    if (Array.isArray(p.providers) && p.providers.every(isProviderInstance)) {
        return p.providers.map(normalizeProvider);
    }
    // Legacy migration: fold the old global apiKey + flat `models` (keyed
    // on openRouterModelId) into the default OpenRouter provider. Keeping
    // provider id `openrouter` means existing `defaultModelId` /
    // `agentModels` values (`openrouter:<slug>`) stay valid.
    const providers = defaultProviders();
    if (Array.isArray(p.models) || typeof p.apiKey === 'string') {
        const migrated: ModelEntry[] = Array.isArray(p.models)
            ? p.models
                  .filter(
                      (m) =>
                          m &&
                          typeof m.openRouterModelId === 'string' &&
                          typeof m.label === 'string',
                  )
                  .map((m) =>
                      mkModel(OPENROUTER_PROVIDER_ID, m.openRouterModelId!, m.label!, m.pricing),
                  )
            : [];
        return providers.map((pr) =>
            pr.id === OPENROUTER_PROVIDER_ID
                ? {
                      ...pr,
                      apiKey: typeof p.apiKey === 'string' ? p.apiKey : pr.apiKey,
                      models: migrated.length > 0 ? migrated : pr.models,
                  }
                : pr,
        );
    }
    return providers;
}

/** Drop legacy top-level keys so stale fields never persist back to IDB. */
function stripLegacy(p: Partial<Settings> & LegacySettings): Partial<Settings> {
    const { provider, apiKey, chromeAiEnabled, models, ...rest } = p as Record<string, unknown>;
    void provider;
    void apiKey;
    void chromeAiEnabled;
    void models;
    return rest as Partial<Settings>;
}

export function mergeWithDefaults(p: Partial<Settings>): Settings {
    const base = defaultSettings();
    const legacy = p as Partial<Settings> & LegacySettings;
    const providers = resolveProviders(legacy);

    // Valid selections = ids of every ENABLED provider's models. A model
    // under a disabled provider can't be the active default/override.
    const validIds = new Set<string>();
    for (const pr of providers) {
        if (!pr.enabled) continue;
        for (const m of pr.models) validIds.add(m.id);
    }
    const firstEnabled = allModels(providers)[0]?.id ?? base.defaultModelId;
    const defaultModelId =
        typeof p.defaultModelId === 'string' && validIds.has(p.defaultModelId)
            ? p.defaultModelId
            : firstEnabled;

    // Sanitize per-agent overrides against the same valid-id set: a dropped
    // override falls back to the default model at resolution time.
    const agentModels: Settings['agentModels'] = {};
    if (p.agentModels && typeof p.agentModels === 'object') {
        for (const a of AGENT_MODEL_KEYS) {
            const v = (p.agentModels as Record<string, unknown>)[a];
            if (typeof v === 'string' && validIds.has(v)) agentModels[a] = v;
        }
    }
    const useOneModelForAll =
        typeof p.useOneModelForAll === 'boolean' ? p.useOneModelForAll : base.useOneModelForAll;

    return {
        ...base,
        ...stripLegacy(legacy),
        providers,
        defaultModelId,
        useOneModelForAll,
        agentModels,
    };
}
