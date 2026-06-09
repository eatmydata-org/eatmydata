/**
 * Browser-testbed coverage for the wa-sqlite + OPFSCoopSyncVFS engine —
 * scenarios that vitest's Node environment can't reach because they need
 * real OPFS. Companion to `src/lib/wa-sqlite/db.test.ts`, which covers the
 * `:memory:` paths in vitest.
 *
 * The wa-sqlite engine must run inside a DedicatedWorker
 * (`createSyncAccessHandle` is exposed there only). A single
 * `WaSqliteFactory` worker is reused across all tests in this group; each
 * test gets a fresh `WaSqliteDb` via `factory.createDb()` and writes to a
 * uniquely-named OPFS file that is removed at teardown so re-runs are
 * independent.
 */

import * as Comlink from 'comlink';
import type { TestDef } from './runner';
import type { WaSqliteFactory } from '@/lib/wa-sqlite/test-worker';
import type { WaSqliteDb } from '@/lib/wa-sqlite/db';
import { isUnreadableDbError } from '@/lib/wa-sqlite/validate';
import { randomToken } from '@/lib/random';

/**
 * Lazily-constructed shared factory. Built on first test that needs it;
 * survives until page reload. Tests pay the wa-sqlite WASM boot cost once.
 */
let cachedFactory: Comlink.Remote<WaSqliteFactory> | null = null;
let cachedWorker: Worker | null = null;

function getFactory(): Comlink.Remote<WaSqliteFactory> {
    if (cachedFactory) return cachedFactory;
    const worker = new Worker(new URL('@/lib/wa-sqlite/test-worker.ts', import.meta.url), {
        type: 'module',
        name: 'wa-sqlite-test-factory',
    });
    cachedWorker = worker;
    cachedFactory = Comlink.wrap<WaSqliteFactory>(worker);
    return cachedFactory;
}

/**
 * A second, independent factory worker — a stand-in for a *second tab*. Its
 * wa-sqlite instance opens the same OPFS files through its own VFS, so the
 * multi-tab tests below exercise real cross-instance contention on a single
 * file (the only way to reproduce the "locked"/handoff bugs in one page).
 */
let cachedFactory2: Comlink.Remote<WaSqliteFactory> | null = null;
let cachedWorker2: Worker | null = null;

function getSecondFactory(): Comlink.Remote<WaSqliteFactory> {
    if (cachedFactory2) return cachedFactory2;
    const worker = new Worker(new URL('@/lib/wa-sqlite/test-worker.ts', import.meta.url), {
        type: 'module',
        name: 'wa-sqlite-test-factory-2',
    });
    cachedWorker2 = worker;
    cachedFactory2 = Comlink.wrap<WaSqliteFactory>(worker);
    return cachedFactory2;
}

// HMR teardown — Vite reloads this module on edit; without this, the
// previous workers leak across reloads.
if (import.meta.hot) {
    import.meta.hot.dispose(() => {
        cachedWorker?.terminate();
        cachedWorker = null;
        cachedFactory = null;
        cachedWorker2?.terminate();
        cachedWorker2 = null;
        cachedFactory2 = null;
    });
}

/**
 * Build a tiny `.sqlite` blob inside the wa-sqlite worker (a `:memory:`
 * connection populated via SQL, then `serialize()`-d). Used by the
 * loadFile test to feed bytes through deserialize and verify the
 * round-trip.
 */
async function makeSampleFile(): Promise<Uint8Array> {
    const factory = getFactory();
    const db = await factory.createDb();
    try {
        await db.init();
        // `execRaw` enforces single-statement; split CREATE and INSERT.
        await db.execRaw(
            'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT)',
        );
        await db.execRaw(
            'INSERT INTO users(name, email) VALUES ' +
                "('ada', 'ada@example.com'), " +
                "('alan', 'alan@example.com'), " +
                "('grace', 'grace@example.com')",
        );
        return await db.serialize();
    } finally {
        await db.close();
    }
}

async function safeRemoveOpfsFile(filename: string): Promise<void> {
    try {
        const root = await navigator.storage.getDirectory();
        await root.removeEntry(filename, { recursive: false });
    } catch {
        // ignore — file may not exist, or the VFS may have already cleaned
        // it up (journal in DELETE mode is removed on commit).
    }
}

function uniqueFilename(prefix: string): string {
    return `${prefix}-${randomToken(4)}.sqlite`;
}

/** Evaluate a scalar SQL expression and return the single cell. */
async function scalarValue(db: Comlink.Remote<WaSqliteDb>, expr: string): Promise<unknown> {
    const r = await db.execRaw(`SELECT ${expr} AS v`);
    return (r.rows[0] as { v: unknown }).v;
}

export const WA_SQLITE_TESTS: TestDef[] = [
    {
        id: 'wa-sqlite-open-write-reopen',
        name: 'wa-sqlite: data persists across close + reopen on OPFS',
        async fn(ctx) {
            const filename = uniqueFilename('test-open-reopen');
            const factory = getFactory();
            ctx.log(`opening ${filename}`);
            let db: Comlink.Remote<WaSqliteDb> | null = null;
            try {
                db = await factory.createDb();
                await db.init({ filename });
                await db.execRaw('CREATE TABLE t (id INTEGER PRIMARY KEY, label TEXT)');
                for (const label of ['alpha', 'beta', 'gamma']) {
                    await db.execRaw(`INSERT INTO t (label) VALUES ('${label}')`);
                }
                await db.close();
                ctx.log('first connection closed');

                // Fresh handle, same file — reads what was just written.
                db = await factory.createDb();
                await db.init({ filename });
                const result = await db.execQuery('SELECT id, label FROM t ORDER BY id');
                ctx.log(`reopen yielded ${result.rows.length} rows`);
                ctx.expect.equal(result.rows.length, 3, 'should see 3 rows after reopen');
                ctx.expect.equal(
                    (result.rows[0] as { label: string }).label,
                    'alpha',
                    'first row label',
                );
                await db.close();
            } finally {
                await safeRemoveOpfsFile(filename);
            }
        },
        timeoutMs: 30_000,
    },

    {
        id: 'wa-sqlite-load-file-memory',
        name: 'wa-sqlite: loadFile() into a :memory: DB inside the worker',
        async fn(ctx) {
            // loadFile() uses sqlite3_deserialize, which requires an empty
            // schema on the target. OPFS-backed connections already have
            // their `main` schema bound to the file, so deserialize returns
            // SQLITE_BUSY — the only sensible target is a fresh
            // `:memory:`. This test confirms the manual cwrap binding
            // works end-to-end inside a DedicatedWorker.
            const factory = getFactory();
            const sample = await makeSampleFile();
            ctx.log(`sample blob: ${sample.byteLength} bytes`);
            const db = await factory.createDb();
            await db.init(); // default :memory:
            // Transfer the bytes so we don't pay a structured-clone copy.
            await db.loadFile(Comlink.transfer(sample, [sample.buffer]));
            const schema = await db.getSchema();
            const users = schema.find((t) => t.name === 'users');
            ctx.expect.truthy(users, 'users table should exist');
            ctx.expect.equal(users!.columns.length, 3, 'users has 3 columns');
            const rows = await db.execQuery('SELECT name FROM users ORDER BY id');
            ctx.expect.equal(rows.rows.length, 3, 'three sample rows');
            await db.close();
        },
        timeoutMs: 30_000,
    },

    {
        id: 'wa-sqlite-seed-opfs',
        name: 'wa-sqlite: seed retail dataset into an OPFS-backed DB',
        async fn(ctx) {
            const filename = uniqueFilename('test-seed');
            const factory = getFactory();
            try {
                const db = await factory.createDb();
                await db.init({ filename });
                const result = await db.seed();
                ctx.log(`seeded=${result.seeded}, elapsedMs=${result.elapsedMs}`);
                ctx.log(`tables: ${JSON.stringify(result.tables)}`);
                ctx.expect.truthy(result.seeded, 'seed should report seeded=true');
                const total = Object.values(result.tables).reduce((a, b) => a + b, 0);
                ctx.expect.truthy(total > 50_000, `expected >50k rows, got ${total}`);
                const schema = await db.getSchema();
                const sales = schema.find((t) => t.name === 'sales');
                ctx.expect.truthy(sales?.type === 'view', 'sales view should exist');

                const again = await db.seed();
                ctx.expect.truthy(!again.seeded, 'second seed without force should no-op');
                ctx.expect.equal(
                    again.tables.products,
                    result.tables.products,
                    'product count unchanged',
                );
                await db.close();
            } finally {
                await safeRemoveOpfsFile(filename);
            }
        },
        timeoutMs: 120_000,
    },

    {
        id: 'wa-sqlite-validate-query',
        name: 'wa-sqlite: validateQuery accepts read-only, rejects writes + bad SQL',
        async fn(ctx) {
            const filename = uniqueFilename('test-validate');
            const factory = getFactory();
            try {
                const db = await factory.createDb();
                await db.init({ filename });
                await db.execRaw('CREATE TABLE t (id INTEGER PRIMARY KEY, label TEXT)');
                const ok = await db.validateQuery('SELECT id FROM t');
                ctx.expect.truthy(ok.ok, 'read-only SELECT should validate');
                const write = await db.validateQuery("INSERT INTO t (label) VALUES ('x')");
                ctx.expect.truthy(
                    !write.ok && /read-only/i.test(write.error ?? ''),
                    `INSERT should be refused; got ${JSON.stringify(write)}`,
                );
                const syntax = await db.validateQuery('SELEC * FROM t');
                ctx.expect.truthy(
                    !syntax.ok && /syntax/i.test(syntax.error ?? ''),
                    `bad SQL should produce syntax error; got ${JSON.stringify(syntax)}`,
                );
                const multi = await db.validateQuery('SELECT 1; SELECT 2');
                ctx.expect.truthy(
                    !multi.ok && /multiple/i.test(multi.error ?? ''),
                    `multi-stmt should be refused; got ${JSON.stringify(multi)}`,
                );
                await db.close();
            } finally {
                await safeRemoveOpfsFile(filename);
            }
        },
        timeoutMs: 30_000,
    },

    {
        id: 'wa-sqlite-import-while-open',
        name: 'wa-sqlite: importIntoOpfs while a peer "tab" holds the file (no "locked")',
        async fn(ctx) {
            const filename = uniqueFilename('test-import-open');
            const name = filename;
            const factoryA = getFactory(); // "tab A" runs the import
            const factoryB = getSecondFactory(); // "tab B" holds the file open
            const accessorA = await factoryA.createAccessor();
            let dbB: Comlink.Remote<WaSqliteDb> | null = null;
            try {
                // Tab B opens the file and writes — acquiring and (lazily)
                // holding the VFS's exclusive access handle for this leaf.
                dbB = await factoryB.createDb();
                await dbB.init({ filename });
                await dbB.execRaw('CREATE TABLE old_marker (x INTEGER)');
                await dbB.execRaw('INSERT INTO old_marker (x) VALUES (1)');
                await dbB.execQuery('SELECT x FROM old_marker');
                ctx.log('tab B holds the OPFS handle');

                // A different-schema blob (a `users` table) to write over it.
                const sample = await makeSampleFile();
                const buf = sample.buffer.slice(
                    sample.byteOffset,
                    sample.byteOffset + sample.byteLength,
                ) as ArrayBuffer;
                ctx.log(`tab A importing ${buf.byteLength} bytes`);

                // Pre-fix: throws NoModificationAllowedError (tab B's exclusive
                // handle). Post-fix: withVfsFileLock nudges tab B to yield.
                let threw: unknown = null;
                try {
                    await accessorA.importIntoOpfs(name, filename, Comlink.transfer(buf, [buf]));
                } catch (e) {
                    threw = e;
                }
                ctx.expect.truthy(
                    threw === null,
                    `import should not throw; got ${threw instanceof Error ? threw.message : String(threw)}`,
                );

                const importedDb = await accessorA.get(name, { filename });
                const schema = await importedDb.getSchema();
                ctx.expect.truthy(
                    schema.some((t) => t.name === 'users'),
                    `imported DB should expose the new 'users' table; got [${schema
                        .map((t) => t.name)
                        .join(', ')}]`,
                );
                ctx.expect.truthy(
                    !schema.some((t) => t.name === 'old_marker'),
                    'old schema should be gone after import',
                );
                await accessorA.close(name);
            } finally {
                if (dbB) {
                    try {
                        await dbB.close();
                    } catch (e) {
                        ctx.log(`tab B close after import: ${e}`);
                    }
                }
                await safeRemoveOpfsFile(filename);
            }
        },
        timeoutMs: 30_000,
    },

    {
        id: 'wa-sqlite-delete-while-open',
        name: 'wa-sqlite: destroyOpfs while a peer "tab" holds the file (no "locked")',
        async fn(ctx) {
            const filename = uniqueFilename('test-delete-open');
            const factoryA = getFactory();
            const factoryB = getSecondFactory();
            const accessorA = await factoryA.createAccessor();
            let dbB: Comlink.Remote<WaSqliteDb> | null = null;
            try {
                dbB = await factoryB.createDb();
                await dbB.init({ filename });
                await dbB.execRaw('CREATE TABLE t (id INTEGER)');
                await dbB.execQuery('SELECT id FROM t');
                ctx.log('tab B holds the OPFS handle');

                let threw: unknown = null;
                try {
                    await accessorA.destroyOpfs(filename, filename);
                } catch (e) {
                    threw = e;
                }
                ctx.expect.truthy(
                    threw === null,
                    `destroyOpfs should not throw; got ${threw instanceof Error ? threw.message : String(threw)}`,
                );

                let stillThere = true;
                try {
                    const root = await navigator.storage.getDirectory();
                    await root.getFileHandle(filename, { create: false });
                } catch (e) {
                    if ((e as Error).name === 'NotFoundError') stillThere = false;
                }
                ctx.expect.truthy(!stillThere, 'OPFS file should be unlinked after destroyOpfs');
            } finally {
                if (dbB) {
                    try {
                        await dbB.close();
                    } catch (e) {
                        ctx.log(`tab B close after delete: ${e}`);
                    }
                }
                await safeRemoveOpfsFile(filename);
            }
        },
        timeoutMs: 30_000,
    },

    {
        id: 'wa-sqlite-corrupt-file-isolated',
        name: 'wa-sqlite: a corrupt/non-database file throws a classified error and does NOT break sibling DBs',
        async fn(ctx) {
            // Reproduces the "one bad demo wedged the whole app" bug: a missing
            // `/demo/<spec>.sqlite` came back as an HTML SPA-fallback page,
            // got written to OPFS, and every getSchema after threw a raw
            // "file is not a database". We now (a) classify it into a
            // recognisable DataSourceUnreadableError, and (b) keep the failure
            // local — other sources on the same worker keep working.
            const badFile = uniqueFilename('test-corrupt');
            const goodFile = uniqueFilename('test-good-sibling');
            const factory = getFactory();
            const accessor = await factory.createAccessor();
            try {
                // Write a non-database (an HTML error page) to OPFS, exactly
                // like the failed demo download did.
                const html =
                    '<!DOCTYPE html><html><head><title>Not Found</title></head>' +
                    '<body>404</body></html>';
                const garbage = new TextEncoder().encode(html);
                const garbageBuf = garbage.buffer.slice(
                    garbage.byteOffset,
                    garbage.byteOffset + garbage.byteLength,
                ) as ArrayBuffer;
                const badDb = await accessor.importIntoOpfs(
                    badFile,
                    badFile,
                    Comlink.transfer(garbageBuf, [garbageBuf]),
                );

                // getSchema must throw, and the error must be classified.
                let schemaErr: unknown = null;
                try {
                    await badDb.getSchema();
                } catch (e) {
                    schemaErr = e;
                }
                ctx.expect.truthy(schemaErr !== null, 'getSchema on a non-database must throw');
                ctx.expect.equal(
                    (schemaErr as { name?: string })?.name,
                    'DataSourceUnreadableError',
                    `error must classify as unreadable; got ${
                        schemaErr instanceof Error ? schemaErr.message : String(schemaErr)
                    }`,
                );
                ctx.expect.truthy(
                    isUnreadableDbError(schemaErr),
                    'isUnreadableDbError should recognise it across the worker boundary',
                );

                // assertReadable must throw the same way.
                let probeErr: unknown = null;
                try {
                    await badDb.assertReadable();
                } catch (e) {
                    probeErr = e;
                }
                ctx.expect.truthy(
                    isUnreadableDbError(probeErr),
                    'assertReadable on a non-database must throw a classified error',
                );

                // Isolation: a healthy DB opened on the SAME worker after the
                // bad one must still work end-to-end.
                const sample = await makeSampleFile();
                const goodBuf = sample.buffer.slice(
                    sample.byteOffset,
                    sample.byteOffset + sample.byteLength,
                ) as ArrayBuffer;
                const goodDb = await accessor.importIntoOpfs(
                    goodFile,
                    goodFile,
                    Comlink.transfer(goodBuf, [goodBuf]),
                );
                const schema = await goodDb.getSchema();
                ctx.expect.truthy(
                    schema.some((t) => t.name === 'users'),
                    `sibling DB should open fine after the corrupt one; got [${schema
                        .map((t) => t.name)
                        .join(', ')}]`,
                );
                await accessor.close(badFile);
                await accessor.close(goodFile);
            } finally {
                await safeRemoveOpfsFile(badFile);
                await safeRemoveOpfsFile(goodFile);
            }
        },
        timeoutMs: 30_000,
    },

    {
        id: 'wa-sqlite-vector-search',
        name: 'wa-sqlite: vector extension (full_scan + TurboQuant quantize_scan)',
        async fn(ctx) {
            // Confirms the rh vector extension works in the real browser build
            // (auto-registered via sqlite3_auto_extension) against an
            // OPFS-backed connection — vitest only exercises :memory:.
            const filename = uniqueFilename('test-vector');
            const factory = getFactory();
            const DIM = 8;
            const N = 30;
            // Deterministic vectors; no Math.random in the testbed.
            const vec = (seed: number): number[] => {
                const out: number[] = [];
                let s = (seed * 2654435761) >>> 0;
                for (let i = 0; i < DIM; i++) {
                    s = (1103515245 * s + 12345) >>> 0;
                    out.push((s / 0xffffffff) * 2 - 1);
                }
                return out;
            };
            let db: Comlink.Remote<WaSqliteDb> | null = null;
            try {
                db = await factory.createDb();
                await db.init({ filename });
                ctx.expect.equal(
                    await scalarValue(db, 'vector_version()'),
                    '0.1.0',
                    'extension registered',
                );
                await db.execRaw('CREATE TABLE docs (id INTEGER PRIMARY KEY, emb BLOB)');
                for (let i = 0; i < N; i++) {
                    await db.execRaw(
                        `INSERT INTO docs(id, emb) VALUES (${i + 1},` +
                            ` vector_as_f32('${JSON.stringify(vec(i + 1))}'))`,
                    );
                }
                await db.execRaw(
                    `SELECT vector_init('docs','emb','dimension=${DIM}, distance=cosine')`,
                );

                // Exact scan: querying a stored vector returns it at ~0 distance.
                const q = JSON.stringify(vec(7));
                const exact = await db.execQuery(
                    `SELECT rowid AS rid, distance FROM vector_full_scan('docs','emb',` +
                        ` vector_as_f32('${q}'), 1)`,
                );
                ctx.expect.equal(
                    Number((exact.rows[0] as { rid: number }).rid),
                    7,
                    'nearest is row 7',
                );
                ctx.expect.truthy(
                    Math.abs(Number((exact.rows[0] as { distance: number }).distance)) < 1e-4,
                    'exact-match distance ~ 0',
                );

                // TurboQuant: quantize, then approximate scan returns k rows.
                const nq = await scalarValue(
                    db,
                    `vector_quantize('docs','emb','qtype=turbo,qbits=4')`,
                );
                ctx.expect.equal(Number(nq), N, 'quantized all rows');
                const approx = await db.execQuery(
                    `SELECT rowid AS rid FROM vector_quantize_scan('docs','emb',` +
                        ` vector_as_f32('${q}'), 5) ORDER BY distance`,
                );
                ctx.expect.equal(approx.rows.length, 5, 'quantize_scan returns k=5 rows');
                ctx.expect.truthy(
                    approx.rows.some((r) => Number((r as { rid: number }).rid) === 7),
                    'quantize_scan recovers the exact match among the top 5',
                );
                await db.close();
            } finally {
                await safeRemoveOpfsFile(filename);
            }
        },
        timeoutMs: 30_000,
    },
];
