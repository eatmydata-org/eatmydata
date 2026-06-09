import { writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { WaSqliteDb } from '@/lib/wa-sqlite/db';
import { findSemanticCandidates } from './semantic-index';

type FindArg = Parameters<typeof findSemanticCandidates>[0];

describe('DIAG retail xs candidates', () => {
    it('inspects claims.description selection', async () => {
        const db = new WaSqliteDb();
        await db.init();
        // Exact xs config from scripts/build-demo-retail.ts
        await db.seed({ products: 1_500, customers: 8_000, orders: 35_000, force: true });

        const out: Record<string, unknown> = {};
        const schema = await db.getSchema();
        const perTable: Record<string, string[]> = {};
        for (const t of schema.filter((s) => s.type === 'table' && !s.name.startsWith('__rh'))) {
            perTable[t.name] = await findSemanticCandidates(db as unknown as FindArg, t.name);
        }
        out.candidates = perTable;
        // claims.description is a free-text column, so it must be selected as a
        // semantic-index candidate — the property this diagnostic exercises.
        expect(perTable.claims).toContain('description');

        const tot = await db.execRaw('SELECT COUNT(*) AS n FROM claims');
        const dis = await db.execRaw('SELECT COUNT(DISTINCT description) AS d FROM claims');
        const nn = await db.execRaw(
            "SELECT COUNT(*) AS n FROM claims WHERE description IS NOT NULL AND description <> ''",
        );
        const samp = await db.execRaw('SELECT description AS v FROM claims LIMIT 5');
        out.claims = {
            total: tot.rows[0]?.n,
            nonNull: nn.rows[0]?.n,
            distinctDesc: dis.rows[0]?.d,
            sample: samp.rows.map((r) => r.v),
        };

        const outDir = mkdtempSync(join(tmpdir(), 'rh-diag-'));
        writeFileSync(join(outDir, 'diag.json'), JSON.stringify(out, null, 2));
        await db.close();
    }, 120_000);
});
