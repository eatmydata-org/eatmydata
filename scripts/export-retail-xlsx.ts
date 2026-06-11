#!/usr/bin/env -S node --experimental-strip-types --no-warnings
/**
 * Export the retail seed DB to .xlsx workbooks (one file per size variant,
 * one sheet per table). Test artifact — not part of the demo-data pipeline.
 *
 *   node --experimental-strip-types scripts/export-retail-xlsx.ts \
 *        [--out <dir>] [--variant xs|m|xl ...]
 *
 * Seeds an in-memory retail DB per variant (same deterministic seeder the
 * demo .sqlite files use), reads every table via execFull, and dumps each
 * into a sheet of <out>/retail-<variant>.xlsx.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as XLSX from 'xlsx';
import { WaSqliteDb } from '../src/lib/wa-sqlite/db.ts';
import type { WaSeedOptions } from '../src/lib/wa-sqlite/seed.ts';

type Variant = 'xs' | 'm' | 'xl';

// Kept in lockstep with scripts/build-demo-retail.ts.
const VARIANT_OPTIONS: Record<Variant, WaSeedOptions> = {
    xs: { products: 1_500, customers: 8_000, orders: 35_000 },
    m: { products: 4_000, customers: 25_000, orders: 110_000 },
    xl: { products: 10_000, customers: 80_000, orders: 380_000 },
};

const TABLES = [
    'warehouses',
    'products',
    'stock',
    'customers',
    'orders',
    'order_items',
    'returns',
    'claims',
] as const;

// Well above the largest single table (order_items at xl ≈ 635k rows), and
// under Excel's 1,048,576-row-per-sheet ceiling.
const ROW_CAP = 5_000_000;

function parseArgs(): { out: string; variants: Variant[] } {
    const args = process.argv.slice(2);
    let out = 'exports';
    const variants: Variant[] = [];
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--out') out = args[++i]!;
        else if (a === '--variant') {
            const v = args[++i] as Variant;
            if (!(v in VARIANT_OPTIONS)) throw new Error(`Unknown variant: ${v}`);
            variants.push(v);
        } else throw new Error(`Unknown arg: ${a}`);
    }
    return { out, variants: variants.length ? variants : ['xs', 'm', 'xl'] };
}

async function exportVariant(variant: Variant, outDir: string): Promise<void> {
    const opts = VARIANT_OPTIONS[variant];
    const db = new WaSqliteDb();
    await db.init();

    const t0 = Date.now();
    await db.seed({ ...opts, force: true });

    const wb = XLSX.utils.book_new();
    const counts: Record<string, number> = {};
    for (const t of TABLES) {
        const res = await db.execFull(`SELECT * FROM "${t}"`, ROW_CAP);
        if (res.truncated) throw new Error(`${t} exceeded ROW_CAP (${ROW_CAP})`);
        counts[t] = res.rows.length;
        const ws = XLSX.utils.json_to_sheet(res.rows);
        XLSX.utils.book_append_sheet(wb, ws, t); // all names < 31 chars
    }

    const outPath = join(outDir, `retail-${variant}.xlsx`);
    // xlsx.mjs has no Node fs bound for writeFile, so serialize to a buffer and
    // write it ourselves. The patched contrib/sheetjs reads opts.xlsxCss
    // unconditionally; an empty object makes its apply_ifdef hooks fall back to
    // default styling.
    const buf = XLSX.write(wb, {
        type: 'buffer',
        bookType: 'xlsx',
        xlsxCss: {},
    } as XLSX.WritingOptions) as Uint8Array;
    writeFileSync(outPath, buf);
    await db.close();

    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    console.log(
        `[retail-${variant}] ${total.toLocaleString()} rows across ${TABLES.length} sheets ` +
            `→ ${outPath} (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
    );
    for (const t of TABLES) console.log(`  ${t.padEnd(14)} ${counts[t]!.toLocaleString()}`);
}

async function main(): Promise<void> {
    const { out, variants } = parseArgs();
    mkdirSync(out, { recursive: true });
    for (const v of variants) await exportVariant(v, out);
}

await main();
