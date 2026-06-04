import { fetchOpenRouterPricingForSlugs } from '@/lib/runtime/openrouter-pricing';
import type { CatalogModel, ProviderAdapter } from './types';
import { timedProbe } from './types';

const BASE = 'https://openrouter.ai/api/v1';

type KeyResponse = { data?: { label?: string } };
type ModelsResponse = { data?: Array<{ id?: unknown; name?: unknown }> };

/**
 * OpenRouter adapter. Key/uptime check hits `/api/v1/key` — auth-required
 * but model-free, so it verifies a key without spending tokens. Pricing
 * reuses the existing per-slug fetcher.
 */
export const openRouterAdapter: ProviderAdapter = {
    kind: 'openrouter',
    label: 'OpenRouter',
    requiresApiKey: true,
    baseURL: 'none',
    canFetchPrices: true,

    testConnection(cfg, signal) {
        return timedProbe(async () => {
            const key = (cfg.apiKey ?? '').trim();
            if (!key) return { ok: false, message: 'Paste an API key first.' };
            const res = await fetch(`${BASE}/key`, {
                headers: { Authorization: `Bearer ${key}` },
                signal,
            });
            if (!res.ok) {
                const body = await res.text();
                return {
                    ok: false,
                    message: `${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 200)}` : ''}`,
                };
            }
            const json = (await res.json()) as KeyResponse;
            return { ok: true, label: json.data?.label };
        });
    },

    async listModels(_cfg, signal): Promise<CatalogModel[]> {
        const res = await fetch(`${BASE}/models`, { signal });
        if (!res.ok) {
            throw new Error(`OpenRouter /models returned ${res.status} ${res.statusText}`);
        }
        const json = (await res.json()) as ModelsResponse;
        const data = Array.isArray(json.data) ? json.data : [];
        return data
            .filter((m) => typeof m.id === 'string')
            .map((m) => ({
                modelId: m.id as string,
                label: typeof m.name === 'string' ? m.name : (m.id as string),
            }));
    },

    fetchPrices(_cfg, modelIds, signal) {
        return fetchOpenRouterPricingForSlugs(modelIds, signal);
    },
};
