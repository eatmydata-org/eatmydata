/**
 * Types for the `@app-config` import — the LLM provider/model catalog seeded
 * at first load by `defaultProviders()` in
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
    defaultModelId?: string;
    providers: AppConfigProvider[];
}

declare const config: AppConfig;
export default config;
