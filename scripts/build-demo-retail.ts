#!/usr/bin/env -S node --experimental-strip-types --no-warnings
/**
 * Build a pre-seeded retail demo .sqlite file.
 *
 *   node --experimental-strip-types scripts/build-demo-retail.ts \
 *        --variant {xs|m|xl} --out public/demo/retail-<v>.sqlite
 *
 * Runs the in-browser seeder against a `:memory:` connection, then dumps
 * the result via `WaSqliteDb.serialize()`. The browser flow downloads the
 * file and writes it straight to OPFS — no seeding at click time.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { WaSqliteDb } from '../src/lib/wa-sqlite/db.ts';
import type { WaSeedOptions } from '../src/lib/wa-sqlite/seed.ts';

type Variant = 'xs' | 'm' | 'xl';

const VARIANT_OPTIONS: Record<Variant, WaSeedOptions> = {
    // Tuned so the sum across the 8 tables lands near the targeted total.
    // The seeder is deterministic — same opts always produce the same file.
    xs: { products: 1_500, customers: 8_000, orders: 35_000 },
    m: { products: 4_000, customers: 25_000, orders: 110_000 },
    xl: { products: 10_000, customers: 80_000, orders: 380_000 },
};

function parseArgs(): { variant: Variant; out: string } {
    const args = process.argv.slice(2);
    let variant: Variant | undefined;
    let out: string | undefined;
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--variant') variant = args[++i] as Variant;
        else if (a === '--out') out = args[++i];
        else throw new Error(`Unknown arg: ${a}`);
    }
    if (!variant || !(variant in VARIANT_OPTIONS)) {
        throw new Error(`--variant must be one of: ${Object.keys(VARIANT_OPTIONS).join(', ')}`);
    }
    if (!out) throw new Error('--out <path> is required');
    return { variant, out };
}

async function main(): Promise<void> {
    const { variant, out } = parseArgs();
    const opts = VARIANT_OPTIONS[variant];

    const db = new WaSqliteDb();
    await db.init();

    const t0 = Date.now();
    const summary = await db.seed({ ...opts, force: true });
    const seedMs = Date.now() - t0;

    const bytes = await db.serialize();
    await db.close();

    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, bytes);

    const totalRows = Object.values(summary.tables).reduce((a, b) => a + b, 0);
    const mb = (bytes.byteLength / (1024 * 1024)).toFixed(1);
    console.log(
        `[retail-${variant}] seeded in ${seedMs} ms, ` +
        `wrote ${mb} MB to ${out} ` +
        `(${totalRows.toLocaleString()} rows across ${Object.keys(summary.tables).length} tables)`,
    );
    for (const [t, n] of Object.entries(summary.tables)) {
        console.log(`  ${t.padEnd(14)} ${n.toLocaleString()}`);
    }
}

await main();
