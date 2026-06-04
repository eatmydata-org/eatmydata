/**
 * Per-provider capability adapters: everything provider-specific that is
 * NOT model resolution (which the AI SDK registry in `../registry.ts`
 * handles). Each {@link ProviderKind} has one adapter covering connection/
 * uptime testing, optional catalog listing, and optional price fetching.
 */

import type {
    ModelPricing,
    ProviderInstance,
    ProviderKind,
} from '@/lib/runtime/state/settings-types';

/** Result of a no-token-spend connection/uptime probe. */
export type ConnectionTestResult =
    | { ok: true; ms: number; label?: string }
    | { ok: false; ms: number; message: string };

/** A model the provider's catalog reports (used to seed the table). */
export interface CatalogModel {
    modelId: string;
    label: string;
}

export interface ProviderAdapter {
    kind: ProviderKind;
    /** Display name in the "Add provider" picker. */
    label: string;
    /** Whether an API-key field is shown for this kind. */
    requiresApiKey: boolean;
    /** Base-URL field policy. */
    baseURL: 'none' | 'optional' | 'required';
    /** Whether a "Download prices" button is offered. */
    canFetchPrices: boolean;
    /**
     * When true, prices are filled automatically on every model save (the
     * source is a committed static map, so there's no network cost and no
     * reason to make the user click). The explicit "Download prices" button
     * is hidden for these. Only sensible alongside {@link fetchPrices}.
     */
    autoFetchPrices?: boolean;
    /**
     * Verify the key/endpoint reachability without invoking a model.
     * Always resolves (errors are returned as `{ ok: false }`), never throws.
     */
    testConnection(cfg: ProviderInstance, signal?: AbortSignal): Promise<ConnectionTestResult>;
    /** List the provider's available models. Optional. */
    listModels?(cfg: ProviderInstance, signal?: AbortSignal): Promise<CatalogModel[]>;
    /**
     * Resolve pricing for the given bare `modelId`s. Returns a map keyed by
     * `modelId`; a missing key means "no pricing known — drop any stale value".
     */
    fetchPrices?(
        cfg: ProviderInstance,
        modelIds: string[],
        signal?: AbortSignal,
    ): Promise<Record<string, ModelPricing>>;
}

/** Time a probe and normalize thrown errors into a failure result. */
export async function timedProbe(
    fn: () => Promise<{ ok: true; label?: string } | { ok: false; message: string }>,
): Promise<ConnectionTestResult> {
    const t0 = performance.now();
    try {
        const r = await fn();
        const ms = Math.round(performance.now() - t0);
        return r.ok ? { ok: true, ms, label: r.label } : { ok: false, ms, message: r.message };
    } catch (e) {
        return {
            ok: false,
            ms: Math.round(performance.now() - t0),
            message: e instanceof Error ? e.message : String(e),
        };
    }
}
