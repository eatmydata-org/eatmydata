/**
 * Cost math + formatters for chat token usage.
 *
 * The AI SDK reports `LanguageModelUsage` as
 *   { inputTokens?, outputTokens?, reasoningTokens?, cachedInputTokens?, totalTokens? }
 * with USD-per-token prices coming from OpenRouter's /api/v1/models.
 *
 * Convention here matches OpenRouter's billing semantics:
 *   - `inputTokens` already includes `cachedInputTokens`. We split the input
 *     count and bill the cached portion at `cacheRead` (when known).
 *   - `reasoningTokens` is separate from `outputTokens`. It's billed at the
 *     model's `reasoning` price when set, otherwise rolled in at the
 *     completion price (most providers do this implicitly).
 */

import type { LanguageModelUsage } from 'ai';
import type { ModelPricing } from '@/lib/runtime/state/settings-types';

/**
 * Pull the four counts we care about out of a `LanguageModelUsage`, preferring
 * the structured *Details fields and falling back to the deprecated flat
 * ones. Returns zero for anything the provider didn't report.
 */
export function extractUsageCounts(usage: LanguageModelUsage): {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cachedInputTokens: number;
} {
    const inputTokens = usage.inputTokens ?? 0;
    const outputTokens = usage.outputTokens ?? 0;
    const cachedInputTokens =
        usage.inputTokenDetails?.cacheReadTokens ??
        usage.cachedInputTokens ??
        0;
    const reasoningTokens =
        usage.outputTokenDetails?.reasoningTokens ??
        usage.reasoningTokens ??
        0;
    return { inputTokens, outputTokens, reasoningTokens, cachedInputTokens };
}

export function computeStepCost(
    usage: LanguageModelUsage,
    pricing: ModelPricing | undefined,
): number {
    if (!pricing) return 0;
    const { inputTokens, outputTokens, reasoningTokens, cachedInputTokens } =
        extractUsageCounts(usage);
    const uncached = Math.max(0, inputTokens - cachedInputTokens);
    return (
        uncached * pricing.prompt +
        cachedInputTokens * (pricing.cacheRead ?? pricing.prompt) +
        outputTokens * pricing.completion +
        reasoningTokens * (pricing.reasoning ?? pricing.completion)
    );
}

export function formatTokens(n: number): string {
    if (!Number.isFinite(n) || n <= 0) return '0';
    if (n < 1000) return String(Math.round(n));
    if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
    if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
    return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatUsd(n: number): string {
    if (!Number.isFinite(n) || n <= 0) return '$0';
    if (n >= 1) return `$${n.toFixed(2)}`;
    if (n >= 0.01) return `$${n.toFixed(3)}`;
    return `$${n.toFixed(4)}`;
}

/**
 * Per-million-token line for the model selector dropdown. Returns one of:
 *   - "free"                              → both rates are 0
 *   - "$0.30 in · $1.20 out / 1M"          → both known
 *   - "pricing unknown"                    → pricing undefined
 */
export function formatPricingLine(pricing: ModelPricing | undefined): string {
    if (!pricing) return 'pricing unknown';
    const promptM = pricing.prompt * 1_000_000;
    const completionM = pricing.completion * 1_000_000;
    if (promptM === 0 && completionM === 0) return 'free';
    return `${formatUsdPerM(promptM)} in · ${formatUsdPerM(completionM)} out / 1M`;
}

function formatUsdPerM(n: number): string {
    if (!Number.isFinite(n) || n <= 0) return '$0';
    if (n >= 1) return `$${n.toFixed(2)}`;
    return `$${n.toFixed(4)}`;
}
