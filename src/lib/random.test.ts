import { describe, it, expect } from 'vitest';
import { randomFloat, randomUint32, randomInt, randomToken } from './random';

describe('random (crypto-backed)', () => {
    it('randomFloat stays in [0, 1)', () => {
        for (let i = 0; i < 1000; i++) {
            const x = randomFloat();
            expect(x).toBeGreaterThanOrEqual(0);
            expect(x).toBeLessThan(1);
        }
    });

    it('randomUint32 stays in [0, 2^32)', () => {
        for (let i = 0; i < 1000; i++) {
            const x = randomUint32();
            expect(Number.isInteger(x)).toBe(true);
            expect(x).toBeGreaterThanOrEqual(0);
            expect(x).toBeLessThanOrEqual(0xffffffff);
        }
    });

    it('randomInt stays in [0, max) and covers the range', () => {
        const seen = new Set<number>();
        for (let i = 0; i < 2000; i++) {
            const x = randomInt(5);
            expect(x).toBeGreaterThanOrEqual(0);
            expect(x).toBeLessThan(5);
            seen.add(x);
        }
        expect(seen.size).toBe(5); // every value [0,5) hit at least once
    });

    it('randomInt guards non-positive bounds', () => {
        expect(randomInt(0)).toBe(0);
        expect(randomInt(-3)).toBe(0);
    });

    it('randomToken returns 2 hex chars per byte and is non-constant', () => {
        expect(randomToken(8)).toMatch(/^[0-9a-f]{16}$/);
        expect(randomToken(3)).toMatch(/^[0-9a-f]{6}$/);
        expect(randomToken(8)).not.toBe(randomToken(8));
    });
});
