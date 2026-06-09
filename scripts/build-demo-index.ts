#!/usr/bin/env -S node --experimental-strip-types --no-warnings
/**
 * Prebuild semantic-search indexes into an existing demo `.sqlite` file.
 *
 *   node --experimental-strip-types scripts/build-demo-index.ts src/assets/demo/contoso.sqlite
 *
 * The bash-built demos (northwind, adventureworks, contoso) are produced by the
 * system `sqlite3` binary, which has NO vector extension — so they ship without
 * the `_rhvec_*` artifacts. This post-processes such a file IN PLACE: load it
 * into `WaSqliteDb` (whose `wa-sqlite.wasm` carries the in-tree vector
 * extension), prebuild the same indexes the browser would build online, and
 * write the augmented bytes back.
 *
 * Best-effort: if `make transformers` hasn't built the BGE model, prints a
 * warning and leaves the file untouched (the browser will index it on demand).
 * Idempotent — buildColumnIndex drops + rebuilds each column.
 *
 * Memory strategy
 * ───────────────
 * wa-sqlite runs as a WASM in-memory database (no Node.js filesystem VFS).
 * The WASM module is capped at 2 GB (--max-memory in CMakeLists).
 *
 * Naïve approach (malloc → index → free → malloc again) fails on the second
 * column: dlmalloc in WASM doesn't reuse a freed ~2 GB block — it tries
 * memory.grow again, hitting the max-memory ceiling.
 *
 * Fix: allocate ONE buffer (WASM_MAX − overhead) before the loop and reload
 * each column's starting state in place via loadFileInBuffer() (no
 * FREEONCLOSE, same pointer every iteration). SQLite detaches the previous
 * database without touching the buffer, then loads new bytes in place.
 * One malloc, one free, N columns.
 */
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { WaSqliteDb } from '../src/lib/wa-sqlite/db.ts';
import { buildColumnIndex } from '../src/lib/data-sources/semantic-index-core.ts';
import { createNodeEmbedder, findAllCandidates } from './lib/semantic-index-node.ts';
import type { Embedder } from '../src/lib/data-sources/semantic-index-core.ts';

function parseArgs(): { file: string } {
    const args = process.argv.slice(2);
    const file = args.find((a) => !a.startsWith('--'));
    if (!file) throw new Error('Usage: build-demo-index.ts <path-to.sqlite>');
    return { file };
}

/**
 * wa-sqlite WASM max-memory — must match --max-memory in the wa-sqlite
 * CMakeLists target. We allocate (WASM_MAX - OVERHEAD) as the single
 * reusable sqlite buffer.
 */
const WASM_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const WASM_OVERHEAD_BYTES = 128 * 1024 * 1024; // code + stack + runtime
const BUFFER_SIZE = WASM_MAX_BYTES - WASM_OVERHEAD_BYTES; // ~1920 MB

/**
 * Index one column in place and write the augmented DB back to `file`.
 * Returns the `table.col` label on success, or `null` if the column was
 * skipped (grown file) or its build failed (logged, non-fatal).
 *
 * Each call: reload the latest on-disk state into the buffer in-place (no
 * malloc/free — same bufPtr), index one column, serialize (NOCOPY: returns a
 * pointer into the existing buffer, no second large allocation), then write the
 * live pages to disk.
 */
async function indexOneColumn(
    db: WaSqliteDb,
    file: string,
    bufPtr: number,
    table: string,
    col: string,
    embed: Embedder,
): Promise<string | null> {
    const currentBytes = readFileSync(file);
    if (currentBytes.byteLength > BUFFER_SIZE) {
        console.warn(
            `  SKIPPED ${table}.${col}: grown file ` +
                `(${(currentBytes.byteLength / 1024 / 1024).toFixed(0)} MB) exceeds buffer`,
        );
        return null;
    }

    // Replace the in-memory database in-place: no malloc, no free.
    await db.loadFileInBuffer(currentBytes, bufPtr, BUFFER_SIZE);

    let n: number;
    try {
        const t0 = Date.now();
        n = await buildColumnIndex(db, table, col, embed);
        const ms = Date.now() - t0;
        const rate = ms > 0 ? Math.round((n / ms) * 1000) : n;
        console.log(
            `  indexed ${table}.${col} — ${n.toLocaleString()} rows in ${ms} ms (${rate.toLocaleString()}/s)`,
        );
    } catch (e) {
        console.log(`  FAILED ${table}.${col}: ${e instanceof Error ? e.message : String(e)}`);
        return null;
    }

    const out = await db.serialize();
    writeFileSync(file, out);
    return `${table}.${col}`;
}

async function main(): Promise<void> {
    const { file } = parseArgs();
    const tag = basename(file).replace(/\.sqlite$/, '');
    const sizeBefore = statSync(file).size;

    if (sizeBefore > BUFFER_SIZE) {
        throw new Error(
            `[${tag}] source file (${(sizeBefore / 1024 / 1024).toFixed(0)} MB) ` +
                `exceeds BUFFER_SIZE (${(BUFFER_SIZE / 1024 / 1024).toFixed(0)} MB)`,
        );
    }

    // Init db and allocate the single reusable WASM buffer.
    const db = new WaSqliteDb();
    await db.init();

    const bufPtr = db.allocateWasmBuffer(BUFFER_SIZE);
    if (bufPtr === 0) {
        await db.close();
        throw new Error(
            `[${tag}] failed to allocate ${(BUFFER_SIZE / 1024 / 1024).toFixed(0)} MB WASM buffer`,
        );
    }

    // Discovery pass: load the initial file, find all candidates (read-only
    // COUNT DISTINCT queries — no writes, no headroom needed beyond the file).
    await db.loadFileInBuffer(readFileSync(file), bufPtr, BUFFER_SIZE);
    const candidates = await findAllCandidates(db);

    if (candidates.length === 0) {
        console.log(`[${tag}] no high-cardinality free-text columns to index; left unchanged`);
        await db.close();
        return;
    }

    const embedder = await createNodeEmbedder().catch((e: unknown) => {
        console.warn(
            `[${tag}] skipping semantic index: ${e instanceof Error ? e.message : String(e)}`,
        );
        return null;
    });
    if (!embedder) {
        await db.close();
        return;
    }

    const indexed: string[] = [];
    const ti = Date.now();

    for (const { table, col } of candidates) {
        const label = await indexOneColumn(db, file, bufPtr, table, col, embedder.embed);
        if (label) indexed.push(label);
    }

    // Free the buffer before closing so the allocator gets it back cleanly.
    // sqlite3_close will not touch the buffer (no FREEONCLOSE was used).
    db.freeWasmBuffer(bufPtr);
    await db.close();

    const { modelId } = embedder;
    embedder.dispose();

    console.log(`  model: ${modelId} → ${indexed.length} column(s) indexed`);
    console.log(`[${tag}] semantic-indexed ${indexed.length} column(s) in ${Date.now() - ti} ms`);

    if (indexed.length > 0) {
        const sizeAfter = statSync(file).size;
        const mb = (n: number): string => (n / (1024 * 1024)).toFixed(1);
        console.log(`[${tag}] wrote ${mb(sizeAfter)} MB (was ${mb(sizeBefore)} MB) to ${file}`);
    }
}

await main();
