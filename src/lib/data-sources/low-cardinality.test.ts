import { describe, it, expect } from 'vitest';
import { isLowCardinality, LOW_CARD_ALWAYS_FLOOR, LOW_CARD_MAX_DISTINCT } from './low-cardinality';

describe('isLowCardinality', () => {
    it('treats a small enum as categorical regardless of row count', () => {
        expect(isLowCardinality(3, 300)).toBe(true);
        expect(isLowCardinality(6, 1_000_000)).toBe(true);
    });

    it('keeps the always-floor as categorical even when every value is unique', () => {
        // distinctCount === rowCount, but at/under the floor → still categorical.
        expect(isLowCardinality(LOW_CARD_ALWAYS_FLOOR, LOW_CARD_ALWAYS_FLOOR)).toBe(true);
    });

    it('applies the ratio gate above the floor', () => {
        expect(isLowCardinality(10, 100)).toBe(true); // 0.10 ≤ 0.5 → keep
        expect(isLowCardinality(10, 15)).toBe(false); // 0.67 > 0.5 → drop
        expect(isLowCardinality(20, 40)).toBe(true); // exactly 0.5 → keep
        expect(isLowCardinality(21, 40)).toBe(false); // just over 0.5 → drop
    });

    it('rejects unique-per-row columns (ids / emails) past the floor', () => {
        expect(isLowCardinality(30, 30)).toBe(false);
    });

    it('never marks a column past the absolute distinct cap', () => {
        expect(isLowCardinality(LOW_CARD_MAX_DISTINCT, 100_000)).toBe(true);
        expect(isLowCardinality(LOW_CARD_MAX_DISTINCT + 1, 100_000)).toBe(false);
    });

    it('rejects empty/all-null columns (nothing to enumerate)', () => {
        expect(isLowCardinality(0, 0)).toBe(false);
        expect(isLowCardinality(0, 1000)).toBe(false);
    });
});
