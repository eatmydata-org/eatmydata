/**
 * Coverage for `buildPlannerSchemaManifest` — the schema + searchable-column
 * block the orchestrator front-loads into the Planner kickoff so it never has
 * to discover the structure (or the otherwise-invisible `vector_search`
 * markers) via list_tables/describe_table.
 *
 * Runs against a real in-memory WaSqliteDb (the built wasm — run
 * `make wa-sqlite` if these fail after a C change) with the source resolver
 * mocked to return it, so the manifest is built off live sqlite_master /
 * PRAGMAs exactly as it is in production.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WaSqliteDb } from '@/lib/wa-sqlite/db';

const resolverMock = vi.hoisted(() => ({ resolveDb: vi.fn() }));
vi.mock('@/lib/data-sources/resolver', () => ({ resolveDb: resolverMock.resolveDb }));

import { buildPlannerSchemaManifest } from './tools';

let db: WaSqliteDb;

beforeEach(async () => {
    db = new WaSqliteDb();
    await db.init();
    resolverMock.resolveDb.mockResolvedValue(db);
});

afterEach(async () => {
    await db.close();
    vi.clearAllMocks();
});

describe('buildPlannerSchemaManifest', () => {
    it('lists tables with columns, types, and PK markers; no searchable block when nothing is indexed', async () => {
        await db.execRaw('CREATE TABLE product (id INTEGER PRIMARY KEY, name TEXT, price REAL)');
        const m = await buildPlannerSchemaManifest('src-1');
        expect(m).toContain('Tables:');
        expect(m).toMatch(/product\(id:INTEGER PK, name:TEXT, price:REAL\)/);
        expect(m).not.toContain('Semantic search is available');
    });

    it('renders foreign keys as arrows', async () => {
        await db.execRaw('CREATE TABLE customer (id INTEGER PRIMARY KEY, name TEXT)');
        await db.execRaw(
            'CREATE TABLE invoice (id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customer(id))',
        );
        const m = await buildPlannerSchemaManifest('src-1');
        expect(m).toMatch(/invoice\(id:INTEGER PK, customer_id:INTEGER →customer\.id\)/);
    });

    it('always front-loads searchable columns + the usage hint from _rhvec_search_map', async () => {
        await db.execRaw('CREATE TABLE claims (id INTEGER PRIMARY KEY, description TEXT)');
        await db.execRaw(
            'CREATE TABLE _rhvec_search_map (base_tbl TEXT, base_col TEXT, store_tbl TEXT, store_col TEXT, model TEXT, dim INTEGER, metric TEXT)',
        );
        await db.execRaw(
            "INSERT INTO _rhvec_search_map (base_tbl, base_col, store_tbl, store_col) VALUES ('claims','description','_rhvec_emb_x','vec')",
        );
        const m = await buildPlannerSchemaManifest('src-1');
        expect(m).toContain('Semantic search is available');
        expect(m).toContain('claims.description');
        expect(m).toContain('vector_search(');
        // The marker is also stamped on the column line in the structure block.
        expect(m).toMatch(/description:TEXT \[search\]/);
        // The internal shadow table itself stays hidden from the Tables list.
        expect(m).not.toContain('_rhvec_search_map(');
    });

    it('degrades to names-only for a large schema (over the table limit)', async () => {
        for (let i = 0; i < 31; i++) {
            await db.execRaw(`CREATE TABLE t${i} (a INTEGER, b TEXT)`);
        }
        const m = await buildPlannerSchemaManifest('src-1');
        expect(m).toMatch(/large schema, names only/);
        expect(m).toContain('t0');
        // No per-column detail form for the gated case.
        expect(m).not.toContain('t0(a:INTEGER');
    });

    it('returns empty string for a source with no user objects', async () => {
        const m = await buildPlannerSchemaManifest('src-1');
        expect(m).toBe('');
    });
});
