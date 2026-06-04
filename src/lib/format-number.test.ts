import { describe, expect, it } from 'vitest';
import { toDecimalString } from './format-number';

describe('toDecimalString', () => {
    it.each<[number, string]>([
        [0, '0'],
        [1, '1'],
        [-1, '-1'],
        [0.5, '0.5'],
        [1.75, '1.75'],
        [-1.75, '-1.75'],
        [123456789, '123456789'],
        // Below 1e-6 toString switches to exponent — our job is to undo it.
        [1e-7, '0.0000001'],
        [3e-7, '0.0000003'],
        [1.75e-6, '0.00000175'],
        [-1e-7, '-0.0000001'],
        [1e-20, '0.00000000000000000001'],
        // Above 1e21 also goes exponential.
        [1e21, '1000000000000000000000'],
        [1.5e21, '1500000000000000000000'],
        // The classic float64 imprecision — toString gives the shortest
        // round-trip, so we get the friendly form.
        [0.1, '0.1'],
        [0.2, '0.2'],
    ])('formats %p as %p', (input, expected) => {
        expect(toDecimalString(input)).toBe(expected);
    });

    it('passes NaN / Infinity through unchanged', () => {
        expect(toDecimalString(NaN)).toBe('NaN');
        expect(toDecimalString(Infinity)).toBe('Infinity');
        expect(toDecimalString(-Infinity)).toBe('-Infinity');
    });
});
