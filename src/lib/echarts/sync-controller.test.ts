import { describe, expect, it } from 'vitest';
import { detect } from './sync-controller';
import type { EChartsInstance } from './loader';

/**
 * `detect` is the pure half of the controller — it takes a list of
 * registered entries and returns the three sync structures. The chart
 * instance is irrelevant to detection, so we pass a stub.
 */
const stubChart = {} as unknown as EChartsInstance;

function entry(index: number, option: Record<string, unknown>) {
    return { index, chart: stubChart, option };
}

describe('sync-controller detect', () => {
    it('groups two cards sharing the same xAxis category data into one xCategory group', () => {
        const cards = [
            entry(0, {
                xAxis: { type: 'category', data: ['Jan', 'Feb', 'Mar'] },
                yAxis: { type: 'value' },
                series: [{ type: 'bar', data: [1, 2, 3] }],
            }),
            entry(1, {
                xAxis: { type: 'category', data: ['Jan', 'Feb', 'Mar'] },
                yAxis: { type: 'value' },
                series: [{ type: 'line', data: [4, 5, 6] }],
            }),
        ];
        const result = detect(cards);
        expect(result.xCategory).toHaveLength(1);
        expect(result.xCategory[0]?.members).toHaveLength(2);
        expect(result.xCategory[0]?.members.map((m) => m.cardIdx).sort()).toEqual([0, 1]);
    });

    it('does not group cards whose category data differs', () => {
        const cards = [
            entry(0, {
                xAxis: { type: 'category', data: ['Jan', 'Feb'] },
                yAxis: { type: 'value' },
                series: [],
            }),
            entry(1, {
                xAxis: { type: 'category', data: ['Q1', 'Q2'] },
                yAxis: { type: 'value' },
                series: [],
            }),
        ];
        const result = detect(cards);
        // Both cards produce their own (single-member) entry; neither is a
        // group worth wiring. The controller skips members < 2 at wire time.
        expect(result.xCategory.every((g) => g.members.length < 2)).toBe(true);
    });

    it('buckets named numeric axes by side + type + name', () => {
        const cards = [
            entry(0, {
                xAxis: { type: 'category', data: ['a', 'b'] },
                yAxis: { type: 'value', name: 'Revenue' },
                series: [],
            }),
            entry(1, {
                xAxis: { type: 'category', data: ['c', 'd'] },
                yAxis: { type: 'value', name: 'Revenue' },
                series: [],
            }),
            entry(2, {
                xAxis: { type: 'category', data: ['e', 'f'] },
                yAxis: { type: 'value', name: 'Unrelated' },
                series: [],
            }),
        ];
        const result = detect(cards);
        const revenueGroup = result.numeric.find((g) => g.name === 'Revenue');
        expect(revenueGroup).toBeDefined();
        expect(revenueGroup?.side).toBe('y');
        expect(revenueGroup?.members.map((m) => m.cardIdx).sort()).toEqual([0, 1]);
    });

    it('records series names across cards in seriesByName', () => {
        const cards = [
            entry(0, {
                xAxis: { type: 'category', data: ['a'] },
                yAxis: { type: 'value' },
                series: [
                    { name: 'Sales', type: 'bar', data: [1] },
                    { name: 'Returns', type: 'bar', data: [0.1] },
                ],
            }),
            entry(1, {
                xAxis: { type: 'category', data: ['a'] },
                yAxis: { type: 'value' },
                series: [{ name: 'Sales', type: 'line', data: [1] }],
            }),
            entry(2, {
                series: [{ name: 'Pie', type: 'pie', data: [{ name: 'x', value: 1 }] }],
            }),
        ];
        const result = detect(cards);
        expect(result.seriesByName.get('Sales')).toEqual(new Set([0, 1]));
        expect(result.seriesByName.get('Returns')).toEqual(new Set([0]));
        expect(result.seriesByName.get('Pie')).toEqual(new Set([2]));
    });

    it('returns empty structures for a single card', () => {
        const cards = [
            entry(0, {
                xAxis: { type: 'category', data: ['a'] },
                yAxis: { type: 'value', name: 'Revenue' },
                series: [{ name: 'Sales', type: 'bar', data: [1] }],
            }),
        ];
        const result = detect(cards);
        // A single card produces single-member entries; wiring skips
        // groups with fewer than 2 members so this is effectively a no-op.
        expect(result.xCategory.every((g) => g.members.length < 2)).toBe(true);
        expect(result.numeric.every((g) => g.members.length < 2)).toBe(true);
        expect(result.seriesByName.get('Sales')).toEqual(new Set([0]));
    });

    it('handles xAxis as an array (single-grid option with multi-axis)', () => {
        const cards = [
            entry(0, {
                xAxis: [
                    { type: 'category', data: ['a', 'b'] },
                    { type: 'category', data: ['x', 'y'] },
                ],
                yAxis: { type: 'value' },
                series: [],
            }),
            entry(1, {
                xAxis: { type: 'category', data: ['a', 'b'] },
                yAxis: { type: 'value' },
                series: [],
            }),
        ];
        const result = detect(cards);
        const matched = result.xCategory.find((g) => g.members.length >= 2);
        expect(matched).toBeDefined();
        // The card-0 xAxis index that matches should be 0 (the ['a','b'] one).
        const card0Ref = matched?.members.find((m) => m.cardIdx === 0);
        expect(card0Ref?.axisIdx).toBe(0);
    });

    it('ignores numeric axes without a name', () => {
        const cards = [
            entry(0, {
                xAxis: { type: 'category', data: ['a'] },
                yAxis: { type: 'value' },
                series: [],
            }),
            entry(1, {
                xAxis: { type: 'category', data: ['a'] },
                yAxis: { type: 'value' },
                series: [],
            }),
        ];
        const result = detect(cards);
        expect(result.numeric).toHaveLength(0);
    });
});
