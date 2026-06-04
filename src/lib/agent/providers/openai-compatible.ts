import type { CatalogModel, ProviderAdapter } from './types';
import { timedProbe } from './types';

type ModelsResponse = { data?: Array<{ id?: unknown }> };

/**
 * Generic OpenAI-compatible adapter (any endpoint exposing `/v1/chat/
 * completions` + `/v1/models`). Base URL is mandatory; the key is sent as
 * a Bearer token when present. No pricing source — manual/JSON only.
 */
export const openAICompatibleAdapter: ProviderAdapter = {
    kind: 'openai-compatible',
    label: 'OpenAI-compatible',
    requiresApiKey: true,
    baseURL: 'required',
    canFetchPrices: false,

    testConnection(cfg, signal) {
        return timedProbe(async () => {
            const base = (cfg.baseURL ?? '').trim().replace(/\/$/, '');
            if (!base) return { ok: false, message: 'Set a base URL first.' };
            const key = (cfg.apiKey ?? '').trim();
            const res = await fetch(`${base}/models`, {
                headers: key ? { Authorization: `Bearer ${key}` } : undefined,
                signal,
            });
            if (!res.ok) {
                const body = await res.text();
                return {
                    ok: false,
                    message: `${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 200)}` : ''}`,
                };
            }
            const json = (await res.json()) as ModelsResponse;
            const count = Array.isArray(json.data) ? json.data.length : 0;
            return { ok: true, label: `${count} models` };
        });
    },

    async listModels(cfg, signal): Promise<CatalogModel[]> {
        const base = (cfg.baseURL ?? '').trim().replace(/\/$/, '');
        if (!base) throw new Error('Set a base URL first.');
        const key = (cfg.apiKey ?? '').trim();
        const res = await fetch(`${base}/models`, {
            headers: key ? { Authorization: `Bearer ${key}` } : undefined,
            signal,
        });
        if (!res.ok) {
            throw new Error(`/models returned ${res.status} ${res.statusText}`);
        }
        const json = (await res.json()) as ModelsResponse;
        const data = Array.isArray(json.data) ? json.data : [];
        return data
            .filter((m) => typeof m.id === 'string')
            .map((m) => ({ modelId: m.id as string, label: m.id as string }));
    },
};
