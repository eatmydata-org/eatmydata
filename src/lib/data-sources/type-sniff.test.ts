import { describe, it, expect } from 'vitest';
import { sniffColumn, coerceCell } from './type-sniff';

describe('sniffColumn', () => {
    it('flags all-integer columns as INTEGER', () => {
        expect(sniffColumn(['1', '2', '3', '-4']).sqlType).toBe('INTEGER');
    });
    it('detects en-locale reals', () => {
        expect(sniffColumn(['1,234.56', '999.99', '0.5'])).toEqual({
            sqlType: 'REAL',
            decimal: 'point',
        });
    });
    it('detects de-locale reals', () => {
        expect(sniffColumn(['1.234,56', '999,99', '0,5'])).toEqual({
            sqlType: 'REAL',
            decimal: 'comma',
        });
    });
    it('falls back to TEXT when mixed', () => {
        expect(sniffColumn(['1.2', '1,2', 'banana']).sqlType).toBe('TEXT');
    });
    it('treats empty samples as TEXT', () => {
        expect(sniffColumn([null, '', undefined]).sqlType).toBe('TEXT');
    });
    it('accepts typed numbers from XLSX', () => {
        expect(sniffColumn([1, 2, 3.5]).sqlType).toBe('REAL');
        expect(sniffColumn([1, 2, 3]).sqlType).toBe('INTEGER');
    });
});

describe('coerceCell', () => {
    it('parses en-locale numbers', () => {
        const s = { sqlType: 'REAL' as const, decimal: 'point' as const };
        expect(coerceCell('1,234.56', s)).toBe(1234.56);
    });
    it('parses de-locale numbers', () => {
        const s = { sqlType: 'REAL' as const, decimal: 'comma' as const };
        expect(coerceCell('1.234,56', s)).toBe(1234.56);
    });
    it('keeps unparseable as fallback string', () => {
        const s = { sqlType: 'INTEGER' as const, decimal: 'none' as const };
        expect(coerceCell('not a number', s)).toBe('not a number');
    });
    it('maps empty to null', () => {
        const s = { sqlType: 'TEXT' as const, decimal: 'none' as const };
        expect(coerceCell('', s)).toBe(null);
        expect(coerceCell(null, s)).toBe(null);
    });
});
