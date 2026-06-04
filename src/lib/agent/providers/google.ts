import type { ModelPricing } from '@/lib/runtime/state/settings-types';
import type { CatalogModel, ProviderAdapter } from './types';
import { timedProbe } from './types';
import geminiPrices from './gemini-prices.json';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

type ModelsResponse = {
    models?: Array<{
        name?: unknown;
        displayName?: unknown;
        supportedGenerationMethods?: unknown;
    }>;
};

/** `models/gemini-2.5-flash` → `gemini-2.5-flash`. */
function bareModelId(name: string): string {
    return name.startsWith('models/') ? name.slice('models/'.length) : name;
}

/**
 * Google AI Studio adapter (generativelanguage.googleapis.com).
 *
 * Auth is via `?key=` query param. There is NO pricing API, so
 * `fetchPrices` applies a committed static map (maintained offline by
 * `scripts/extract-gemini-prices.ts`). The `models.list` endpoint doubles
 * as the key/uptime probe.
 */
export const googleAdapter: ProviderAdapter = {
    kind: 'google-ai-studio',
    label: 'Google AI Studio',
    requiresApiKey: true,
    baseURL: 'none',
    canFetchPrices: true,
    // Prices come from a committed static map (no network), so fill them in
    // automatically on every save instead of behind a button.
    autoFetchPrices: true,

    testConnection(cfg, signal) {
        return timedProbe(async () => {
            const key = (cfg.apiKey ?? '').trim();
            if (!key) return { ok: false, message: 'Paste an API key first.' };
            const res = await fetch(`${BASE}/models?key=${encodeURIComponent(key)}`, { signal });
            if (!res.ok) {
                const body = await res.text();
                return {
                    ok: false,
                    message: `${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 200)}` : ''}`,
                };
            }
            const json = (await res.json()) as ModelsResponse;
            const count = Array.isArray(json.models) ? json.models.length : 0;
            return { ok: true, label: `${count} models` };
        });
    },

    async listModels(cfg, signal): Promise<CatalogModel[]> {
        const key = (cfg.apiKey ?? '').trim();
        if (!key) throw new Error('Paste an API key first.');
        const res = await fetch(`${BASE}/models?key=${encodeURIComponent(key)}`, { signal });
        if (!res.ok) {
            throw new Error(`Google /models returned ${res.status} ${res.statusText}`);
        }
        const json = (await res.json()) as ModelsResponse;
        const models = Array.isArray(json.models) ? json.models : [];
        return models
            .filter(
                (m) =>
                    typeof m.name === 'string' &&
                    Array.isArray(m.supportedGenerationMethods) &&
                    (m.supportedGenerationMethods as unknown[]).includes('generateContent'),
            )
            .map((m) => {
                const id = bareModelId(m.name as string);
                return {
                    modelId: id,
                    label: typeof m.displayName === 'string' ? m.displayName : id,
                };
            });
    },

    /**
     * No network — apply the committed static price map. A model with no
     * entry is simply omitted (caller drops stale pricing).
     */
    async fetchPrices(_cfg, modelIds): Promise<Record<string, ModelPricing>> {
        const table = geminiPrices as Record<string, ModelPricing>;
        const out: Record<string, ModelPricing> = {};
        for (const id of modelIds) {
            const p = table[id];
            if (p) out[id] = p;
        }
        return out;
    },
};
