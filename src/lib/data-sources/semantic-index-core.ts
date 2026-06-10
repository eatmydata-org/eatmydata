/**
 * Semantic-index CORE — the engine-only half of the index builder, with NO
 * browser-only imports (no SharedWorker transformers client, no Solid status
 * store, no settings/`@app-config`). It loads under plain Node, keeping the
 * embedder/dim/model choice (`SEMANTIC_EMBEDDER`) and the storage contract in one
 * dependency-light leaf. Indexes are built at import/seed time in the browser —
 * NOT prebuilt into the shipped demo files.
 *
 * The browser orchestration (SharedWorker embedder, status reporting, retries,
 * settings gate) lives in `./semantic-index.ts`, which re-exports these.
 *
 * Storage contract (see wasm/sqlite-vector + CLAUDE.md):
 *   - vectors live in a per-column SIDECAR table `_rhvec_emb_<hash>(rowid, vec)`
 *     whose rowid mirrors the base-table rowid — NOT a column on the base table
 *     (SQLite has no hidden columns; an in-table BLOB would leak into SELECT *).
 *   - the sidecar is `vector_init`-ed + `vector_quantize`-d so the quantized
 *     scan + exact rerank work.
 *   - a `_rhvec_search_map(base_tbl, base_col -> store_tbl, store_col, …)` row
 *     lets the vtab resolve the user-facing column to its sidecar.
 *
 * The embedder is INJECTED (`Embedder`) so the same code runs against the async
 * SharedWorker in the browser and a synchronous transformers.js pipeline in
 * Node. Passages are embedded RAW (no query prefix — that's query-side only),
 * so cosine search is valid across the prebuilt index and the live query path.
 */
import type { TableSchema } from '@/lib/wa-sqlite/types';
import { isLowCardinality } from './low-cardinality';

/**
 * Compile-time semantic-search embedder (full switch, no UI toggle). 'model2vec'
 * = the fast static token-table embedder (default; ~3500× faster indexing than the
 * BERT encoder, see wasm/semantic/PERF.md), 'bge' = the bge-small BERT encoder.
 * This single constant drives the GGUF the wa-sqlite sem engine loads
 * (semantic-embed.ts), the index dimensionality, and the stored model name. Both
 * query and passage embedding run through the same model, so the spaces match.
 * Flip to 'bge' to revert. Query/passage are SYMMETRIC for model2vec (no BGE
 * instruction prefix — handled in runtime_shim.c by model kind).
 */
export const SEMANTIC_EMBEDDER: 'model2vec' | 'bge' = 'model2vec';

/** GGUF filename under src/assets/models/ for the active embedder. */
export const EMBED_GGUF_FILE =
    SEMANTIC_EMBEDDER === 'model2vec' ? 'bge-m2v-d256.gguf' : 'bge-small-en-v1.5-q8_0.gguf';
/** Output dimensionality (must equal the wasm sem_dim() of the active embedder). */
export const EMBED_DIM = SEMANTIC_EMBEDDER === 'model2vec' ? 256 : 384;
export const EMBED_MODEL =
    SEMANTIC_EMBEDDER === 'model2vec' ? 'bge-base-m2v-d256' : 'bge-small-en-v1.5';

/**
 * Texts per embed() round-trip. In the browser embedding is single-thread-WASM
 * inference-bound (~16 passages/s), so a larger batch does NOT speed inference
 * — it only cuts the number of INSERTs / Comlink round-trips per column. (Node
 * is far faster, but the same batching keeps INSERT statements bounded.)
 */
export const EMBED_BATCH = 512;

/**
 * Base rows fetched per page. Kept >= EMBED_BATCH so a page can fill a batch;
 * in the browser the OPFS handle is released between pages while the
 * (handle-free) embed runs.
 */
export const PAGE_ROWS = 2048;

/**
 * The slice of the sqlite handle the index builder needs. Satisfied by a
 * `Comlink.Remote<WaSqliteDb>` (browser) AND a raw `WaSqliteDb` (Node scripts +
 * vitest), so callers pass whichever handle they already hold.
 */
export interface IndexDb {
    execRaw(sql: string, limit?: number): Promise<{ rows: Array<Record<string, unknown>> }>;
    getSchema(): Promise<TableSchema[]>;
}

/** Maps a batch of passages to their embedding vectors (one `number[]` each). */
export type Embedder = (texts: string[]) => Promise<number[][]>;

export type IndexProgress = {
    table: string;
    column: string;
    /** Rows embedded so far for the current column. */
    done: number;
    /** Total rows in the base table (upper bound; null rows are skipped). */
    total: number;
};

/**
 * Reject anything that isn't a bare sqlite identifier so it can't break out of
 * the `"…"`-quoted / `'…'`-quoted SQL the builder assembles. Kept as a local
 * copy (NOT imported from ./db) because ./db pulls the browser-only sqlite
 * client (virtual:worker-versions), which won't load under Node. Must stay in
 * sync with `assertSafeIdentifier` in ./db.ts.
 */
export function assertSafeIdentifier(name: string): void {
    if (!/^[A-Za-z_]\w*$/.test(name)) {
        throw new Error(`Unsafe sqlite identifier: ${JSON.stringify(name)}`);
    }
}

/** SQLite TEXT affinity: declared type mentioning CHAR / CLOB / TEXT. */
function isTextType(declType: string): boolean {
    const t = declType.toUpperCase();
    return t.includes('CHAR') || t.includes('CLOB') || t.includes('TEXT');
}

/**
 * Token-level words that signal a column is NOT free-text-searchable —
 * embedding it is meaningless (BGE on a UUID, an email, or a password hash is
 * noise) and wasteful. Three families:
 *   - identifiers / codes: id, uuid, guid, sku, code, ref, hash, key, token, …
 *   - contact / address fields: email, phone, fax, address, street, postal, zip
 *   - denormalized shipping/billing address snapshots on transactional tables
 *     (`ship`/`bill` prefixes: ShipName, ShipCity, BillingAddress, …) — these
 *     duplicate the canonical customer/address row and only bloat the index;
 *     a phrase search belongs against the source entity, not per-order copies.
 * Matched case-insensitively as a whole word or _-delimited segment AGAINST the
 * snake-cased column name (see {@link looksLikeIdentifierName}), so CamelCase
 * (`CustomerID`, `EmailAddress`, `ShipCity`) is caught like snake_case.
 */
// The complexity here is a long, flat keyword alternation (no nesting), matched
// only against a single sqlite column name — bounded, trusted local schema text,
// never user-supplied free input — so ReDoS is not reachable. Simplifying the
// alternation risks changing which column names are fenced from indexing, so the
// matching is kept verbatim.
const OBVIOUS_IDENTIFIER_NAME =
    // eslint-disable-next-line sonarjs/regex-complexity
    /(^|[^a-z])(id|uuid|guid|sku|code|ref|hash|url|uri|email|e_?mail|phone|tel|fax|slug|key|token|secret|password|passwd|pwd|salt|address|addr|street|isbn|ean|upc|zip|postcode|postal|ip|mac|serial|first_name|last_name|full_name|ship|shipping|bill|billing)([^a-z]|$)/i;

/**
 * Normalize a column name to lowercase snake_case, inserting `_` at CamelCase
 * boundaries so the `_`-anchored {@link OBVIOUS_IDENTIFIER_NAME} regex catches
 * `CustomerID` → `customer_id`, `EmailAddress` → `email_address`,
 * `HTTPSPort` → `https_port`. Non-alphanumerics collapse to single `_`.
 */
function toSnakeCase(name: string): string {
    return (
        name
            .replace(/([a-z0-9])([A-Z])/g, '$1_$2') // fooBar  -> foo_Bar
            // Adjacent `[A-Z]+`/`[A-Z]` can backtrack, but the input is a single
            // sqlite column name (bounded, trusted local schema text, never
            // user-supplied), so super-linear runtime is not reachable. Kept
            // verbatim to preserve the CamelCase split boundaries exactly.
            // eslint-disable-next-line sonarjs/slow-regex
            .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2') // IDNumber -> ID_Number
            .replace(/[^A-Za-z0-9]+/g, '_') // punctuation/space -> _
            .toLowerCase()
    );
}

/** True if the column name (raw OR CamelCase-normalized) reads as an identifier. */
function looksLikeIdentifierName(name: string): boolean {
    return OBVIOUS_IDENTIFIER_NAME.test(name) || OBVIOUS_IDENTIFIER_NAME.test(toSnakeCase(name));
}

/**
 * A sampled value that looks like a date / datetime: ISO `YYYY-MM-DD` with an
 * optional `T`/space time part and zone, or an `M/D/Y` slash date. SQLite has
 * no DATE affinity, so the seeder (and most CSV/XLSX imports) store dates in
 * TEXT columns (`created_at`, `order_date`, `opened_at`) — `isTextType` can't
 * fence them. Embedding an ISO timestamp is pure noise. Matched against the
 * WHOLE trimmed value.
 */
// Complexity is the optional time/zone groups of an ISO timestamp; it is matched
// only against a single trimmed sampled cell value (bounded — at most 50 sampled
// rows per column, trusted local data), so super-linear runtime is not
// reachable. Simplifying the optional groups risks changing which TEXT columns
// are fenced as date-shaped, so the pattern is kept verbatim.
const DATE_VALUE =
    // eslint-disable-next-line sonarjs/regex-complexity
    /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$|^\d{1,2}\/\d{1,2}\/\d{2,4}$/;

/** A sampled value shaped like an email address (`a0@adventure-works.com`). */ // secret-scan-allow -- doc example
// Adjacent `[^\s@]+` groups can backtrack, but the input is a single trimmed
// sampled cell value (bounded — at most 50 sampled rows per column, trusted
// local data), so super-linear runtime is not reachable.
// eslint-disable-next-line sonarjs/slow-regex
const EMAIL_VALUE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * A sampled value shaped like a phone / fax / numeric code: starts with a digit
 * (or `+`/`(`) and is otherwise only digits and phone separators — no letters.
 * Catches `030-0076545`, `(206) 555-9857`, and bare numeric postal codes that a
 * mis-named TEXT column might hold. (Letter-bearing codes like UK `EC1 4SD` are
 * caught by name instead — `postal`/`code`/`zip`.)
 */
const CONTACT_NUMBER_VALUE = /^[+(]?\d[\d\s()+.\-]{4,}$/;

/** Skip a column when at least this share of sampled values match a shape. */
const VALUE_SHAPE_FRACTION = 0.8;

/**
 * Shannon entropy in BITS PER CHARACTER of a string's character distribution.
 * Mirrors `shannonEntropy` in scripts/scan-secrets.ts (same gate the secret
 * scanner uses), so "high entropy" means the same thing in both places.
 */
function shannonEntropy(s: string): number {
    if (!s) return 0;
    const counts = new Map<string, number>();
    for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    let h = 0;
    for (const c of counts.values()) {
        const p = c / s.length;
        h -= p * Math.log2(p);
    }
    return h;
}

/** Canonical UUID / GUID — 8-4-4-4-12 hex, optional braces, optional dashes. */
const UUID_VALUE = /^\{?[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\}?$/i;

/** Single token (no whitespace) drawn only from the id / base64(url) alphabet. */
const TOKEN_ALPHABET = /^[A-Za-z0-9+/_=-]+$/;
const RANDOM_TOKEN_MIN_LEN = 16;
/**
 * Bits/char above which a long single token reads as machine-random rather than
 * natural language. Hex digests sit at ~4 (log2 16), base64 secrets ~5–6; real
 * words — even long single tokens — repeat letters enough to stay well under.
 * Aligned with the secret scanner's 3.5 gate, nudged to 3.6 to widen the margin.
 */
const RANDOM_TOKEN_MIN_ENTROPY = 3.6;

/**
 * A simple statistical test for "this value is a machine identifier, not
 * language": a UUID/GUID, or a long single token from the id/base64 alphabet
 * whose per-character Shannon entropy is near-random. Catches UUIDs, GUIDs,
 * hex digests (md5/sha), and base64/base64url secrets/hashes/salts that carry
 * no searchable meaning. The whitespace exclusion + length floor + alphabet
 * gate keep it OFF natural language (prose has spaces; non-Latin text falls
 * outside the alphabet), and the column-level {@link VALUE_SHAPE_FRACTION}
 * threshold means a stray long word never sinks an otherwise-textual column.
 */
function looksRandomToken(v: string): boolean {
    if (UUID_VALUE.test(v)) return true;
    if (/\s/.test(v) || v.length < RANDOM_TOKEN_MIN_LEN || !TOKEN_ALPHABET.test(v)) return false;
    return shannonEntropy(v) >= RANDOM_TOKEN_MIN_ENTROPY;
}

/** Column-value signals derived from one sample of up to 50 non-empty values. */
interface ValueShape {
    /** Share containing whitespace — free text is multi-word, ids are single tokens. */
    space: number;
    date: number;
    email: number;
    /** Phone / fax / bare-numeric-code share. */
    contactNumber: number;
    /** UUID/GUID/base64/hex random-token share (entropy model). */
    randomToken: number;
}

/** Sample up to 50 non-empty values of a column and derive its shape signals. */
async function sampleValueShape(db: IndexDb, table: string, col: string): Promise<ValueShape> {
    const r = await db.execRaw(
        `SELECT "${col}" AS v FROM "${table}" WHERE "${col}" IS NOT NULL AND "${col}" <> '' LIMIT 50`,
        50,
    );
    const n = r.rows.length;
    if (n === 0) return { space: 0, date: 0, email: 0, contactNumber: 0, randomToken: 0 };
    const vals = r.rows.map((row) => String(row.v).trim());
    const frac = (pred: (v: string) => boolean): number => vals.filter(pred).length / n;
    return {
        space: frac((v) => /\s/.test(v)),
        date: frac((v) => DATE_VALUE.test(v)),
        email: frac((v) => EMAIL_VALUE.test(v)),
        contactNumber: frac((v) => CONTACT_NUMBER_VALUE.test(v)),
        randomToken: frac(looksRandomToken),
    };
}

/** FNV-1a → 8 hex chars. Deterministic, identifier-safe sidecar naming. */
function fnv1a(s: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
}

/** Storage sidecar table for (table, col). Collision-resistant + valid ident. */
export function sidecarName(table: string, col: string): string {
    return `_rhvec_emb_${fnv1a(table + '/' + col)}`;
}

function escSq(s: string): string {
    return s.replace(/'/g, "''");
}

async function ensureSearchMapTable(db: IndexDb): Promise<void> {
    await db.execRaw(
        'CREATE TABLE IF NOT EXISTS _rhvec_search_map(' +
            'base_tbl TEXT NOT NULL, base_col TEXT NOT NULL,' +
            ' store_tbl TEXT NOT NULL, store_col TEXT NOT NULL,' +
            ' model TEXT, dim INTEGER, metric TEXT,' +
            ' PRIMARY KEY(base_tbl, base_col))',
    );
}

export async function isAlreadyIndexed(db: IndexDb, table: string, col: string): Promise<boolean> {
    try {
        const r = await db.execRaw(
            `SELECT model FROM _rhvec_search_map WHERE base_tbl='${escSq(table)}'` +
                ` AND base_col='${escSq(col)}' LIMIT 1`,
            1,
        );
        if (r.rows.length === 0) return false;
        // An index built by a DIFFERENT embedder (e.g. a pre-existing bge index
        // after the SEMANTIC_EMBEDDER switch) has the wrong space + dimensionality,
        // so the query path would dim-mismatch. Treat it as not-indexed → rebuild
        // (buildColumnIndex drops the map row + sidecar up front, so it's idempotent).
        const model = (r.rows[0] as { model?: string }).model;
        return model === EMBED_MODEL;
    } catch {
        // No map table yet → nothing indexed.
        return false;
    }
}

/**
 * High-cardinality TEXT columns of `table` — the semantic-search candidates.
 * Low-card text (enums/statuses) is handled by the existing IN/`describe`
 * enrichment, so it's excluded here; a column must repeat little enough to be
 * free text (names, descriptions, titles).
 */
export async function findSemanticCandidates(db: IndexDb, table: string): Promise<string[]> {
    assertSafeIdentifier(table);
    const schema = await db.getSchema();
    const t = schema.find((s) => s.name === table);
    if (!t) return [];
    const out: string[] = [];
    for (const c of t.columns) {
        const id = `${table}.${c.name}`;
        const reason = await semanticSkipReason(db, table, c);
        if (reason) {
            console.info(`[semantic-index] evaluating ${id}: ${reason}`);
            continue;
        }
        console.info(`[semantic-index] evaluating ${id}: ok`);
        out.push(c.name);
    }
    return out;
}

/**
 * Decide whether a column is fenced from semantic indexing. Returns the human
 * skip reason (logged by the caller) or `null` when the column is a candidate.
 * Extracted from {@link findSemanticCandidates} verbatim — same checks, same
 * order, same thresholds — to keep the loop's cognitive complexity bounded.
 */
async function semanticSkipReason(
    db: IndexDb,
    table: string,
    c: TableSchema['columns'][number],
): Promise<string | null> {
    if (!isTextType(c.type)) return 'skipped, not a text';
    // Identifier / code / contact-field by NAME (CamelCase-aware): id, sku,
    // email, phone/fax, postal/zip, password/hash/salt, address/street, …
    if (looksLikeIdentifierName(c.name)) return 'skipped, identifier-like name';
    try {
        assertSafeIdentifier(c.name);
    } catch {
        return 'skipped, unsafe SQL identifier';
    }
    // One sample of up to 50 values drives every value-shape check below
    // (date / email / phone / single-token), so a candidate costs one
    // LIMIT 50 scan + (if it survives) one COUNT DISTINCT.
    const shape = await sampleValueShape(db, table, c.name);
    // Skip date/time columns: SQLite has no DATE affinity, so ISO
    // timestamps/dates routinely live in TEXT columns (created_at,
    // order_date, opened_at) and slip past isTextType.
    if (shape.date >= VALUE_SHAPE_FRACTION) return 'skipped, date-shaped values';
    // Skip contact fields by VALUE shape — the backstop for a poorly-named
    // column the identifier-name check missed (a bare `email`/`contact`
    // column holding addresses, a `number` column holding phone/fax).
    if (shape.email >= VALUE_SHAPE_FRACTION) return 'skipped, email-shaped values';
    if (shape.contactNumber >= VALUE_SHAPE_FRACTION) return 'skipped, phone/number-shaped values';
    // Entropy model: UUIDs/GUIDs/base64/hex digests by VALUE — the backstop
    // for a random-token column whose name gave nothing away (a bare
    // `token`/`value`/`data` column of GUIDs the identifier-name check missed).
    if (shape.randomToken >= VALUE_SHAPE_FRACTION) return 'skipped, high-entropy random tokens';
    const r = await db.execRaw(
        `SELECT COUNT(*) AS total, COUNT(DISTINCT "${c.name}") AS d FROM "${table}"`,
        1,
    );
    const total = Number(r.rows[0]?.total ?? 0);
    const distinct = Number(r.rows[0]?.d ?? 0);
    // Need real variety (>= 2 distinct) and NOT low-cardinality (enums/statuses).
    if (distinct < 2 || isLowCardinality(distinct, total)) {
        return `skipped due to low card, total=${total}, distinct=${distinct}`;
    }
    // Skip identifier-shaped columns: near-unique AND single-token (no
    // whitespace) — SKUs/UUIDs/codes the name + value checks missed. Free
    // text (names, descriptions, titles) is multi-word, so it passes.
    const nearUnique = distinct / Math.max(total, 1) >= 0.9;
    if (nearUnique && shape.space < 0.2) return 'skipped, identifier-shaped';
    return null;
}

/**
 * Build (or rebuild) the semantic index for one column: sidecar + vectors +
 * vector_init + vector_quantize + map row. Idempotent — drops and rebuilds the
 * sidecar. Embeds in batches via the injected `embed`; in the browser the
 * handle is released between pages.
 */
export async function buildColumnIndex(
    db: IndexDb,
    table: string,
    col: string,
    embed: Embedder,
    onProgress?: (p: IndexProgress) => void,
): Promise<number> {
    assertSafeIdentifier(table);
    assertSafeIdentifier(col);
    const store = sidecarName(table, col); // generated -> identifier-safe

    // The map row is the ONLY "ready" signal the planner (describe_table) and
    // the vtab (vector_search) key off. Remove it up front so the column is
    // INVISIBLE for the entire (re)build, and re-add it atomically at the end —
    // guaranteeing the agent never sees a half-built index: a visible column is
    // always 100% populated + quantized.
    await ensureSearchMapTable(db);
    await db.execRaw(
        `DELETE FROM _rhvec_search_map WHERE base_tbl='${escSq(table)}' AND base_col='${escSq(col)}'`,
    );

    const totalRow = await db.execRaw(`SELECT COUNT(*) AS n FROM "${table}"`, 1);
    const total = Number(totalRow.rows[0]?.n ?? 0);

    await db.execRaw(`DROP TABLE IF EXISTS "${store}"`);
    await db.execRaw(`CREATE TABLE "${store}"(rowid INTEGER PRIMARY KEY, vec BLOB)`);

    let lastRowid = 0;
    let embedded = 0;
    for (;;) {
        const page = await db.execRaw(
            `SELECT rowid AS rid, "${col}" AS txt FROM "${table}"` +
                ` WHERE rowid > ${lastRowid} ORDER BY rowid LIMIT ${PAGE_ROWS}`,
            PAGE_ROWS,
        );
        if (page.rows.length === 0) break;
        lastRowid = Number(page.rows[page.rows.length - 1]!.rid);

        // Keep only rows with non-empty text; null/blank rows get no vector
        // (they could never match a query anyway).
        const items = page.rows
            .map((r) => ({ rid: Number(r.rid), text: r.txt == null ? '' : String(r.txt).trim() }))
            .filter((it) => it.text.length > 0);

        for (let i = 0; i < items.length; i += EMBED_BATCH) {
            const batch = items.slice(i, i + EMBED_BATCH);
            // Passages are embedded RAW (no query prefix — that's query-side only).
            const vectors = await embed(batch.map((b) => b.text));
            const values = batch.map((b, j) => {
                const vec = vectors[j];
                if (!vec || vec.length !== EMBED_DIM) {
                    throw new Error(
                        `[semantic-index] embed returned dim ${vec?.length} != ${EMBED_DIM}`,
                    );
                }
                return `(${b.rid}, vector_as_f32('${JSON.stringify(vec)}'))`;
            });
            await db.execRaw(
                `INSERT INTO "${store}"(rowid, vec) VALUES ${values.join(', ')}`,
                values.length,
            );
            embedded += batch.length;
            onProgress?.({ table, column: col, done: embedded, total });
        }
    }

    // Commit visibility ATOMICALLY: vector_init + vector_quantize + the map row
    // (the "ready" signal) land in one transaction — vector_quantize runs in the
    // caller's transaction by design (see vec-quantize.c), so this nests safely.
    // Any failure rolls all three back, so the column stays invisible rather
    // than half-usable.
    await db.execRaw('BEGIN');
    try {
        await db.execRaw(
            `SELECT vector_init('${store}','vec','dimension=${EMBED_DIM}, distance=cosine')`,
        );
        await db.execRaw(`SELECT vector_quantize('${store}','vec','qtype=turbo,qbits=4')`);
        await db.execRaw(
            `INSERT OR REPLACE INTO _rhvec_search_map` +
                `(base_tbl, base_col, store_tbl, store_col, model, dim, metric)` +
                ` VALUES('${escSq(table)}','${escSq(col)}','${store}','vec',` +
                `'${EMBED_MODEL}',${EMBED_DIM},'cosine')`,
        );
        await db.execRaw('COMMIT');
    } catch (e) {
        try {
            await db.execRaw('ROLLBACK');
        } catch (re) {
            console.error('[semantic-index] ROLLBACK after finalize failure also failed:', re);
        }
        throw e;
    }
    return embedded;
}

/**
 * Drop every semantic index for `table` — the sidecars and the map rows.
 * Used before re-indexing an OVERWRITTEN table: its rows were dropped and
 * recreated, so rowids no longer line up with the old sidecars. Tolerates the
 * map table not existing (nothing indexed yet).
 */
export async function clearSemanticIndex(db: IndexDb, table: string): Promise<void> {
    let stores: string[];
    try {
        const r = await db.execRaw(
            `SELECT store_tbl FROM _rhvec_search_map WHERE base_tbl='${escSq(table)}'`,
            500,
        );
        stores = r.rows.map((row) => String(row.store_tbl));
    } catch {
        return; // no map table → nothing to clear
    }
    for (const store of stores) {
        if (/^_rhvec_emb_[0-9a-f]+$/.test(store))
            await db.execRaw(`DROP TABLE IF EXISTS "${store}"`);
    }
    await db.execRaw(`DELETE FROM _rhvec_search_map WHERE base_tbl='${escSq(table)}'`);
}
