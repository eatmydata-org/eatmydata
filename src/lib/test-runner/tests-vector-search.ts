/**
 * Browser-testbed coverage for the END-TO-END semantic search path:
 *
 *   vector_search('product','name','<phrase>', k)
 *     -> C vtab resolves _rhvec_search_map -> the embedding sidecar
 *     -> C calls analyst_embed_query (now defined IN wa-sqlite.wasm,
 *        runtime_shim.c) -> sem_embed in the same module/memory
 *     -> quantized scan + exact rerank -> (rowid, distance)
 *
 * vitest/Node can't reach this — it needs the BGE GGUF loaded into the
 * wa-sqlite module inside the DedicatedWorker (Node never warms it, so the C
 * path returns "not warmed" there). The query embed is now a pure in-module C
 * call — no JS hook — so this is what validates that wire end to end.
 *
 * The dataset is built main-thread-side: PASSAGES are embedded via the
 * standalone bge-embed engine (raw, no prefix) and stored in the sidecar; the
 * QUERY is embedded by the worker's in-module engine (with the BGE retrieval
 * prefix the C wrapper adds) when the vtab runs. Same C sources + same GGUF on
 * both sides → cosine comparable. We check that a meaning-based query out-ranks
 * a literal-substring competitor.
 *
 * Soft-skips when the embed assets aren't built (`make semantic embed-model`).
 */

import * as Comlink from 'comlink';
import type { TestDef } from './runner';
import type { WaSqliteFactory } from '@/lib/wa-sqlite/test-worker';
import { warmupBgeEmbed, embedTextsSync } from '@/lib/bge-embed/runtime';

const DIM = 384;

// Names chosen so the dog-relevant rows share NO literal token with the query
// "dogs" — a substring LIKE '%dog%' would miss them; semantic search shouldn't.
const PRODUCTS = [
    'Puppy chow kibble', // dog-relevant, no "dog" substring
    'Canine grooming shampoo', // dog-relevant, no "dog" substring
    'Stainless steel water bottle',
    'Wireless mechanical keyboard',
    'Organic green tea leaves',
];
const DOG_RELEVANT = new Set([0, 1]);

let cachedFactory: Comlink.Remote<WaSqliteFactory> | null = null;
let cachedWorker: Worker | null = null;

function getFactory(): Comlink.Remote<WaSqliteFactory> {
    if (cachedFactory) return cachedFactory;
    const worker = new Worker(new URL('@/lib/wa-sqlite/test-worker.ts', import.meta.url), {
        type: 'module',
        name: 'wa-sqlite-vector-search-test',
    });
    cachedWorker = worker;
    cachedFactory = Comlink.wrap<WaSqliteFactory>(worker);
    return cachedFactory;
}

if (import.meta.hot) {
    import.meta.hot.dispose(() => {
        cachedWorker?.terminate();
        cachedWorker = null;
        cachedFactory = null;
    });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run `SQL` retrying while the vtab reports the embedding model is still
 * warming up, until `deadline` (ms epoch). Any other error rethrows.
 */
async function runWithWarmupRetry(
    db: { execRaw: (sql: string) => Promise<{ rows: Array<Record<string, unknown>> }> },
    sql: string,
    deadline: number,
    log: (msg: string) => void,
): Promise<Array<Record<string, unknown>>> {
    for (;;) {
        try {
            return (await db.execRaw(sql)).rows;
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (/not warmed up|embedding/i.test(msg) && Date.now() < deadline) {
                log('embedding model warming up; retrying…');
                await sleep(1000);
                continue;
            }
            throw e;
        }
    }
}

export const VECTOR_SEARCH_TESTS: TestDef[] = [
    {
        id: 'vector-search-end-to-end',
        name: 'vector_search() embeds the query in-worker and ranks by meaning (beats LIKE)',
        // First run fetches bge-embed.wasm + GGUF (then browser-cached) and
        // warms the in-thread bge-embed engine lazily on the first query.
        timeoutMs: 180_000,
        fn: async (ctx) => {
            try {
                await warmupBgeEmbed();
            } catch (e) {
                ctx.log(
                    `bge-embed assets not built (run \`make semantic embed-model\`); skipping — ${
                        e instanceof Error ? e.message : String(e)
                    }`,
                );
                return;
            }

            const db = await getFactory().createDb();
            await db.init();

            // Base table + its embedding sidecar (what semantic-index.ts builds).
            await db.execRaw('CREATE TABLE product(id INTEGER PRIMARY KEY, name TEXT)');
            await db.execRaw(
                'CREATE TABLE _rhvec_emb_product_name(rowid INTEGER PRIMARY KEY, vec BLOB)',
            );
            for (let i = 0; i < PRODUCTS.length; i++) {
                await db.execRaw(
                    `INSERT INTO product(id, name) VALUES (${i + 1}, '${PRODUCTS[i]!.replace(/'/g, "''")}')`,
                );
            }

            // Passages embedded RAW via bge-embed (no query prefix).
            const vecs = embedTextsSync(PRODUCTS);
            ctx.expect.equal(vecs[0]?.length, DIM, `passage embedding dim is ${DIM}`);
            for (let i = 0; i < vecs.length; i++) {
                await db.execRaw(
                    `INSERT INTO _rhvec_emb_product_name(rowid, vec) VALUES (${i + 1},` +
                        ` vector_as_f32('${JSON.stringify(vecs[i])}'))`,
                );
            }

            await db.execRaw(
                `SELECT vector_init('_rhvec_emb_product_name','vec','dimension=${DIM}, distance=cosine')`,
            );
            await db.execRaw(
                `SELECT vector_quantize('_rhvec_emb_product_name','vec','qtype=turbo,qbits=4')`,
            );
            await db.execRaw(
                'CREATE TABLE _rhvec_search_map(base_tbl TEXT, base_col TEXT, store_tbl TEXT,' +
                    ' store_col TEXT, model TEXT, dim INTEGER, metric TEXT,' +
                    ' PRIMARY KEY(base_tbl, base_col))',
            );
            await db.execRaw(
                `INSERT INTO _rhvec_search_map VALUES('product','name',` +
                    `'_rhvec_emb_product_name','vec','bge-small-en-v1.5',${DIM},'cosine')`,
            );

            // Warm the worker's in-module BGE model so the C vtab can embed the
            // query. Production triggers this automatically (opening an indexed
            // DB / indexing); here the sidecar is hand-built, so warm explicitly.
            // The retry loop below still covers the brief async-warm window.
            await getFactory().warmSemanticSearch();

            // The worker embeds the query in-module on first use; until the
            // model warms, the vtab raises "not warmed up". Retry until ready.
            const SQL =
                'SELECT p.id AS id, p.name AS name, v.distance AS distance' +
                " FROM vector_search('product','name','dogs', 5) v" +
                ' JOIN product p ON p.rowid = v.rowid ORDER BY v.distance';
            const deadline = Date.now() + 150_000;
            const rows = await runWithWarmupRetry(db, SQL, deadline, ctx.log);

            ctx.expect.truthy(rows.length > 0, 'vector_search returned rows');
            const ranked = rows.map((r) => String(r.name));
            ctx.log(`ranking for "dogs": ${ranked.join(' | ')}`);

            // The top-2 should be the dog-relevant products, even though neither
            // contains the substring "dog" — which a LIKE '%dog%' would require.
            const topTwo = rows.slice(0, 2).map((r) => Number(r.id) - 1);
            for (const idx of topTwo) {
                ctx.expect.truthy(
                    DOG_RELEVANT.has(idx),
                    `top match "${PRODUCTS[idx]}" is dog-relevant (semantic, not substring)`,
                );
            }
            ctx.expect.truthy(
                topTwo.every((idx) => !/dog/i.test(PRODUCTS[idx]!)),
                'top matches contain no literal "dog" token — LIKE would have missed them',
            );

            await db.close();
        },
    },
];
