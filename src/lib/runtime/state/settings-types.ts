/**
 * Settings shape and defaults, factored out so both the worker-side
 * settings module and the tab-side mirror can import without pulling
 * in Solid or localStorage code paths.
 *
 * No Solid / agent / SDK imports here — this module is a pure leaf so
 * both sides of the cross-tab boundary can share its types and helpers.
 * (The `@app-config` import is data only — a JSON catalog, no runtime deps.)
 */

import appConfig from '@app-config';

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
    /**
     * Configured LLM providers — the flattened union of their enabled models is
     * what selectors offer. DERIVED on every load from the `@app-config` catalog
     * with persisted {@link apiKeys} overlaid; the catalog itself is build-time
     * config and is **never** persisted to IDB (see `persist` in `settings.ts`).
     */
    providers: ProviderInstance[];
    /**
     * Persisted API keys, keyed by provider id — the ONLY provider-related state
     * stored in IDB. The catalog (which providers/models exist, labels, enabled,
     * pricing) always comes from `@app-config`; a stored key is overlaid onto the
     * matching provider, and a key for a provider absent from (or disabled in)
     * the catalog is ignored — that provider is not shown at all.
     */
    apiKeys: Record<string, string>;
    /** Fully-qualified id (`providerId:modelId`) of the primary model. */
    defaultModelId: string;
    /**
     * Per-agent model overrides (fully-qualified ids). An agent with no entry
     * (the default) inherits {@link defaultModelId} at resolution time.
     */
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

/**
 * The dev-only API key to overlay onto a provider whose config JSON left the
 * key blank, matched by kind (so a renamed provider id still picks the right
 * key). Returns `undefined` for keyless kinds (chrome-ai) so no `apiKey`
 * field is added; returns `''` for key-kinds with no dev key (prod) so the
 * field renders empty and editable. See {@link defaultProviders}.
 */
function seedApiKey(kind: ProviderKind, jsonKey: string | undefined): string | undefined {
    if (kind === 'chrome-ai') return undefined; // on-device — no key
    const fromJson = (jsonKey ?? '').trim();
    if (fromJson) return fromJson;
    if (kind === 'openrouter') return DEV_DEFAULT_API_KEY;
    if (kind === 'google-ai-studio') return DEV_DEFAULT_GOOGLE_AI_STUDIO_KEY;
    return ''; // openai-compatible: present-but-empty so the field renders
}

// Factory (not a module-level const) so every consumer gets a fresh,
// independently mutable copy — see the long-standing note about Solid's
// `reconcile()` mutating shared entries in place. The catalog (provider ids,
// kinds, labels, models, baked-in pricing) comes from the `@app-config` JSON
// chosen at build time; dev API keys overlay from `.env.local` per kind.
export function defaultProviders(): ProviderInstance[] {
    return appConfig.providers.map((p) => {
        const provider: ProviderInstance = {
            id: p.id,
            kind: p.kind,
            label: p.label,
            enabled: p.enabled !== false,
            models: p.models.map((m) => mkModel(p.id, m.modelId, m.label, m.pricing)),
        };
        const apiKey = seedApiKey(p.kind, p.apiKey);
        if (apiKey !== undefined) provider.apiKey = apiKey;
        if (typeof p.baseURL === 'string') provider.baseURL = p.baseURL;
        return provider;
    });
}

export function defaultSettings(): Settings {
    const providers = defaultProviders();
    return {
        providers,
        apiKeys: {},
        // The orchestrator is the primary agent; with no overrides it (and thus
        // `defaultModelId`) resolves to the config default.
        defaultModelId: resolveAgentModel(providers, {}, 'orchestrator'),
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

/**
 * The model an agent runs with. An agent's saved pick wins, but ONLY while that
 * model is still in the enabled `@app-config` catalog; otherwise (unset, or the
 * model has left the catalog) it falls back to the config default
 * (`appConfig.defaultModelId`, validated, else the first enabled model). The
 * raw pick stays in {@link Settings.agentModels} either way, so it re-applies if
 * the model returns. The orchestrator's resolution doubles as the primary
 * (`defaultModelId`) — chat submit, Test, pricing.
 */
export function resolveAgentModel(
    providers: ProviderInstance[],
    agentModels: Settings['agentModels'],
    agentId: AgentModelKey,
): string {
    const enabled = allModels(providers);
    const has = (id: string | undefined): id is string => !!id && enabled.some((m) => m.id === id);
    const saved = agentModels[agentId];
    if (has(saved)) return saved;
    const cfg = appConfig.defaultModelId;
    return has(cfg) ? cfg : (enabled[0]?.id ?? '');
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
 * Pre-multi-provider persisted shape, plus the now-derived `providers` field
 * older blobs / UI patches may still carry. Used only to recover API keys in
 * {@link mergeWithDefaults}; the catalog itself always comes from `@app-config`.
 */
interface LegacySettings {
    provider?: string;
    apiKey?: string;
    chromeAiEnabled?: boolean;
    models?: unknown;
}

/**
 * Recover the persisted API keys (the only provider state we keep) from a
 * partial settings blob. The explicit `apiKeys` map is canonical; a `providers`
 * array is consulted ONLY when there is no `apiKeys` map (a pre-`apiKeys`
 * persisted blob), so we never re-harvest the *seeded* dev keys that ride on
 * the derived `providers` of every live `Settings` back into the stored map.
 * The legacy single-OpenRouter global `apiKey` always maps to `openrouter`.
 * chrome-ai entries are dropped (on-device, keyless); empty harvested keys are
 * skipped (an empty seed is "no key", not a stored override).
 */
function resolveApiKeys(p: Partial<Settings> & LegacySettings): Record<string, string> {
    const out: Record<string, string> = {};
    if (p.apiKeys && typeof p.apiKeys === 'object') {
        for (const [id, key] of Object.entries(p.apiKeys)) {
            if (typeof key === 'string') out[id] = key;
        }
    } else if (Array.isArray(p.providers)) {
        for (const pr of p.providers as ProviderInstance[]) {
            if (
                pr &&
                typeof pr.id === 'string' &&
                pr.kind !== 'chrome-ai' &&
                typeof pr.apiKey === 'string' &&
                pr.apiKey.trim()
            ) {
                out[pr.id] = pr.apiKey;
            }
        }
    }
    if (typeof p.apiKey === 'string' && p.apiKey.trim()) out[OPENROUTER_PROVIDER_ID] = p.apiKey;
    return out;
}

/**
 * Build the runtime providers: the `@app-config` catalog with persisted keys
 * overlaid (a stored key — including an explicit empty string — wins over the
 * seeded dev key; a provider with no stored key keeps its seed, empty in prod).
 * `prevPricing`, when given, re-applies session-fetched pricing (from "Download
 * prices") by model fqid — pricing is part of the JSON-sourced catalog and is
 * NOT persisted, so it only survives within a session.
 */
export function buildProviders(
    apiKeys: Record<string, string>,
    prevPricing?: ProviderInstance[],
): ProviderInstance[] {
    const priceMap = new Map<string, ModelPricing>();
    if (prevPricing) {
        for (const pr of prevPricing) {
            for (const m of pr.models ?? []) if (m.pricing) priceMap.set(m.id, m.pricing);
        }
    }
    return defaultProviders().map((p) => {
        const stored = apiKeys[p.id];
        const withKey =
            p.kind !== 'chrome-ai' && stored !== undefined ? { ...p, apiKey: stored } : p;
        if (priceMap.size === 0) return withKey;
        return {
            ...withKey,
            models: withKey.models.map((m) => {
                const pr = priceMap.get(m.id);
                return pr ? { ...m, pricing: pr } : m;
            }),
        };
    });
}

/** Drop legacy / derived / removed top-level keys so they never persist as stale state. */
function stripLegacy(p: Partial<Settings> & LegacySettings): Partial<Settings> {
    // `providers` is derived (rebuilt from @app-config each load) — never let an
    // incoming catalog ride through the spread. `useOneModelForAll` was removed.
    // `provider`/`apiKey`/`chromeAiEnabled`/`models` are the pre-multi-provider
    // legacy shape. (`apiKeys` is a real field — kept and set explicitly below.)
    const { provider, apiKey, chromeAiEnabled, models, useOneModelForAll, providers, ...rest } =
        p as Record<string, unknown>;
    void provider;
    void apiKey;
    void chromeAiEnabled;
    void models;
    void useOneModelForAll;
    void providers;
    return rest as Partial<Settings>;
}

export function mergeWithDefaults(p: Partial<Settings>): Settings {
    const base = defaultSettings();
    const legacy = p as Partial<Settings> & LegacySettings;

    // Keys are the only persisted provider state; the catalog is always rebuilt
    // from @app-config. Session pricing (if any) rides on the incoming providers.
    const apiKeys = resolveApiKeys(legacy);
    const providers = buildProviders(apiKeys, Array.isArray(p.providers) ? p.providers : undefined);

    // Per-agent picks are kept RAW (any string) — validity against the catalog
    // is checked at resolution time (`resolveAgentModel`), not here. A pick whose
    // model has (temporarily) left the catalog is therefore retained in IDB and
    // re-applies if the model returns, rather than being silently dropped.
    const agentModels: Settings['agentModels'] = {};
    if (p.agentModels && typeof p.agentModels === 'object') {
        for (const a of AGENT_MODEL_KEYS) {
            const v = (p.agentModels as Record<string, unknown>)[a];
            if (typeof v === 'string') agentModels[a] = v;
        }
    }
    // The orchestrator IS the primary agent — `defaultModelId` (chat submit /
    // Test / pricing, and the orchestrator's own model) tracks its resolved
    // pick; unset or no-longer-in-catalog → the config default. There is no
    // separate user-set primary, so any persisted `defaultModelId` is ignored.
    const defaultModelId = resolveAgentModel(providers, agentModels, 'orchestrator');

    return {
        ...base,
        ...stripLegacy(legacy),
        apiKeys,
        providers,
        defaultModelId,
        agentModels,
    };
}
