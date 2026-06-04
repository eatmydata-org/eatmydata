import { describe, it, expect } from 'vitest';
import {
    toSnakeCase,
    dedupIdentifier,
    dedupHumanName,
    basenameWithoutExtension,
    sanitizeColumnNames,
} from './identifier';
import { makeDbFile } from './store';

describe('toSnakeCase', () => {
    it('strips the file extension', () => {
        expect(toSnakeCase('Q3 Sales.csv')).toBe('q3_sales');
    });
    it('converts camel/PascalCase', () => {
        expect(toSnakeCase('myAwesomeData')).toBe('my_awesome_data');
        expect(toSnakeCase('OrderItems')).toBe('order_items');
    });
    it('replaces punctuation/spaces with underscore', () => {
        expect(toSnakeCase("john's-shop (2024)!")).toBe('john_s_shop_2024');
    });
    it('avoids leading digit', () => {
        expect(toSnakeCase('2024-orders')).toBe('t_2024_orders');
    });
    it('falls back when empty', () => {
        expect(toSnakeCase('', 'fallback')).toBe('fallback');
        expect(toSnakeCase('!!!', 'fallback')).toBe('fallback');
    });
    it('appends underscore on reserved words', () => {
        expect(toSnakeCase('select')).toBe('select_');
        expect(toSnakeCase('TABLE')).toBe('table_');
    });
});

describe('dedupIdentifier', () => {
    it('returns the original when no clash', () => {
        expect(dedupIdentifier('foo', new Set(['bar']))).toBe('foo');
    });
    it('appends _1, _2, … until unique', () => {
        expect(dedupIdentifier('foo', new Set(['foo']))).toBe('foo_1');
        expect(dedupIdentifier('foo', new Set(['foo', 'foo_1']))).toBe(
            'foo_2',
        );
        expect(
            dedupIdentifier('foo', new Set(['foo', 'foo_1', 'foo_2'])),
        ).toBe('foo_3');
    });
});

describe('dedupHumanName', () => {
    it('returns original when unique', () => {
        expect(dedupHumanName('Sales Q3', new Set(['Other']))).toBe(
            'Sales Q3',
        );
    });
    it('adds (1), (2), … as collisions accumulate', () => {
        expect(dedupHumanName('Sales Q3', new Set(['Sales Q3']))).toBe(
            'Sales Q3 (1)',
        );
        expect(
            dedupHumanName(
                'Sales Q3',
                new Set(['Sales Q3', 'Sales Q3 (1)']),
            ),
        ).toBe('Sales Q3 (2)');
        expect(
            dedupHumanName(
                'Sales Q3',
                new Set(['Sales Q3', 'Sales Q3 (1)', 'Sales Q3 (2)']),
            ),
        ).toBe('Sales Q3 (3)');
    });
});

describe('basenameWithoutExtension', () => {
    it('strips a normal extension', () => {
        expect(basenameWithoutExtension('Sales Q3.csv')).toBe('Sales Q3');
        expect(basenameWithoutExtension('orders.xlsx')).toBe('orders');
    });
    it('leaves names without an extension alone', () => {
        expect(basenameWithoutExtension('README')).toBe('README');
    });
    it('does not strip multi-dot suffixes that look like names', () => {
        expect(basenameWithoutExtension('archive.tar.gz')).toBe('archive.tar');
    });
});

describe('makeDbFile', () => {
    it('derives snake_case leaf from name for OPFS persistence', () => {
        expect(makeDbFile('Sales Q3', 'persistent', new Set())).toBe(
            'sales_q3.sqlite',
        );
        expect(makeDbFile('Sales Q3', 'temp', new Set())).toBe(
            'sales_q3.sqlite',
        );
    });
    it('appends _1, _2, … on leaf-name collisions', () => {
        expect(
            makeDbFile('Sales Q3', 'persistent', new Set(['sales_q3.sqlite'])),
        ).toBe('sales_q3_1.sqlite');
        expect(
            makeDbFile(
                'Sales Q3',
                'persistent',
                new Set(['sales_q3.sqlite', 'sales_q3_1.sqlite']),
            ),
        ).toBe('sales_q3_2.sqlite');
    });
    it('keeps mem_<uuid> for memory persistence', () => {
        const file = makeDbFile('whatever', 'memory', new Set(), 'abc-123');
        expect(file).toBe('mem_abc-123');
    });
});

describe('sanitizeColumnNames', () => {
    it('dedupes intra-batch collisions', () => {
        const out = sanitizeColumnNames(['Total $', 'total $', 'total_']);
        expect(out).toEqual(['total', 'total_1', 'total_2']);
    });
    it('handles empty header cells', () => {
        const out = sanitizeColumnNames(['name', '', 'amount']);
        expect(out[0]).toBe('name');
        expect(out[1]).toMatch(/^col_/);
        expect(out[2]).toBe('amount');
    });
});
