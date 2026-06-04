import { describe, it, expect } from 'vitest';
import {
    filterModelToWhere,
    sortModelToOrderBy,
    sqlLiteralValue,
    type FilterModel,
} from './ag-grid-sql';

describe('sortModelToOrderBy', () => {
    it('returns empty for null/empty', () => {
        expect(sortModelToOrderBy(null)).toBe('');
        expect(sortModelToOrderBy(undefined)).toBe('');
        expect(sortModelToOrderBy([])).toBe('');
    });
    it('emits ORDER BY for a single column', () => {
        expect(sortModelToOrderBy([{ colId: 'name', sort: 'asc' }])).toBe(
            ' ORDER BY "name" ASC',
        );
    });
    it('preserves multi-column order', () => {
        expect(
            sortModelToOrderBy([
                { colId: 'a', sort: 'desc' },
                { colId: 'b', sort: 'asc' },
            ]),
        ).toBe(' ORDER BY "a" DESC, "b" ASC');
    });
    it('escapes double quotes in column ids', () => {
        expect(sortModelToOrderBy([{ colId: 'we"ird', sort: 'asc' }])).toBe(
            ' ORDER BY "we""ird" ASC',
        );
    });
});

describe('filterModelToWhere — text', () => {
    it('returns empty for null/{}', () => {
        expect(filterModelToWhere(null)).toBe('');
        expect(filterModelToWhere({})).toBe('');
    });
    it('equals / notEqual', () => {
        expect(
            filterModelToWhere({
                name: { filterType: 'text', type: 'equals', filter: 'ada' },
            }),
        ).toBe(` WHERE "name" = 'ada'`);
        expect(
            filterModelToWhere({
                name: { filterType: 'text', type: 'notEqual', filter: 'ada' },
            }),
        ).toBe(` WHERE "name" <> 'ada'`);
    });
    it('contains escapes LIKE wildcards', () => {
        expect(
            filterModelToWhere({
                name: { filterType: 'text', type: 'contains', filter: '50%_off' },
            }),
        ).toBe(` WHERE "name" LIKE '%50\\%\\_off%' ESCAPE '\\'`);
    });
    it('startsWith / endsWith / notContains', () => {
        expect(
            filterModelToWhere({
                name: { filterType: 'text', type: 'startsWith', filter: 'al' },
            }),
        ).toBe(` WHERE "name" LIKE 'al%' ESCAPE '\\'`);
        expect(
            filterModelToWhere({
                name: { filterType: 'text', type: 'endsWith', filter: 'son' },
            }),
        ).toBe(` WHERE "name" LIKE '%son' ESCAPE '\\'`);
        expect(
            filterModelToWhere({
                name: { filterType: 'text', type: 'notContains', filter: 'x' },
            }),
        ).toBe(` WHERE "name" NOT LIKE '%x%' ESCAPE '\\'`);
    });
    it('blank / notBlank', () => {
        expect(
            filterModelToWhere({
                name: { filterType: 'text', type: 'blank' },
            }),
        ).toBe(` WHERE ("name" IS NULL OR "name" = '')`);
        expect(
            filterModelToWhere({
                name: { filterType: 'text', type: 'notBlank' },
            }),
        ).toBe(` WHERE ("name" IS NOT NULL AND "name" <> '')`);
    });
    it('escapes single quotes in text values', () => {
        expect(
            filterModelToWhere({
                name: { filterType: 'text', type: 'equals', filter: "O'Hara" },
            }),
        ).toBe(` WHERE "name" = 'O''Hara'`);
    });
    it('drops a leaf with no value (treated as no constraint)', () => {
        expect(
            filterModelToWhere({
                name: { filterType: 'text', type: 'contains', filter: '' },
            }),
        ).toBe('');
    });
});

describe('filterModelToWhere — number', () => {
    it('comparison operators', () => {
        expect(
            filterModelToWhere({
                amount: { filterType: 'number', type: 'greaterThan', filter: 100 },
            }),
        ).toBe(` WHERE "amount" > 100`);
        expect(
            filterModelToWhere({
                amount: {
                    filterType: 'number',
                    type: 'lessThanOrEqual',
                    filter: 5,
                },
            }),
        ).toBe(` WHERE "amount" <= 5`);
    });
    it('inRange emits BETWEEN', () => {
        expect(
            filterModelToWhere({
                amount: {
                    filterType: 'number',
                    type: 'inRange',
                    filter: 10,
                    filterTo: 20,
                },
            }),
        ).toBe(` WHERE "amount" BETWEEN 10 AND 20`);
    });
    it('inRange with a missing bound is dropped', () => {
        expect(
            filterModelToWhere({
                amount: {
                    filterType: 'number',
                    type: 'inRange',
                    filter: 10,
                    filterTo: null,
                },
            }),
        ).toBe('');
    });
    it('blank / notBlank', () => {
        expect(
            filterModelToWhere({
                amount: { filterType: 'number', type: 'blank' },
            }),
        ).toBe(` WHERE "amount" IS NULL`);
        expect(
            filterModelToWhere({
                amount: { filterType: 'number', type: 'notBlank' },
            }),
        ).toBe(` WHERE "amount" IS NOT NULL`);
    });
});

describe('filterModelToWhere — date', () => {
    it('inRange between two ISO strings', () => {
        expect(
            filterModelToWhere({
                created: {
                    filterType: 'date',
                    type: 'inRange',
                    dateFrom: '2025-01-01 00:00:00',
                    dateTo: '2025-12-31 23:59:59',
                },
            }),
        ).toBe(
            ` WHERE "created" BETWEEN '2025-01-01 00:00:00' AND '2025-12-31 23:59:59'`,
        );
    });
});

describe('filterModelToWhere — combined AND/OR', () => {
    it('combines with AND', () => {
        const model: FilterModel = {
            name: {
                filterType: 'text',
                operator: 'AND',
                condition1: {
                    filterType: 'text',
                    type: 'startsWith',
                    filter: 'a',
                },
                condition2: {
                    filterType: 'text',
                    type: 'endsWith',
                    filter: 'z',
                },
            },
        };
        expect(filterModelToWhere(model)).toBe(
            ` WHERE ("name" LIKE 'a%' ESCAPE '\\' AND "name" LIKE '%z' ESCAPE '\\')`,
        );
    });
    it('combines with OR', () => {
        const model: FilterModel = {
            amount: {
                filterType: 'number',
                operator: 'OR',
                condition1: { filterType: 'number', type: 'lessThan', filter: 0 },
                condition2: {
                    filterType: 'number',
                    type: 'greaterThan',
                    filter: 100,
                },
            },
        };
        expect(filterModelToWhere(model)).toBe(
            ` WHERE ("amount" < 0 OR "amount" > 100)`,
        );
    });
    it('falls back to whichever leaf is complete', () => {
        const model: FilterModel = {
            name: {
                filterType: 'text',
                operator: 'AND',
                condition1: { filterType: 'text', type: 'contains', filter: '' },
                condition2: {
                    filterType: 'text',
                    type: 'equals',
                    filter: 'bob',
                },
            },
        };
        expect(filterModelToWhere(model)).toBe(` WHERE "name" = 'bob'`);
    });
});

describe('filterModelToWhere — multiple columns', () => {
    it('joins per-column expressions with AND', () => {
        const model: FilterModel = {
            name: { filterType: 'text', type: 'contains', filter: 'ali' },
            amount: {
                filterType: 'number',
                type: 'greaterThan',
                filter: 100,
            },
        };
        // Order follows Object.keys insertion order.
        expect(filterModelToWhere(model)).toBe(
            ` WHERE "name" LIKE '%ali%' ESCAPE '\\' AND "amount" > 100`,
        );
    });
});

describe('sqlLiteralValue', () => {
    it('NULL for null / undefined / empty string', () => {
        expect(sqlLiteralValue(null)).toBe('NULL');
        expect(sqlLiteralValue(undefined)).toBe('NULL');
        expect(sqlLiteralValue('')).toBe('NULL');
    });
    it('numbers pass through; non-finite becomes NULL', () => {
        expect(sqlLiteralValue(42)).toBe('42');
        expect(sqlLiteralValue(NaN)).toBe('NULL');
        expect(sqlLiteralValue(Infinity)).toBe('NULL');
    });
    it('booleans → 0/1', () => {
        expect(sqlLiteralValue(true)).toBe('1');
        expect(sqlLiteralValue(false)).toBe('0');
    });
    it('strings get single-quote escaped', () => {
        expect(sqlLiteralValue("O'Hara")).toBe(`'O''Hara'`);
    });
});
