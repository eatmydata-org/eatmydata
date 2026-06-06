/**
 * Background model-price priming — the no-button replacement for the old
 * "Download prices" control.
 *
 * For every enabled provider that can report pricing, fetch it and patch the
 * result onto the in-memory providers: OpenRouter from its API (cached in the
 * browser Cache API for a day — see {@link getCachedOpenRouterPrices}), other
 * providers (e.g. Google) from their committed map via the capability adapter.
 *
 * Pricing is session state, not persisted — the catalog is always rebuilt from
 * `@app-config`, and `persist` strips the derived `providers` — so this runs
 * once per tab boot (driven from `host.boot`). The merge keeps the pricing for
 * the session via `buildProviders`'s `prevPricing`. Best-effort: never throws.
 */

import { getSettings, patchSettings } from './state/settings';
import type { ModelPricing, ProviderInstance } from './state/settings-types';
import { adapterFor } from '@/lib/agent/providers';
import { getCachedOpenRouterPrices } from './openrouter-price-cache';

export async function primeModelPrices(): Promise<void> {
    const providers = getSettings().providers;
    let changed = false;

    const next = await Promise.all(
        providers.map(async (p): Promise<ProviderInstance> => {
            if (!p.enabled || p.models.length === 0) return p;
            const slugs = p.models.map((m) => m.modelId);
            let prices: Record<string, ModelPricing> = {};
            try {
                prices =
                    p.kind === 'openrouter'
                        ? await getCachedOpenRouterPrices(slugs)
                        : ((await adapterFor(p.kind).fetchPrices?.(p, slugs)) ?? {});
            } catch (e) {
                console.warn(`[prices] prime for provider "${p.id}" failed:`, e);
                return p;
            }
            if (Object.keys(prices).length === 0) return p;
            changed = true;
            return {
                ...p,
                models: p.models.map((m) =>
                    prices[m.modelId] ? { ...m, pricing: prices[m.modelId] } : m,
                ),
            };
        }),
    );

    if (changed) patchSettings({ providers: next });
}
