/**
 * Fetch per-model pricing from OpenRouter.
 *
 * Two endpoints are useful here:
 *
 *   GET /api/v1/models                          — full catalog (~hundreds of
 *                                                 entries, ~400 KB). Used by
 *                                                 `fetchOpenRouterPricing`.
 *   GET /api/v1/models/{slug}/endpoints         — one model's per-provider
 *                                                 endpoint list. Tiny payload.
 *                                                 Used by
 *                                                 `fetchOpenRouterPricingForSlugs`
 *                                                 to only refresh the models
 *                                                 the user actually configured.
 *
 * Both return pricing as decimal strings denominated in USD per token
 * (e.g. `"0.0000005"` for $0.50 / 1M). We parse to numbers once at fetch time
 * so call sites never have to think about the string form.
 *
 * Entry skipped if both `prompt` and `completion` are missing — those are the
 * two we need for any meaningful cost calculation.
 */

import type { ModelPricing } from './state/settings-types';

const BASE = 'https://openrouter.ai/api/v1';

type OpenRouterPricingShape = {
    prompt?: unknown;
    completion?: unknown;
    request?: unknown;
    image?: unknown;
    web_search?: unknown;
    internal_reasoning?: unknown;
    input_cache_read?: unknown;
    cache_read?: unknown;
};

type OpenRouterModelEntry = {
    id?: unknown;
    pricing?: OpenRouterPricingShape;
};

type OpenRouterModelsResponse = {
    data?: OpenRouterModelEntry[];
};

type OpenRouterEndpointEntry = {
    pricing?: OpenRouterPricingShape;
};

type OpenRouterEndpointsResponse = {
    data?: {
        id?: unknown;
        endpoints?: OpenRouterEndpointEntry[];
    };
};

function toNumber(x: unknown): number | undefined {
    if (typeof x === 'number' && Number.isFinite(x)) return x;
    if (typeof x === 'string' && x.length > 0) {
        const n = Number(x);
        return Number.isFinite(n) ? n : undefined;
    }
    return undefined;
}

/**
 * Parse a single pricing object (the shape both endpoints return inside the
 * `pricing` field) into our internal `ModelPricing`. Returns undefined if
 * neither `prompt` nor `completion` is a finite number.
 */
export function parsePricingObject(
    p: OpenRouterPricingShape | undefined | null,
): ModelPricing | undefined {
    if (!p) return undefined;
    const prompt = toNumber(p.prompt);
    const completion = toNumber(p.completion);
    if (prompt === undefined && completion === undefined) return undefined;
    // OpenRouter occasionally returns one without the other for niche
    // models; default the missing side to 0 so we still surface a price.
    const pricing: ModelPricing = {
        prompt: prompt ?? 0,
        completion: completion ?? 0,
    };
    const cache = toNumber(p.input_cache_read ?? p.cache_read);
    if (cache !== undefined) pricing.cacheRead = cache;
    const reasoning = toNumber(p.internal_reasoning);
    if (reasoning !== undefined) pricing.reasoning = reasoning;
    return pricing;
}

/**
 * Pure parser — separated so unit tests can feed a fixture JSON without
 * touching the network.
 */
export function parseOpenRouterPricing(
    json: unknown,
): Record<string, ModelPricing> {
    const out: Record<string, ModelPricing> = {};
    const data = (json as OpenRouterModelsResponse | undefined)?.data;
    if (!Array.isArray(data)) return out;
    for (const entry of data) {
        if (!entry || typeof entry.id !== 'string') continue;
        const pricing = parsePricingObject(entry.pricing);
        if (!pricing) continue;
        out[entry.id] = pricing;
    }
    return out;
}

export async function fetchOpenRouterPricing(
    signal?: AbortSignal,
): Promise<Record<string, ModelPricing>> {
    const res = await fetch(`${BASE}/models`, { signal });
    if (!res.ok) {
        throw new Error(
            `OpenRouter /models returned ${res.status} ${res.statusText}`,
        );
    }
    const json = await res.json();
    return parseOpenRouterPricing(json);
}

/**
 * Pick the cheapest endpoint by prompt+completion. Returns undefined if no
 * endpoint has parseable pricing. The /api/v1/models endpoint's model-level
 * pricing is also the cheapest available across providers, so this matches
 * the catalog's behavior.
 */
function cheapestEndpointPricing(
    endpoints: OpenRouterEndpointEntry[] | undefined,
): ModelPricing | undefined {
    if (!Array.isArray(endpoints)) return undefined;
    let best: ModelPricing | undefined;
    let bestCost = Infinity;
    for (const e of endpoints) {
        const pricing = parsePricingObject(e?.pricing);
        if (!pricing) continue;
        const cost = pricing.prompt + pricing.completion;
        if (cost < bestCost) {
            bestCost = cost;
            best = pricing;
        }
    }
    return best;
}

/**
 * Fetch pricing for a specific list of model slugs by hitting
 * `/api/v1/models/{slug}/endpoints` once per slug in parallel.
 *
 * Use when you only need a handful of models — much smaller than pulling the
 * full catalog. A slug missing from the result map means OpenRouter doesn't
 * recognize it (404) or returned no parseable pricing; callers should treat
 * that as "drop the existing pricing" rather than carrying stale numbers.
 */
export async function fetchOpenRouterPricingForSlugs(
    slugs: string[],
    signal?: AbortSignal,
): Promise<Record<string, ModelPricing>> {
    const unique = Array.from(new Set(slugs));
    const results = await Promise.all(
        unique.map(async (slug) => {
            // `:free` is a routing variant the user committed to by
            // writing it in the slug. OpenRouter's
            // /api/v1/models/{slug}/endpoints ignores the suffix and
            // returns the base model's paid endpoints, so picking the
            // "cheapest" there yields paid numbers — actively
            // misleading in the cost UI. Short-circuit to zero.
            if (slug.endsWith(':free')) {
                return [slug, { prompt: 0, completion: 0 }] as const;
            }
            try {
                const res = await fetch(
                    `${BASE}/models/${slug}/endpoints`,
                    { signal },
                );
                if (!res.ok) return null;
                const json =
                    (await res.json()) as OpenRouterEndpointsResponse;
                const pricing = cheapestEndpointPricing(
                    json?.data?.endpoints,
                );
                return pricing ? ([slug, pricing] as const) : null;
            } catch {
                return null;
            }
        }),
    );
    const out: Record<string, ModelPricing> = {};
    for (const r of results) {
        if (r) out[r[0]] = r[1];
    }
    return out;
}
