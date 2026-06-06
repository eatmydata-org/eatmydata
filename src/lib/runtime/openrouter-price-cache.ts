/**
 * 1-day cached wrapper around OpenRouter price fetching.
 *
 * OpenRouter prices are public (no key) and change slowly, so we fetch them in
 * the background and stash the result in the browser **Cache API**
 * (`globalThis.caches`) — which, unlike a plain in-memory global, survives
 * reloads and is shared across same-origin tabs. A custom timestamp gives the
 * Cache (which never auto-expires) a 1-day TTL. The first tab within a day
 * hits the network; everyone else reads the cache.
 *
 * Keyed by the exact slug set, so changing the configured catalog refetches.
 */

import type { ModelPricing } from './state/settings-types';
import { fetchOpenRouterPricingForSlugs } from './openrouter-pricing';

const CACHE_NAME = 'analyst-openrouter-prices-v1';
// Synthetic key — never network-fetched, only used for cache.match/put.
const CACHE_KEY = 'https://openrouter.invalid/prices.json';
const TTL_MS = 24 * 60 * 60 * 1000; // 1 day

interface CachedPrices {
    fetchedAt: number;
    slugsKey: string;
    prices: Record<string, ModelPricing>;
}

const slugsKeyOf = (slugs: string[]): string => Array.from(new Set(slugs)).sort().join('|');

async function readCache(slugsKey: string): Promise<Record<string, ModelPricing> | null> {
    if (typeof caches === 'undefined') return null;
    try {
        const res = await (await caches.open(CACHE_NAME)).match(CACHE_KEY);
        if (!res) return null;
        const data = (await res.json()) as CachedPrices;
        if (!data || data.slugsKey !== slugsKey || typeof data.fetchedAt !== 'number') return null;
        if (Date.now() - data.fetchedAt > TTL_MS) return null;
        return data.prices ?? null;
    } catch (e) {
        console.warn('[openrouter-prices] cache read failed:', e);
        return null;
    }
}

async function writeCache(slugsKey: string, prices: Record<string, ModelPricing>): Promise<void> {
    if (typeof caches === 'undefined') return;
    try {
        const body: CachedPrices = { fetchedAt: Date.now(), slugsKey, prices };
        await (
            await caches.open(CACHE_NAME)
        ).put(
            CACHE_KEY,
            new Response(JSON.stringify(body), {
                headers: { 'content-type': 'application/json' },
            }),
        );
    } catch (e) {
        console.warn('[openrouter-prices] cache write failed:', e);
    }
}

/**
 * OpenRouter prices for `slugs`, served from the Cache API for up to a day. A
 * changed slug set or an expired entry refetches. Never throws; returns `{}` on
 * an unreachable network — and does NOT cache an empty result, so the next call
 * retries instead of being stuck price-less for a day.
 */
export async function getCachedOpenRouterPrices(
    slugs: string[],
): Promise<Record<string, ModelPricing>> {
    if (slugs.length === 0) return {};
    const slugsKey = slugsKeyOf(slugs);
    const cached = await readCache(slugsKey);
    if (cached) return cached;
    const fresh = await fetchOpenRouterPricingForSlugs(slugs);
    if (Object.keys(fresh).length > 0) await writeCache(slugsKey, fresh);
    return fresh;
}
