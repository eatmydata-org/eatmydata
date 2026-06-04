/// <reference lib="webworker" />
//
// SharedWorker that owns a transformers.js token-classification pipeline
// for the Mozilla AI TinyBERT PII model. Mirrors the SharedWorker
// pattern used by src/lib/sqlite/worker.ts: a long-lived accessor,
// lazy-initialized on the first call, exposed via Comlink so multiple
// tabs share one model instance.

import * as Comlink from 'comlink';
import { pipeline, env, type TokenClassificationPipeline } from '@huggingface/transformers';
import { analyzeRegex } from './regex';

declare const self: SharedWorkerGlobalScope;

// Host-side path for the deploy/ tree produced by wasm/tiny-pii/build.py.
const ASSET_BASE = '/tiny-pii/';

/**
 * Manifest written by `wasm/tiny-pii/build.py`. It's the single source
 * of truth for which model the build produced and at what precision —
 * the worker reads it on boot, so swapping `MODEL_ID` in build.py
 * doesn't require touching this file.
 */
export interface PiiManifest {
    model_id: string;
    source_url: string;
    task: 'token-classification';
    /**
     * fp32 / fp16 / q8 — matches transformers.js's
     * `DEFAULT_DTYPE_SUFFIX_MAPPING` (-> model.onnx / model_fp16.onnx
     * / model_quantized.onnx). q8 is dynamic int8 weight quantization;
     * activations stay fp32.
     */
    dtype: 'fp32' | 'fp16' | 'q8';
    source_dtype: string;
    opset: number;
    model_file: string;
}

export type PiiDetector = 'ner' | 'regex';

export interface PiiEntitySource {
    detector: PiiDetector;
    /**
     * Per-detector label. May differ from the merged entity's
     * `entity_type` (e.g. NER says `email_address`, regex says `email`).
     */
    entity_type: string;
    score: number;
}

export interface PiiEntity {
    /** Highest-confidence label across all detectors that fired here. */
    entity_type: string;
    start: number;
    end: number;
    /** Highest score among contributing detectors. */
    score: number;
    text: string;
    /**
     * Per-detector breakdown, populated only when the caller passes
     * `{ withSources: true }`. Each detector that contributed an
     * overlapping span appears once with its own label and score.
     */
    sources?: PiiEntitySource[];
}

export interface AnalyzeStats {
    /** NER pipeline call duration in ms (model + tokenization). */
    inferMs: number;
    /** Number of raw NER spans returned before any filtering. */
    rawSpanCount: number;
    /** Regex pass duration in ms; absent when regex wasn't run. */
    regexMs?: number;
    /** Number of regex spans (post overlap-resolution within regex). */
    regexSpanCount?: number;
    /** True when the input exceeded the regex scan cap and only its prefix was scanned. */
    truncated?: boolean;
}

export interface AnalyzeOptions {
    /**
     * Include the `sources` array on each returned entity. Only the
     * /pii testbed uses this today; downstream consumers shouldn't
     * depend on the field being present.
     */
    withSources?: boolean;
}

export class PiiAccessor {
    #pipe: Promise<TokenClassificationPipeline> | null = null;
    #manifest: Promise<PiiManifest> | null = null;
    #bootStartedAt = 0;
    #readyAt = 0;

    async #boot(): Promise<TokenClassificationPipeline> {
        this.#bootStartedAt = Date.now();
        // NOTE: keep this as a root-relative path, NOT a full URL.
        env.localModelPath = ASSET_BASE;
        env.allowLocalModels = true;
        env.allowRemoteModels = false;
        // onnxruntime-web fetches its `ort-*.wasm` from a CDN by default.
        // Point it at our deploy tree so everything stays same-origin.
        // Node/Vitest uses onnxruntime-node, which has no wasm backend
        // and no `self.location` — guard so this stays a browser-only
        // adjustment.
        const ortBackend = env.backends.onnx;
        if (ortBackend.wasm && typeof self !== 'undefined' && 'location' in self) {
            ortBackend.wasm.wasmPaths = new URL(
                'ort/',
                self.location.origin + ASSET_BASE,
            ).toString();
        }

        const manifest = await this.getManifest();
        const pipe = (await pipeline(manifest.task, manifest.model_id, {
            dtype: manifest.dtype,
        })) as TokenClassificationPipeline;
        // TinyBERT's tokenizer_config.json ships `model_max_length:
        // 1e19` (HuggingFace's "unlimited" sentinel), but the model's
        // position-embedding table is only `max_position_embeddings`
        // rows. The pipeline's `_call` invokes the tokenizer with
        // `{ padding: true, truncation: true }` but no explicit
        // `max_length`, so transformers.js reads `model_max_length`
        // (∞), skips truncation, and ORT then crashes broadcasting
        // position embeddings against the longer input (the literal
        // "Attempting to broadcast an axis by a dimension other than
        // 1. 512 by N" error). Overriding the cached tokenizer config
        // post-boot makes truncation kick in at the model's real
        // context limit.
        const cfg = (pipe.model as unknown as { config: { max_position_embeddings?: number } })
            .config;
        const max = cfg.max_position_embeddings;
        if (typeof max === 'number' && max > 0) {
            (
                pipe.tokenizer as unknown as { _tokenizerConfig: { model_max_length: number } }
            )._tokenizerConfig.model_max_length = max;
        }
        this.#readyAt = Date.now();
        return pipe;
    }

    /**
     * Returns the manifest produced by build.py. Cached after first
     * fetch. Doesn't block on the pipeline boot — the page calls this
     * to render model info (link, dtype chip) before the heavy ONNX
     * is downloaded.
     */
    getManifest(): Promise<PiiManifest> {
        this.#manifest ??= this.#fetchManifest();
        return this.#manifest;
    }

    async #fetchManifest(): Promise<PiiManifest> {
        const res = await fetch(`${ASSET_BASE}manifest.json`, { cache: 'no-store' });
        if (!res.ok) {
            // Clear the cached failure so subsequent calls retry.
            this.#manifest = null;
            throw new Error(
                `tiny-pii manifest missing at ${ASSET_BASE}manifest.json — ` +
                    `did the build run? (HTTP ${res.status})`,
            );
        }
        return (await res.json()) as PiiManifest;
    }

    #get(): Promise<TokenClassificationPipeline> {
        // Don't cache rejections — a SharedWorker survives tab reloads,
        // so a first-boot failure (e.g. asset path misconfigured) would
        // stick forever. On rejection, clear so the next call retries.
        if (this.#pipe === null) {
            this.#pipe = this.#boot().catch((err) => {
                this.#pipe = null;
                throw err;
            });
        }
        return this.#pipe;
    }

    async warmup(): Promise<void> {
        await this.#get();
    }

    /** Boot timing in ms; 0 before boot completes. */
    bootElapsedMs(): number {
        if (!this.#readyAt || !this.#bootStartedAt) return 0;
        return this.#readyAt - this.#bootStartedAt;
    }

    /** True once the pipeline has finished booting. */
    isWarm(): boolean {
        return this.#readyAt > 0;
    }

    /**
     * Regex-only fallback. Doesn't touch the model — safe to call when
     * the user opts out of the TinyBERT download. Same return shape as
     * `analyze` so the UI can swap detectors without conditionals.
     */
    analyzeRegex(
        text: string,
        opts?: AnalyzeOptions,
    ): { entities: PiiEntity[]; stats: AnalyzeStats } {
        const { entities, stats } = analyzeRegex(text);
        const out = opts?.withSources ? entities.map(tagAsRegex) : entities;
        return {
            entities: out,
            stats: {
                inferMs: 0,
                rawSpanCount: 0,
                regexMs: stats.inferMs,
                regexSpanCount: entities.length,
            },
        };
    }

    /**
     * Debug-only: returns the raw, un-aggregated per-token output of
     * the pipeline (no BIO merging, no 'O' filter, no special-token
     * filter). Useful when `analyze` returns no spans — lets the
     * caller see whether the model is predicting 'O' for everything,
     * predicting wrong labels, or predicting fine but failing to
     * aggregate.
     */
    async analyzeRaw(text: string): Promise<unknown[]> {
        if (!text.trim()) return [];
        const pipe = await this.#get();
        const out = await pipe(text, {
            aggregation_strategy: 'none',
            ignore_labels: [],
        } as never);
        return Array.isArray(out) ? out : [out];
    }

    /**
     * Runs token-classification, BIO-aggregates spans, and reconstructs
     * char offsets in the original text.
     *
     * Why we don't just use `aggregation_strategy: 'simple'`: that path
     * in transformers.js returns `{ entity_group, score, word }` only —
     * no start/end char offsets (there's a literal `// TODO: Add support
     * for start and end` in their source). The highlighter overlay
     * needs offsets, so we run with `aggregation_strategy: 'none'`,
     * then walk the original text matching each subword to recover
     * char positions, then group B-/I- runs ourselves.
     */
    async analyze(
        text: string,
        opts?: AnalyzeOptions,
    ): Promise<{ entities: PiiEntity[]; stats: AnalyzeStats }> {
        if (!text.trim()) {
            return {
                entities: [],
                stats: { inferMs: 0, rawSpanCount: 0, regexMs: 0, regexSpanCount: 0 },
            };
        }
        const pipe = await this.#get();
        const t0 = performance.now();
        const raw = (await pipe(text, {
            aggregation_strategy: 'none',
            ignore_labels: [],
        } as never)) as Array<{ entity: string; score: number; word: string; index: number }>;
        const inferMs = performance.now() - t0;

        // Walk `text` left-to-right, matching each token's `word` to
        // recover its char span. Subword continuations are prefixed
        // with `##` (BERT wordpiece convention) and attach to the
        // previous token without leading whitespace.
        const lowered = text.toLowerCase();
        const placed: Array<{ entity: string; score: number; start: number; end: number }> = [];
        let cursor = 0;
        for (const tok of raw) {
            const isContinuation = tok.word.startsWith('##');
            const piece = isContinuation ? tok.word.slice(2) : tok.word;
            if (!piece) continue;
            let pos: number;
            if (isContinuation) {
                // Subword: must sit immediately after the previous piece.
                pos = lowered.indexOf(piece, cursor);
                if (pos !== cursor) {
                    // Surprise — bail on this token rather than corrupt offsets.
                    continue;
                }
            } else {
                pos = lowered.indexOf(piece, cursor);
                if (pos < 0) continue;
            }
            placed.push({
                entity: tok.entity,
                score: tok.score,
                start: pos,
                end: pos + piece.length,
            });
            cursor = pos + piece.length;
        }

        // BIO aggregation: contiguous tokens of the same tag fold into
        // one span. `B-X` always opens a new group; `I-X` extends the
        // previous group if it had the same tag, otherwise opens one
        // (lenient mode, matches HuggingFace `simple` strategy).
        const nerEntities: PiiEntity[] = [];
        let open: { tag: string; start: number; end: number; scoreSum: number; n: number } | null =
            null;
        const flush = () => {
            if (!open) return;
            nerEntities.push({
                entity_type: open.tag,
                start: open.start,
                end: open.end,
                score: open.scoreSum / open.n,
                text: text.slice(open.start, open.end),
            });
            open = null;
        };
        for (const p of placed) {
            if (p.entity === 'O') {
                flush();
                continue;
            }
            const [prefix, tag] = splitBio(p.entity);
            const extend = open && open.tag === tag && prefix !== 'B';
            if (extend && open) {
                open.end = p.end;
                open.scoreSum += p.score;
                open.n += 1;
            } else {
                flush();
                open = { tag, start: p.start, end: p.end, scoreSum: p.score, n: 1 };
            }
        }
        flush();

        // Regex pass runs unconditionally — its findings are merged into
        // the NER output below. The two detectors are complementary:
        // NER catches free-form things (names, locations) the regex
        // can't, regex catches structured identifiers (cards, JWTs,
        // keys) the model is shaky on.
        const rt0 = performance.now();
        const { entities: regexEntities } = analyzeRegex(text);
        const regexMs = performance.now() - rt0;

        const merged = mergeOverlapping(
            nerEntities.map(tagAsNer),
            regexEntities.map(tagAsRegex),
            text,
        );
        const entities = opts?.withSources ? merged : merged.map(stripSources);

        return {
            entities,
            stats: {
                inferMs,
                rawSpanCount: raw.length,
                regexMs,
                regexSpanCount: regexEntities.length,
            },
        };
    }
}

function tagAsNer(e: PiiEntity): PiiEntity {
    return {
        ...e,
        sources: [{ detector: 'ner', entity_type: e.entity_type, score: e.score }],
    };
}

function tagAsRegex(e: PiiEntity): PiiEntity {
    return {
        ...e,
        sources: [{ detector: 'regex', entity_type: e.entity_type, score: e.score }],
    };
}

function stripSources(e: PiiEntity): PiiEntity {
    if (!e.sources) return e;
    const { sources: _, ...rest } = e;
    return rest;
}

/**
 * Merge entities from multiple detectors. Any two spans that overlap
 * (even by one char) collapse into one span covering their union; the
 * resulting `entity_type` and `score` come from the contributing
 * detector with the highest score, and every contributor is preserved
 * in `sources`. Disjoint spans pass through unchanged.
 */
function mergeOverlapping(ner: PiiEntity[], regex: PiiEntity[], text: string): PiiEntity[] {
    const all = [...ner, ...regex].sort((a, b) => a.start - b.start);
    if (!all.length) return [];
    const groups: PiiEntity[][] = [];
    let groupEnd = -1;
    for (const e of all) {
        if (!groups.length || e.start >= groupEnd) {
            groups.push([e]);
            groupEnd = e.end;
        } else {
            groups[groups.length - 1]!.push(e);
            if (e.end > groupEnd) groupEnd = e.end;
        }
    }
    return groups.map((g) => {
        const start = Math.min(...g.map((x) => x.start));
        const end = Math.max(...g.map((x) => x.end));
        // Highest-scoring contributor wins the displayed label.
        const primary = g.reduce((a, b) => (b.score > a.score ? b : a));
        const sources: PiiEntitySource[] = g.flatMap((x) => x.sources ?? []);
        return {
            entity_type: primary.entity_type,
            start,
            end,
            score: Math.max(...g.map((x) => x.score)),
            text: text.slice(start, end),
            sources,
        };
    });
}

function splitBio(label: string): readonly [prefix: 'B' | 'I' | 'O', tag: string] {
    if (label === 'O') return ['O', ''];
    if (label.length > 1 && label[1] === '-') {
        const p = label[0];
        if (p === 'B' || p === 'I') return [p, label.slice(2)];
    }
    // Lenient: treat any unprefixed label as a continuation tag.
    return ['I', label];
}

const accessor = new PiiAccessor();

// This file is also imported (for the `PiiAccessor` class) by the
// runtime SharedWorker so it can run PII detection in-process. Only
// register the `connect` listener when *this* worker is the PII
// SharedWorker entry — distinguished by `self.name`, which is set
// from the SharedWorker constructor's `name` option. Otherwise the
// runtime worker would also expose PII on its own connections.
//
// The dev build suffixes the name with a content-hash version
// (`AnalystPiiWorker-<hash>`) to bust SharedWorker identity on each
// rebuild — see tools/vite-plugin-worker-version.ts. Accept both
// shapes so prod's bare name and dev's versioned name both match.
const selfName =
    typeof self !== 'undefined' ? (self as unknown as { name?: string }).name : undefined;
if (selfName === 'AnalystPiiWorker' || selfName?.startsWith('AnalystPiiWorker-')) {
    (self as unknown as SharedWorkerGlobalScope).addEventListener('connect', (event) => {
        const port = event.ports[0]!;
        Comlink.expose(accessor, port);
    });
}
