/**
 * Integration coverage for low-cardinality value enumeration in
 * `describe_table`. Runs against a real in-memory WaSqliteDb (the built
 * wasm — run `make wa-sqlite` if these fail after a C change) with the
 * source resolver mocked to return it, so the whole tool path executes:
 * lazy cardinality analysis → cache → live DISTINCT query → shaped result.
 *
 * Crucially the tables here are created with plain DDL/INSERT and NEVER
 * pre-marked — mirroring a demo `.sqlite` blob — so these assertions prove
 * detection works for any source, not just the file-import path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WaSqliteDb } from '@/lib/wa-sqlite/db';
import { getLowCardColumns, clearColumnCardinality } from '@/lib/data-sources/db';

const resolverMock = vi.hoisted(() => ({ resolveDb: vi.fn() }));
vi.mock('@/lib/data-sources/resolver', () => ({ resolveDb: resolverMock.resolveDb }));

import { executeAgentTool, type DescribeTableResult } from './tools';

const STATUSES = ['paid', 'pending', 'refunded'];
const ORDERS = Array.from({ length: 12 }, (_, i) => ({
    id: i + 1,
    status: STATUSES[i % STATUSES.length]!,
    customer_email: `buyer${i}@example.com`,
    rating: (i % 5) + 1,
}));

let db: WaSqliteDb;

async function describe_(table: string): Promise<DescribeTableResult> {
    const res = await executeAgentTool('describe_table', { table }, 'src-1');
    if (!res.ok) throw new Error(`describe_table failed: ${res.error}`);
    return res.value as DescribeTableResult;
}

function columnValues(result: DescribeTableResult, name: string) {
    return result.columns.find((c) => c.name === name)?.low_card_values;
}

beforeEach(async () => {
    db = new WaSqliteDb();
    await db.init();
    await db.execRaw(
        'CREATE TABLE orders (id INTEGER, status TEXT, customer_email TEXT, rating INTEGER)',
    );
    for (const o of ORDERS) {
        await db.execRaw(
            `INSERT INTO orders (id, status, customer_email, rating)
             VALUES (${o.id}, '${o.status}', '${o.customer_email}', ${o.rating})`,
        );
    }
    resolverMock.resolveDb.mockResolvedValue(db);
});

afterEach(async () => {
    await db.close();
    vi.clearAllMocks();
});

describe('describe_table — low-cardinality values', () => {
    it('enumerates distinct values of a categorical text column with no pre-marking', async () => {
        const result = await describe_('orders');
        expect(columnValues(result, 'status')).toEqual(['paid', 'pending', 'refunded']);
    });

    it('returns numeric low-card values as numbers in ascending order', async () => {
        const result = await describe_('orders');
        expect(columnValues(result, 'rating')).toEqual([1, 2, 3, 4, 5]);
    });

    it('omits low_card_values for high-cardinality columns', async () => {
        const result = await describe_('orders');
        expect(columnValues(result, 'id')).toBeUndefined();
        expect(columnValues(result, 'customer_email')).toBeUndefined();
    });

    it('caches a verdict for every column on first describe (incl. non-categorical)', async () => {
        await describe_('orders');
        expect(new Set(await getLowCardColumns(db, 'orders'))).toEqual(
            new Set(['status', 'rating']),
        );
        // One row per column means the table is recorded as analyzed even
        // though id/customer_email are not categorical.
        const all = await db.execRaw(
            "SELECT column_name FROM __rh_meta_columns WHERE table_name = 'orders'",
        );
        expect(new Set(all.rows.map((r) => String(r.column_name)))).toEqual(
            new Set(['id', 'status', 'customer_email', 'rating']),
        );
    });

    it('excludes a column whose distinct count exceeds the cap (SQL early-exit path)', async () => {
        await db.execRaw('CREATE TABLE events (seq INTEGER, bucket INTEGER)');
        for (let i = 0; i < 60; i++) {
            await db.execRaw(`INSERT INTO events (seq, bucket) VALUES (${i}, ${i % 4})`);
        }
        const result = await describe_('events');
        expect(columnValues(result, 'seq')).toBeUndefined(); // 60 distinct > cap
        expect(columnValues(result, 'bucket')).toEqual([0, 1, 2, 3]); // 4 distinct
    });

    it('lists values from the live data, not a stale snapshot', async () => {
        await describe_('orders'); // caches the status verdict (categorical)
        await db.execRaw(
            `INSERT INTO orders (id, status, customer_email, rating)
             VALUES (99, 'disputed', 'late@example.com', 3)`,
        );
        const result = await describe_('orders');
        expect(columnValues(result, 'status')).toEqual(['disputed', 'paid', 'pending', 'refunded']);
    });

    it('re-analyzes after the cache is invalidated (import / re-import)', async () => {
        await describe_('orders');
        await clearColumnCardinality(db, 'orders');
        expect(await getLowCardColumns(db, 'orders')).toEqual([]);
        // Next describe rebuilds the verdict from scratch.
        const result = await describe_('orders');
        expect(columnValues(result, 'status')).toEqual(['paid', 'pending', 'refunded']);
        expect(new Set(await getLowCardColumns(db, 'orders'))).toEqual(
            new Set(['status', 'rating']),
        );
    });

    it('does not analyze or enumerate values for views', async () => {
        await db.execRaw("CREATE VIEW paid_orders AS SELECT * FROM orders WHERE status = 'paid'");
        const result = await describe_('paid_orders');
        expect(result.type).toBe('view');
        expect(result.columns.every((c) => c.low_card_values === undefined)).toBe(true);
        // The view was never analyzed (analysis is table-only).
        expect(await getLowCardColumns(db, 'paid_orders')).toEqual([]);
    });

    it('still returns the base column metadata + foreign keys', async () => {
        const result = await describe_('orders');
        expect(result.type).toBe('table');
        expect(result.columns.map((c) => c.name)).toEqual([
            'id',
            'status',
            'customer_email',
            'rating',
        ]);
        expect(result.foreign_keys).toEqual([]);
    });

    it('hides the column-meta table from list_tables and describe_table', async () => {
        await describe_('orders'); // creates __rh_meta_columns as a side effect
        const list = await executeAgentTool('list_tables', {}, 'src-1');
        if (!list.ok) throw new Error(`list_tables failed: ${list.error}`);
        const names = (list.value as { tables: Array<{ name: string }> }).tables.map((t) => t.name);
        expect(names).toContain('orders');
        expect(names).not.toContain('__rh_meta_columns');
        expect(names).not.toContain('__rh_meta_tables');

        const denied = await executeAgentTool(
            'describe_table',
            { table: '__rh_meta_columns' },
            'src-1',
        );
        expect(denied.ok).toBe(false);
    });

    it('errors for a non-existent table', async () => {
        const res = await executeAgentTool('describe_table', { table: 'nope' }, 'src-1');
        expect(res.ok).toBe(false);
    });
});
