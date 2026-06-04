/**
 * Vitest coverage for the wa-sqlite engine.
 *
 * Runs against `:memory:` only — OPFSCoopSyncVFS needs OPFS, which isn't
 * available in vitest's `node` environment. OPFS-dependent scenarios live
 * in the browser testbed (`src/lib/test-runner/tests-wa-sqlite.ts`).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { WaSqliteDb } from './db';

/**
 * Build a tiny `.sqlite` blob via wa-sqlite itself: open `:memory:`,
 * create + insert, `serialize()` to bytes. Round-trip target for the
 * `loadFile()` test.
 */
async function makeSampleFile(): Promise<Uint8Array> {
    const db = new WaSqliteDb();
    try {
        await db.init();
        await db.execRaw(
            'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT)',
        );
        await db.execRaw('CREATE VIEW user_names AS SELECT name FROM users');
        await db.execRaw("INSERT INTO users(name, email) VALUES ('ada', 'ada@example.com')");
        return await db.serialize();
    } finally {
        await db.close();
    }
}

describe('WaSqliteDb', () => {
    let sample: Uint8Array;

    beforeAll(async () => {
        sample = await makeSampleFile();
    });

    it('reports an empty schema for a fresh database', async () => {
        const db = new WaSqliteDb();
        await db.init();
        expect(await db.getSchema()).toEqual([]);
        await db.close();
    });

    it('loads a file and exposes its schema', async () => {
        const db = new WaSqliteDb();
        await db.init();
        await db.loadFile(sample);

        const schema = await db.getSchema();
        const users = schema.find((t) => t.name === 'users');
        const view = schema.find((t) => t.name === 'user_names');

        expect(users).toBeDefined();
        expect(users!.type).toBe('table');
        expect(users!.columns.map((c) => c.name)).toEqual(['id', 'name', 'email']);
        expect(users!.columns.find((c) => c.name === 'id')!.pk).toBe(true);
        expect(users!.columns.find((c) => c.name === 'name')!.notnull).toBe(true);
        expect(users!.columns.find((c) => c.name === 'email')!.notnull).toBe(false);

        expect(view).toBeDefined();
        expect(view!.type).toBe('view');

        await db.close();
    });

    it('validates queries against the loaded schema', async () => {
        const db = new WaSqliteDb();
        await db.init();
        await db.loadFile(sample);

        expect(await db.validateQuery('SELECT id, name FROM users WHERE id > 0')).toEqual({
            ok: true,
        });

        const syntax = await db.validateQuery('SELEC * FROM users');
        expect(syntax.ok).toBe(false);
        expect(syntax.error).toMatch(/syntax/i);

        const missing = await db.validateQuery('SELECT * FROM not_a_table');
        expect(missing.ok).toBe(false);
        expect(missing.error).toMatch(/no such table/i);

        await db.close();
    });

    it('throws if used before init', async () => {
        const db = new WaSqliteDb();
        await expect(db.getSchema()).rejects.toThrow(/not initialized/);
    });

    it('exposes per-column origin + extracted SQL literals (obfuscation signals)', async () => {
        // The exact shape from the bug report: a raw column projected next to
        // a CASE that emits string literals. The obfuscation engine relies on
        // both signals being correct at runtime — origin distinguishes the raw
        // column from the expression, and EXPLAIN recovers the literals.
        const db = new WaSqliteDb();
        await db.init();
        await db.loadFile(sample);

        const result = await db.execQuery(
            `SELECT
                 name,
                 CASE WHEN email < '2024-01-01' THEN 'Q4 2023' ELSE 'Q1 2024' END AS period
             FROM users
             WHERE id < 5`,
        );

        expect(result.columns).toEqual(['name', 'period']);
        // sqlite3_column_origin_name: 'name' traces to the base-table column;
        // the CASE expression has no origin → '' (requires the build's
        // SQLITE_ENABLE_COLUMN_METADATA).
        expect(result.columnOrigins).toEqual(['name', '']);
        // EXPLAIN literal extraction recovers the string + integer constants.
        const literals = new Set(result.sqlLiterals);
        expect(literals.has('Q4 2023')).toBe(true);
        expect(literals.has('Q1 2024')).toBe(true);
        expect(literals.has('2024-01-01')).toBe(true);
        expect(literals.has('5')).toBe(true);

        await db.close();
    });

    it('seeds a retail database with 50k+ rows and a sales view', async () => {
        const db = new WaSqliteDb();
        await db.init();

        const result = await db.seed();
        expect(result.seeded).toBe(true);

        const total = Object.values(result.tables).reduce((a, b) => a + b, 0);
        expect(total).toBeGreaterThan(50_000);

        for (const name of [
            'warehouses',
            'products',
            'stock',
            'customers',
            'orders',
            'order_items',
            'returns',
            'claims',
        ]) {
            expect(result.tables[name]).toBeGreaterThan(0);
        }

        const schema = await db.getSchema();
        const sales = schema.find((t) => t.name === 'sales');
        expect(sales?.type).toBe('view');

        // A second call without force is a no-op.
        const again = await db.seed();
        expect(again.seeded).toBe(false);
        expect(again.tables.products).toBe(result.tables.products);

        // force re-seeds with the same deterministic counts.
        const reseed = await db.seed({ force: true });
        expect(reseed.seeded).toBe(true);
        expect(reseed.tables).toEqual(result.tables);

        await db.close();
    }, 120_000);
});
