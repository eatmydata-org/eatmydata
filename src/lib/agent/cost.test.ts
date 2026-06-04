import { describe, expect, it } from 'vitest';
import type { LanguageModelUsage } from 'ai';
import {
    computeStepCost,
    extractUsageCounts,
    formatPricingLine,
    formatTokens,
    formatUsd,
} from './cost';

function usage(
    partial: Partial<LanguageModelUsage> = {},
): LanguageModelUsage {
    return {
        inputTokens: undefined,
        outputTokens: undefined,
        totalTokens: undefined,
        inputTokenDetails: {
            noCacheTokens: undefined,
            cacheReadTokens: undefined,
            cacheWriteTokens: undefined,
        },
        outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
        ...partial,
    } as LanguageModelUsage;
}

describe('extractUsageCounts', () => {
    it('returns zeros when nothing is reported', () => {
        expect(extractUsageCounts(usage())).toEqual({
            inputTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
            cachedInputTokens: 0,
        });
    });

    it('prefers structured details over deprecated flat fields', () => {
        const u = usage({
            inputTokens: 100,
            outputTokens: 50,
            inputTokenDetails: {
                noCacheTokens: 80,
                cacheReadTokens: 20,
                cacheWriteTokens: undefined,
            },
            outputTokenDetails: { textTokens: 40, reasoningTokens: 10 },
            // Deprecated flat fields disagree on purpose — the details win.
            cachedInputTokens: 999,
            reasoningTokens: 999,
        });
        expect(extractUsageCounts(u)).toEqual({
            inputTokens: 100,
            outputTokens: 50,
            reasoningTokens: 10,
            cachedInputTokens: 20,
        });
    });

    it('falls back to deprecated fields when details are missing', () => {
        const u = usage({
            inputTokens: 100,
            outputTokens: 50,
            cachedInputTokens: 30,
            reasoningTokens: 5,
        });
        expect(extractUsageCounts(u)).toMatchObject({
            cachedInputTokens: 30,
            reasoningTokens: 5,
        });
    });
});

describe('computeStepCost', () => {
    const pricing = {
        prompt: 1e-6,
        completion: 2e-6,
        cacheRead: 0.5e-6,
        reasoning: 3e-6,
    };

    it('returns 0 when pricing is unknown', () => {
        expect(
            computeStepCost(usage({ inputTokens: 1000 }), undefined),
        ).toBe(0);
    });

    it('charges uncached input at prompt and output at completion', () => {
        const u = usage({ inputTokens: 1000, outputTokens: 500 });
        // 1000 * 1e-6 + 500 * 2e-6 = 0.001 + 0.001 = 0.002
        expect(computeStepCost(u, pricing)).toBeCloseTo(0.002, 8);
    });

    it('splits input into cached + uncached at the discounted rate', () => {
        const u = usage({
            inputTokens: 1000,
            outputTokens: 0,
            inputTokenDetails: {
                noCacheTokens: 600,
                cacheReadTokens: 400,
                cacheWriteTokens: undefined,
            },
            outputTokenDetails: { textTokens: 0, reasoningTokens: undefined },
        });
        // 600 * 1e-6 + 400 * 0.5e-6 = 0.0006 + 0.0002 = 0.0008
        expect(computeStepCost(u, pricing)).toBeCloseTo(0.0008, 8);
    });

    it('charges reasoning tokens at the reasoning rate when set', () => {
        const u = usage({
            inputTokens: 0,
            outputTokens: 100,
            outputTokenDetails: { textTokens: 100, reasoningTokens: 50 },
        });
        // 100 * 2e-6 + 50 * 3e-6 = 0.0002 + 0.00015 = 0.00035
        expect(computeStepCost(u, pricing)).toBeCloseTo(0.00035, 8);
    });

    it('falls back to completion price for reasoning when no reasoning rate set', () => {
        const u = usage({
            inputTokens: 0,
            outputTokens: 100,
            outputTokenDetails: { textTokens: 100, reasoningTokens: 50 },
        });
        const noReasoningRate = { prompt: 1e-6, completion: 2e-6 };
        // 100 * 2e-6 + 50 * 2e-6 = 0.0003
        expect(computeStepCost(u, noReasoningRate)).toBeCloseTo(0.0003, 8);
    });
});

describe('formatTokens', () => {
    it.each([
        [0, '0'],
        [42, '42'],
        [999, '999'],
        [1000, '1.0k'],
        [1234, '1.2k'],
        [9999, '10.0k'],
        [10_000, '10k'],
        [125_000, '125k'],
        [1_500_000, '1.5M'],
    ])('formats %d as %s', (n, expected) => {
        expect(formatTokens(n)).toBe(expected);
    });
});

describe('formatUsd', () => {
    it('shows $0 for zero or negative', () => {
        expect(formatUsd(0)).toBe('$0');
        expect(formatUsd(-1)).toBe('$0');
    });
    it('uses 4dp for sub-cent values', () => {
        expect(formatUsd(0.0042)).toBe('$0.0042');
    });
    it('uses 3dp between $0.01 and $1', () => {
        expect(formatUsd(0.123)).toBe('$0.123');
    });
    it('uses 2dp at or above $1', () => {
        expect(formatUsd(1.234)).toBe('$1.23');
    });
});

describe('formatPricingLine', () => {
    it('says "pricing unknown" when undefined', () => {
        expect(formatPricingLine(undefined)).toBe('pricing unknown');
    });
    it('says "free" when both rates are zero', () => {
        expect(formatPricingLine({ prompt: 0, completion: 0 })).toBe('free');
    });
    it('formats per-1M USD with in/out segments', () => {
        // prompt = $0.30/M, completion = $1.20/M
        expect(
            formatPricingLine({ prompt: 0.0000003, completion: 0.0000012 }),
        ).toBe('$0.3000 in · $1.20 out / 1M');
    });
});
