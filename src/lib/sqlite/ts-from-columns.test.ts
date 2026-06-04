import { describe, expect, it } from 'vitest';
import {
    isValidJsIdentifier,
    normalizeColumnNames,
    normalizeQueryResultColumns,
    toPascalCase,
    tsFromQueryResult,
    tsFromTableColumns,
} from './ts-from-columns';
import type { QueryResult } from '@/lib/wa-sqlite/types';

function makeResult(
    columns: string[],
    declaredTypes: string[],
    rows: Array<Record<string, unknown>>,
): QueryResult {
    return {
        columns,
        declaredTypes,
        rows,
        truncated: false,
        rowLimit: 100,
    };
}

describe('toPascalCase', () => {
    it('converts snake_case to PascalCase', () => {
        expect(toPascalCase('top_customers_by_revenue')).toBe('TopCustomersByRevenue');
    });
    it('keeps digits as separate segments', () => {
        expect(toPascalCase('top_10_revenue')).toBe('Top10Revenue');
    });
    it('strips leading underscores', () => {
        expect(toPascalCase('__foo')).toBe('Foo');
    });
    it('handles single word', () => {
        expect(toPascalCase('customers')).toBe('Customers');
    });
    it('falls back to Anonymous for empty input', () => {
        expect(toPascalCase('')).toBe('Anonymous');
        expect(toPascalCase('___')).toBe('Anonymous');
    });
});

describe('tsFromQueryResult', () => {
    it('emits non-nullable fields when no nulls are observed', () => {
        const result = makeResult(
            ['customer_id', 'email'],
            ['INTEGER', 'TEXT'],
            [
                { customer_id: 1, email: 'a@x' },
                { customer_id: 2, email: 'b@x' },
            ],
        );
        const ts = tsFromQueryResult(result, 'Customers', 'customers');
        expect(ts.source).toBe(
            [
                'type Customers = Array<{',
                '  customer_id: number;',
                '  email: string;',
                '}>;',
                'declare const customers: Customers;',
            ].join('\n'),
        );
        expect(ts.columns).toEqual([
            { name: 'customer_id', primitive: 'number', nullable: false },
            { name: 'email', primitive: 'string', nullable: false },
        ]);
    });

    it('marks columns observed as null as `T | null`', () => {
        const result = makeResult(
            ['id', 'total_revenue_cents'],
            ['INTEGER', 'INTEGER'],
            [
                { id: 1, total_revenue_cents: 100 },
                { id: 2, total_revenue_cents: null },
            ],
        );
        const ts = tsFromQueryResult(result, 'Foo', 'foo');
        expect(ts.source).toContain('total_revenue_cents: number | null;');
        expect(ts.columns.find((c) => c.name === 'total_revenue_cents')?.nullable).toBe(true);
    });

    it('quotes non-identifier column names (defense-in-depth fallback)', () => {
        // Direct callers that skip `normalizeQueryResultColumns` still
        // produce parseable TS — `safeKey` JSON-quotes the field.
        // Production callers in the agent pipeline normalize upstream and
        // never hit this branch.
        const result = makeResult(['total cents'], ['INTEGER'], [{ 'total cents': 7 }]);
        const ts = tsFromQueryResult(result, 'Foo', 'foo');
        expect(ts.source).toContain('"total cents": number;');
    });

    it('maps an empty declared type to unknown and falls back to value inference', () => {
        // Computed columns (aggregates, expressions) have empty declaredType.
        const result = makeResult(['ratio'], [''], [{ ratio: 0.42 }, { ratio: 0.13 }]);
        const ts = tsFromQueryResult(result, 'Foo', 'foo');
        // Inferred as number from observed JS values.
        expect(ts.source).toContain('ratio: number;');
    });

    it('falls back to `unknown` when nothing observable', () => {
        const result = makeResult(['mystery'], [''], [{ mystery: null }]);
        const ts = tsFromQueryResult(result, 'Foo', 'foo');
        expect(ts.source).toContain('mystery: unknown | null;');
    });
});

describe('isValidJsIdentifier', () => {
    it('accepts plain identifiers', () => {
        expect(isValidJsIdentifier('foo')).toBe(true);
        expect(isValidJsIdentifier('_foo')).toBe(true);
        expect(isValidJsIdentifier('$foo')).toBe(true);
        expect(isValidJsIdentifier('foo_bar1')).toBe(true);
    });
    it('rejects leading digit, whitespace, and punctuation', () => {
        expect(isValidJsIdentifier('1foo')).toBe(false);
        expect(isValidJsIdentifier('foo bar')).toBe(false);
        expect(isValidJsIdentifier('AVG(x)')).toBe(false);
        expect(isValidJsIdentifier('')).toBe(false);
    });
    it('rejects reserved words even when syntactically identifier-shaped', () => {
        expect(isValidJsIdentifier('for')).toBe(false);
        expect(isValidJsIdentifier('class')).toBe(false);
        expect(isValidJsIdentifier('null')).toBe(false);
        expect(isValidJsIdentifier('undefined')).toBe(false);
        expect(isValidJsIdentifier('return')).toBe(false);
    });
});

describe('normalizeColumnNames', () => {
    it('passes valid identifiers through unchanged', () => {
        const { columns, renamed } = normalizeColumnNames(['id', 'name']);
        expect(columns).toEqual(['id', 'name']);
        expect(renamed).toBe(false);
    });
    it('renames invalid identifiers to col<index>', () => {
        const { columns, renamed } = normalizeColumnNames(['AVG(T1.Quantity)', 'ok']);
        expect(columns).toEqual(['col0', 'ok']);
        expect(renamed).toBe(true);
    });
    it('renames reserved-word identifiers to col<index>', () => {
        const { columns, renamed } = normalizeColumnNames(['for', 'value']);
        expect(columns).toEqual(['col0', 'value']);
        expect(renamed).toBe(true);
    });
    it('resolves collisions when the rename target already exists', () => {
        // Column 0 keeps its name; column 1 is invalid so wants `col1`;
        // column 2 is already literally named `col1` (an alias from the
        // SQL) — escalate the index-1 rename to a suffixed form.
        const { columns, renamed } = normalizeColumnNames(['col1', 'AVG(x)', 'ok']);
        expect(columns[0]).toBe('col1');
        expect(columns[1]).toBe('col1_1');
        expect(columns[2]).toBe('ok');
        expect(renamed).toBe(true);
    });
});

describe('normalizeQueryResultColumns', () => {
    it('rewrites row keys in column order when names are renamed', () => {
        const result = makeResult(
            ['AVG(T1.Quantity)'],
            [''],
            [{ 'AVG(T1.Quantity)': 12.5 }, { 'AVG(T1.Quantity)': 7.25 }],
        );
        const normalized = normalizeQueryResultColumns(result);
        expect(normalized.columns).toEqual(['col0']);
        expect(normalized.rows).toEqual([{ col0: 12.5 }, { col0: 7.25 }]);
    });
    it('drives a clean typeDeclaration end-to-end (no quoted keys)', () => {
        const result = makeResult(['AVG(T1.Quantity)'], [''], [{ 'AVG(T1.Quantity)': 12.5 }]);
        const ts = tsFromQueryResult(normalizeQueryResultColumns(result), 'AvgQty', 'avg_qty');
        expect(ts.source).toBe(
            [
                'type AvgQty = Array<{',
                '  col0: number;',
                '}>;',
                'declare const avg_qty: AvgQty;',
            ].join('\n'),
        );
    });
    it('returns the same object reference when nothing needs renaming', () => {
        const result = makeResult(['id'], ['INTEGER'], [{ id: 1 }]);
        expect(normalizeQueryResultColumns(result)).toBe(result);
    });
    it('preserves declared types and truncation metadata across renames', () => {
        const result = makeResult(['1+1', 'name'], ['', 'TEXT'], [{ '1+1': 2, name: 'a' }]);
        const normalized = normalizeQueryResultColumns(result);
        expect(normalized.columns).toEqual(['col0', 'name']);
        expect(normalized.declaredTypes).toEqual(['', 'TEXT']);
        expect(normalized.truncated).toBe(false);
        expect(normalized.rowLimit).toBe(100);
    });
});

describe('tsFromTableColumns', () => {
    it('emits nullable for non-NOT-NULL non-PK columns', () => {
        const ts = tsFromTableColumns(
            [
                { name: 'id', type: 'INTEGER', notnull: true, pk: true },
                { name: 'email', type: 'TEXT', notnull: false, pk: false },
                { name: 'name', type: 'TEXT', notnull: true, pk: false },
            ],
            'Customers',
            'customers',
        );
        expect(ts.source).toContain('id: number;');
        expect(ts.source).toContain('email: string | null;');
        expect(ts.source).toContain('name: string;');
    });
});
