/**
 * Types for the `@app-config` import — the app's default configuration: the LLM
 * provider/model catalog AND the rest of the default `Settings` (feature flags,
 * default model / per-agent models, default data-source persistence). Read by
 * `defaultSettings()` / `defaultProviders()` in
 * [runtime/state/settings-types.ts](runtime/state/settings-types.ts).
 *
 * At BUILD/RUNTIME the `@app-config` specifier is a Vite/vitest **alias** that
 * resolves to a JSON file picked at build time (`APP_CONFIG` env, else the dev
 * file under `vite serve` and the prod file when bundling — see
 * [vite.config.ts](../vite.config.ts) / [vitest.config.ts](../vitest.config.ts)).
 * Vite/vitest don't read this file. tsc resolves `@app-config` HERE via the
 * `paths` entry in tsconfig.app.json (the repo's `@/*` convention), which gives
 * proper union types for `kind` that a raw JSON import (inferred `string`)
 * would not. Keep this shape in sync with the committed `app-config.*.json`.
 *
 * `apiKey` / `baseURL` are intentionally absent from the committed JSON files —
 * dev keys overlay from `.env.local`; the secret scanner stays clean.
 */

export interface AppConfigModelEntry {
    modelId: string;
    label: string;
    pricing?: {
        prompt: number;
        completion: number;
        cacheRead?: number;
        reasoning?: number;
    };
}

export interface AppConfigProvider {
    id: string;
    kind: 'openrouter' | 'google-ai-studio' | 'openai-compatible' | 'chrome-ai';
    label: string;
    apiKey?: string;
    baseURL?: string;
    enabled?: boolean;
    models: AppConfigModelEntry[];
}

export interface AppConfig {
    providers: AppConfigProvider[];
    // The rest mirror the whole `Settings` shape (minus the user-persisted
    // `apiKeys`, and the derived `providers`): the config IS the default Settings.
    // `defaultSettings()` reads each of these (see settings-types.ts), so a
    // deployer's `/config/app-config.json` fully defines the initial UI state.
    defaultModelId?: string;
    agentModels?: { orchestrator?: string; planner?: string; coder?: string };
    piiEnabled?: boolean;
    powerUser?: boolean;
    showSqlConsole?: boolean;
    showPiiTester?: boolean;
    showEmbeddingsTester?: boolean;
    showQjsTester?: boolean;
    defaultDataSourcePersistence?: 'memory' | 'temp' | 'persistent';
}

declare const config: AppConfig;
export default config;
