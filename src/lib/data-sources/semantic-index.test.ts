/**
 * Unit coverage for the semantic-index candidate selection — specifically that
 * it embeds free-text columns and EXCLUDES identifier/code columns (the
 * "exclude identifier-like" decision). Runs against `:memory:` wa-sqlite in
 * vitest; no embedding model needed (findSemanticCandidates only inspects
 * column types, cardinality, and value shape).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WaSqliteDb } from '@/lib/wa-sqlite/db';
import { findSemanticCandidates } from './semantic-index';

type FindArg = Parameters<typeof findSemanticCandidates>[0];

describe('semantic-index — findSemanticCandidates (identifier exclusion)', () => {
    let db: WaSqliteDb;

    beforeAll(async () => {
        db = new WaSqliteDb();
        await db.init();
        await db.execRaw(
            'CREATE TABLE product(' +
                'id INTEGER PRIMARY KEY,' + // not TEXT → skipped
                ' sku TEXT,' + // identifier name + single-token near-unique
                ' email TEXT,' + // identifier name
                ' product_url TEXT,' + // identifier name (url)
                ' ref_code TEXT,' + // identifier name (ref/code)
                ' name TEXT,' + // free text (multi-word) → KEEP
                ' description TEXT,' + // free text (multi-word) → KEEP
                ' status TEXT,' + // low-cardinality enum → excluded
                ' serial_no TEXT)', // single-token near-unique, no name match → shape-excluded
        );
        const statuses = ['active', 'archived'];
        for (let i = 1; i <= 30; i++) {
            await db.execRaw(
                `INSERT INTO product(id, sku, email, product_url, ref_code, name, description, status, serial_no)` +
                    ` VALUES (${i}, 'SKU${1000 + i}', 'user${i}@example.com',` +
                    ` 'https://example.com/p/${i}', 'RC-${i}-X',` +
                    ` 'Widget ${i} deluxe model', 'A fine ${i % 2 ? 'red' : 'blue'} widget number ${i}',` +
                    ` '${statuses[i % 2]}', 'SN${100000 + i}')`,
            );
        }
    });
    afterAll(async () => {
        await db.close();
    });

    it('keeps free-text columns, drops ids / skus / emails / urls / codes / enums / serials', async () => {
        const cands = await findSemanticCandidates(db as unknown as FindArg, 'product');
        expect([...cands].sort()).toEqual(['description', 'name']);
    });
});

describe('semantic-index — findSemanticCandidates (date/time exclusion)', () => {
    let db: WaSqliteDb;

    beforeAll(async () => {
        db = new WaSqliteDb();
        await db.init();
        // Mirrors the retail seed's `claims`: SQLite has no DATE affinity, so
        // the *_at / *_date columns are TEXT-declared ISO strings — they must
        // NOT be embedded, only the free-text `description`.
        await db.execRaw(
            'CREATE TABLE claims(' +
                'claim_id INTEGER PRIMARY KEY,' +
                ' opened_at TEXT,' + // ISO datetime in TEXT → date-excluded
                ' resolved_at TEXT,' + // ISO datetime, some NULL → date-excluded
                ' order_date TEXT,' + // ISO date, no time → date-excluded
                ' status TEXT,' + // low-cardinality enum → excluded
                ' description TEXT)', // free-text prose (unique, multi-word) → KEEP
        );
        for (let i = 1; i <= 40; i++) {
            const dd = String((i % 28) + 1).padStart(2, '0');
            const opened = `2023-04-${dd}T10:30:00.000Z`;
            const resolved = i % 3 ? `'2023-05-${dd}T08:00:00.000Z'` : 'NULL';
            const date = `2023-04-${dd}`;
            const status = i % 2 ? 'open' : 'resolved';
            const desc = `Claim ${i}: the customer reports the item ${
                i % 2 ? 'fell apart after a week of normal wear' : 'arrived damaged in transit'
            }`;
            await db.execRaw(
                `INSERT INTO claims(claim_id, opened_at, resolved_at, order_date, status, description)` +
                    ` VALUES (${i}, '${opened}', ${resolved}, '${date}', '${status}', '${desc}')`,
            );
        }
    });
    afterAll(async () => {
        await db.close();
    });

    it('keeps description, drops ISO timestamp/date TEXT columns and enums', async () => {
        const cands = await findSemanticCandidates(db as unknown as FindArg, 'claims');
        expect([...cands].sort()).toEqual(['description']);
    });
});

describe('semantic-index — findSemanticCandidates (CamelCase + contact fields)', () => {
    let db: WaSqliteDb;

    beforeAll(async () => {
        db = new WaSqliteDb();
        await db.init();
        // Real demo schemas (northwind/adventureworks) use CamelCase and pack
        // contact fields into TEXT — the cases that slipped past the old
        // `_`-anchored name regex. The names here mirror those columns exactly.
        await db.execRaw(
            'CREATE TABLE Customer(' +
                'CustomerKey INTEGER PRIMARY KEY,' +
                ' CustomerID TEXT,' + // CamelCase id (FK code) → name-excluded
                ' EmailAddress TEXT,' + // CamelCase email → name-excluded
                ' PasswordHash TEXT,' + // CamelCase hash → name-excluded
                ' PasswordSalt TEXT,' + // CamelCase salt → name-excluded
                ' PostalCode TEXT,' + // CamelCase postal/code → name-excluded
                ' HomePhone TEXT,' + // CamelCase phone → name-excluded
                ' Fax TEXT,' + // fax → name-excluded
                ' ShipAddress TEXT,' + // CamelCase address → name-excluded
                ' FirstName TEXT,' + // first_name → name-excluded
                ' LastName TEXT,' + // last_name → name-excluded
                ' Contact TEXT,' + // benign name, but values are emails → shape-excluded
                ' Hotline TEXT,' + // benign name, but values are phones → shape-excluded
                ' CompanyName TEXT,' + // free text → KEEP
                ' Notes TEXT)', // free text → KEEP
        );
        for (let i = 1; i <= 30; i++) {
            await db.execRaw(
                `INSERT INTO Customer VALUES (${i}, 'CUST${i}', 'user${i}@corp.com',` +
                    ` 'L/Rlwxzp4w7RWmEg${i}A7cXaePEPcp', 'c2FsdA${i}==', '${10000 + i}',` +
                    ` '(206) 555-${1000 + i}', '030-007${6000 + i}', '${i} Market Street',` +
                    ` 'Alice', 'Smith', 'person${i}@corp.com', '(415) 555-${2000 + i}',` +
                    ` 'Acme Trading Co ${i}', 'Long-standing wholesale partner since ${1990 + i}')`,
            );
        }
    });
    afterAll(async () => {
        await db.close();
    });

    it('drops CamelCase ids/contact fields (by name and by value shape), keeps prose', async () => {
        const cands = await findSemanticCandidates(db as unknown as FindArg, 'Customer');
        expect([...cands].sort()).toEqual(['CompanyName', 'Notes']);
    });
});

describe('semantic-index — findSemanticCandidates (entropy: UUID/GUID/base64/hex)', () => {
    let db: WaSqliteDb;

    beforeAll(async () => {
        db = new WaSqliteDb();
        await db.init();
        // High-entropy machine identifiers that are NOT near-unique (so they slip
        // past the single-token near-unique guard) and whose names give nothing
        // away — only the entropy model catches them. Each random value repeats
        // across rows (LIMIT-50 sample sees dupes, distinct/total < 0.9).
        await db.execRaw(
            'CREATE TABLE event(' +
                'event_pk INTEGER PRIMARY KEY,' +
                ' trace TEXT,' + // UUIDs → entropy/UUID-excluded
                ' braced TEXT,' + // {GUID} → entropy/UUID-excluded
                ' digest TEXT,' + // 32-hex md5 → entropy-excluded
                ' blob TEXT,' + // base64 → entropy-excluded
                ' label TEXT)', // free text → KEEP
        );
        const uuids = [
            '550e8400-e29b-41d4-a716-446655440000',
            'f47ac10b-58cc-4372-a567-0e02b2c3d479',
            '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
        ];
        const guids = [
            '{3F2504E0-4F89-41D3-9A0C-0305E82C3301}',
            '{21EC2020-3AEA-1069-A2DD-08002B30309D}',
        ];
        const md5s = ['5f4dcc3b5aa765d61d8327deb882cf99', 'e10adc3949ba59abbe56e057f20f883e'];
        const b64s = ['L/Rlwxzp4w7RWmEgXX+/A7cXaePEPcp+', 'YmFzZTY0ZW5jb2RlZHNlY3JldA=='];
        const actions = [
            'signed in',
            'checked out the cart',
            'reset their password',
            'left a review',
        ];
        for (let i = 1; i <= 30; i++) {
            const q = (s: string): string => `'${s.replace(/'/g, "''")}'`;
            // label: distinct, multi-word free text → the only KEEP.
            const label = `Account ${i} ${actions[i % actions.length]} on the web`;
            await db.execRaw(
                `INSERT INTO event VALUES (${i}, ${q(uuids[i % uuids.length]!)},` +
                    ` ${q(guids[i % guids.length]!)}, ${q(md5s[i % md5s.length]!)},` +
                    ` ${q(b64s[i % b64s.length]!)}, ${q(label)})`,
            );
        }
    });
    afterAll(async () => {
        await db.close();
    });

    it('drops UUID/GUID/base64/hex columns via the entropy model, keeps the label', async () => {
        const cands = await findSemanticCandidates(db as unknown as FindArg, 'event');
        expect([...cands].sort()).toEqual(['label']);
    });
});
