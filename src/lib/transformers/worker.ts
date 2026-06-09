/// <reference lib="webworker" />
//
// SharedWorker that hosts PII NER for the app:
//
//   - 'pii' — token-classification NER via the self-contained `semantic` C/wasm
//             engine (wasm/semantic, the SAME binary bge-embed uses for
//             embeddings), plus a regex pass; see `analyze`.
//
// The production path no longer touches onnxruntime-web / @huggingface/transformers
// at all — that runtime is reached ONLY via `analyzeOnnx`, which `await import()`s
// transformers.js lazily and is called solely by the /pii and /tests comparison
// surfaces (mirroring how the ONNX embedding variants live behind /embeddings +
// /tests). So no main-app page bundles transformers.js.
//
// One long-lived accessor, exposed via Comlink so every tab shares a single worker
// (and a single model instance). Mirrors the SharedWorker pattern used by
// src/lib/wa-sqlite.

import * as Comlink from 'comlink';
import { analyzeRegex } from './regex';
import {
    warmupBertNer,
    inferTokensSync,
    isBertNerReady,
    isNerModelCached,
    nerGgufUrl,
} from '@/lib/bert-ner/runtime';
import { aggregateBio, tokensToPlaced, LABELS, type PlacedToken } from '@/lib/bert-ner/decode';

declare const self: SharedWorkerGlobalScope;

/** The models this worker hosts. Only 'pii' today. */
export type ModelKey = 'pii';

/**
 * Lightweight model info for the UI. Retains the historical `ManifestEntry`
 * shape (the /pii header + Settings read `model_id` / `source_url` / `dtype` /
 * `source_dtype`) but is now synthesized for the C engine rather than read from
 * the ONNX deploy manifest.
 */
export interface ManifestEntry {
    model_id: string;
    source_url: string;
    task: 'token-classification' | 'feature-extraction';
    dtype: 'fp32' | 'fp16' | 'q8';
    source_dtype: string;
    opset: number;
    model_file: string;
}

/** Multi-model manifest written by wasm/transformers/build.py (ONNX deploy tree).
 *  Still read by the `analyzeOnnx` comparison path. */
export interface TransformersManifest {
    schema: number;
    models: Record<string, ManifestEntry>;
}

export type PiiDetector = 'ner' | 'regex';

export interface PiiEntitySource {
    detector: PiiDetector;
    /** Per-detector label. May differ from the merged entity's `entity_type`. */
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
    /** Per-detector breakdown, populated only with `{ withSources: true }`. */
    sources?: PiiEntitySource[];
}

export interface AnalyzeStats {
    /** NER inference duration in ms (tokenize + encoder + classifier). */
    inferMs: number;
    /** Number of content tokens the classifier returned. */
    rawSpanCount: number;
    /** Regex pass duration in ms; absent when regex wasn't run. */
    regexMs?: number;
    /** Number of regex spans (post overlap-resolution within regex). */
    regexSpanCount?: number;
    /** Which NER engine produced this result ('semantic' = C/wasm, 'onnx' = comparison). */
    engine?: 'semantic' | 'onnx';
}

export interface AnalyzeOptions {
    /** Include the `sources` array on each returned entity (the /pii testbed). */
    withSources?: boolean;
}

/** Synthesized info for the PII model (the C engine reads weights from a GGUF). */
const NER_INFO: ManifestEntry = {
    model_id: 'gravitee-io/bert-small-pii-detection',
    source_url: 'https://huggingface.co/gravitee-io/bert-small-pii-detection',
    task: 'token-classification',
    dtype: 'q8', // shipped GGUF is Q8_0 (dequantized to f32 at load)
    source_dtype: 'fp32',
    opset: 0,
    model_file: 'bert-small-pii-detection-q8_0.gguf',
};

export class TransformersAccessor {
    #bootStartedAt = 0;
    #readyAt = 0;

    // ---- model info / download status (Settings + /pii header) -------------

    /** Synthesized info for the given model. Throws for unknown keys. */
    async getModelInfo(key: ModelKey): Promise<ManifestEntry> {
        if (key !== 'pii') throw new Error(`unknown model "${key}"`);
        return NER_INFO;
    }

    /** Byte size of the GGUF the model will download (HEAD the asset URL). */
    async modelSizeBytes(key: ModelKey): Promise<number | null> {
        if (key !== 'pii') throw new Error(`unknown model "${key}"`);
        const url = nerGgufUrl();
        const res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
        if (!res.ok) throw new Error(`NER model file missing at ${url} (HTTP ${res.status})`);
        const len = res.headers.get('content-length');
        return len ? Number(len) : null;
    }

    /** Trigger (and await) the C engine warmup (fetch wasm + gguf, sem_init). */
    async warmup(key: ModelKey): Promise<void> {
        if (key !== 'pii') throw new Error(`unknown model "${key}"`);
        this.#bootStartedAt = Date.now();
        await warmupBertNer();
        this.#readyAt = Date.now();
    }

    /** Alias for `warmup` — the name the Settings download button calls. */
    download(key: ModelKey): Promise<void> {
        return this.warmup(key);
    }

    /** Boot timing in ms; 0 before boot completes. Never triggers a boot. */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- key kept for ModelKey-parity with the other per-model methods
    bootElapsedMs(_key: ModelKey): number {
        if (!this.#readyAt || !this.#bootStartedAt) return 0;
        return this.#readyAt - this.#bootStartedAt;
    }

    /** True once the engine has booted. Never triggers a boot. */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- key kept for ModelKey-parity with the other per-model methods
    isWarm(_key: ModelKey): boolean {
        return isBertNerReady();
    }

    /** True if the GGUF is already in the browser Cache (instant next boot). */
    async isCached(key: ModelKey): Promise<boolean> {
        if (key !== 'pii') return false;
        if (isBertNerReady()) return true;
        return isNerModelCached();
    }

    // ---- PII (token-classification + regex) -------------------------------

    /**
     * Regex-only fallback. Doesn't touch the model — safe when the user opts out
     * of the model download. Same return shape as `analyze`.
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
     * Debug-only: the raw per-token classifier output (no BIO merge, no 'O'
     * filter) — label string + score + BYTE offsets. Lets a caller see whether
     * the model predicts 'O' everywhere, wrong labels, or fine-but-unaggregated.
     */
    async analyzeRaw(text: string): Promise<unknown[]> {
        if (!text.trim()) return [];
        await warmupBertNer();
        return inferTokensSync(text).map((t) => ({
            entity: LABELS[t.label] ?? 'O',
            score: t.score,
            start: t.start,
            end: t.end,
        }));
    }

    /**
     * Production NER: the `semantic` C/wasm engine classifies each token, decode.ts
     * folds the B-/I- runs into spans (fed by exact char offsets from C — no fuzzy
     * subword matching), then the regex pass is merged in. The two detectors are
     * complementary: NER catches free-form things (names, locations) regex can't;
     * regex catches structured identifiers (cards, JWTs, keys) the model is shaky on.
     */
    async analyze(
        text: string,
        opts?: AnalyzeOptions,
    ): Promise<{ entities: PiiEntity[]; stats: AnalyzeStats }> {
        if (!text.trim()) {
            return {
                entities: [],
                stats: {
                    inferMs: 0,
                    rawSpanCount: 0,
                    regexMs: 0,
                    regexSpanCount: 0,
                    engine: 'semantic',
                },
            };
        }
        await warmupBertNer();
        const t0 = performance.now();
        const tokens = inferTokensSync(text);
        const nerSpans = aggregateBio(tokensToPlaced(tokens, text), text);
        const inferMs = performance.now() - t0;
        return this.#mergeWithRegex(text, nerSpans, tokens.length, inferMs, 'semantic', opts);
    }

    /**
     * COMPARISON-ONLY ONNX path (perf + structural A/B for /pii and /tests). Lazily
     * `await import()`s transformers.js so the production bundle never pulls in
     * onnxruntime-web. Reproduces the old token-classification pipeline + subword
     * placement, then shares decode.ts's aggregation + the regex merge so any
     * difference vs `analyze` isolates to the model/tokenizer.
     */
    async analyzeOnnx(
        text: string,
        opts?: AnalyzeOptions,
    ): Promise<{ entities: PiiEntity[]; stats: AnalyzeStats }> {
        if (!text.trim()) {
            return {
                entities: [],
                stats: {
                    inferMs: 0,
                    rawSpanCount: 0,
                    regexMs: 0,
                    regexSpanCount: 0,
                    engine: 'onnx',
                },
            };
        }
        const pipe = await this.#onnxPipe();
        const t0 = performance.now();
        const raw = (await pipe(text, {
            aggregation_strategy: 'none',
            ignore_labels: [],
        } as never)) as Array<{
            entity: string;
            score: number;
            word: string;
            index: number;
        }>;
        const inferMs = performance.now() - t0;
        const placed = placeOnnxSubwords(raw, text);
        const nerSpans = aggregateBio(placed, text);
        return this.#mergeWithRegex(text, nerSpans, raw.length, inferMs, 'onnx', opts);
    }

    /** Shared tail: tag NER spans, run the regex pass, merge overlaps. */
    #mergeWithRegex(
        text: string,
        nerSpans: PiiEntity[],
        rawSpanCount: number,
        inferMs: number,
        engine: 'semantic' | 'onnx',
        opts?: AnalyzeOptions,
    ): { entities: PiiEntity[]; stats: AnalyzeStats } {
        const rt0 = performance.now();
        const { entities: regexEntities } = analyzeRegex(text);
        const regexMs = performance.now() - rt0;
        const merged = mergeOverlapping(
            nerSpans.map(tagAsNer),
            regexEntities.map(tagAsRegex),
            text,
        );
        const entities = opts?.withSources ? merged : merged.map(stripSources);
        return {
            entities,
            stats: { inferMs, rawSpanCount, regexMs, regexSpanCount: regexEntities.length, engine },
        };
    }

    // ---- ONNX comparison pipeline (lazy, /pii + /tests only) ---------------

    #onnxPipePromise: Promise<unknown> | null = null;

    #onnxPipe(): Promise<TokenClassificationPipelineLike> {
        this.#onnxPipePromise ??= bootOnnxPipe().catch((err) => {
            this.#onnxPipePromise = null;
            throw err;
        });
        return this.#onnxPipePromise as Promise<TokenClassificationPipelineLike>;
    }
}

// ---- helpers ---------------------------------------------------------------

type TokenClassificationPipelineLike = (text: string, opts: unknown) => Promise<unknown>;

/**
 * Boot the transformers.js token-classification pipeline for the comparison path.
 * Pinned to the same ONNX deploy tree (TRANSFORMERS_ASSET_BASE) the build produces;
 * everything here is reached only via the dynamic import in `analyzeOnnx`.
 */
async function bootOnnxPipe(): Promise<TokenClassificationPipelineLike> {
    const { pipeline, env } = await import('@huggingface/transformers');
    const base = TRANSFORMERS_ASSET_BASE;
    env.localModelPath = base + '/';
    env.allowLocalModels = true;
    env.allowRemoteModels = false;
    const ortBackend = env.backends.onnx;
    if (ortBackend.wasm && typeof self !== 'undefined' && 'location' in self) {
        ortBackend.wasm.wasmPaths = base + '/ort/';
    }
    // Read the deploy manifest for the pii entry (model_id + dtype).
    const res = await fetch(`${base}/manifest.json`, { cache: 'no-store' });
    if (!res.ok)
        throw new Error(
            `transformers manifest missing at ${base}/manifest.json (HTTP ${res.status})`,
        );
    const manifest = (await res.json()) as TransformersManifest;
    const entry = manifest.models?.pii;
    if (!entry)
        throw new Error('transformers manifest has no "pii" model (re-run `make transformers`)');
    const pipe = (await pipeline(entry.task, entry.model_id, {
        dtype: entry.dtype,
    })) as unknown as {
        model: { config?: { max_position_embeddings?: number } };
        tokenizer: { _tokenizerConfig?: { model_max_length?: number } };
    };
    // BERT ships model_max_length: 1e19; clamp to the real ctx so ORT doesn't crash
    // broadcasting position embeddings on long input.
    const max = pipe.model.config?.max_position_embeddings;
    if (typeof max === 'number' && max > 0) pipe.tokenizer._tokenizerConfig!.model_max_length = max;
    return pipe as unknown as TokenClassificationPipelineLike;
}

/**
 * Recover char offsets for transformers.js's raw per-token output by walking the
 * lowercased text matching each subword (`##` continuations attach to the prior
 * piece). Returns PlacedToken[] for decode.ts's aggregateBio. (Only the ONNX
 * comparison path needs this — the C engine returns exact offsets directly.)
 */
function placeOnnxSubwords(
    raw: Array<{ entity: string; score: number; word: string; index: number }>,
    text: string,
): PlacedToken[] {
    const lowered = text.toLowerCase();
    const placed: PlacedToken[] = [];
    let cursor = 0;
    for (const tok of raw) {
        const isContinuation = tok.word.startsWith('##');
        const piece = isContinuation ? tok.word.slice(2) : tok.word;
        if (!piece) continue;
        const pos = lowered.indexOf(piece, cursor);
        if (isContinuation ? pos !== cursor : pos < 0) continue;
        placed.push({ entity: tok.entity, score: tok.score, start: pos, end: pos + piece.length });
        cursor = pos + piece.length;
    }
    return placed;
}

function tagAsNer(e: PiiEntity): PiiEntity {
    return { ...e, sources: [{ detector: 'ner', entity_type: e.entity_type, score: e.score }] };
}

function tagAsRegex(e: PiiEntity): PiiEntity {
    return { ...e, sources: [{ detector: 'regex', entity_type: e.entity_type, score: e.score }] };
}

function stripSources(e: PiiEntity): PiiEntity {
    if (!e.sources) return e;
    const rest = { ...e };
    delete rest.sources;
    return rest;
}

/**
 * Merge entities from multiple detectors. Any two spans that overlap (even by one
 * char) collapse into one span covering their union; the resulting `entity_type`
 * and `score` come from the highest-scoring contributor, and every contributor is
 * preserved in `sources`. Disjoint spans pass through unchanged.
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

const accessor = new TransformersAccessor();

// Only register the `connect` listener when *this* worker is the Transformers
// SharedWorker entry — distinguished by `self.name` (set from the SharedWorker
// constructor). The dev build suffixes the name with a content hash; accept both.
const selfName =
    typeof self !== 'undefined' ? (self as unknown as { name?: string }).name : undefined;
if (
    selfName === 'AnalystTransformersWorker' ||
    selfName?.startsWith('AnalystTransformersWorker-')
) {
    (self as unknown as SharedWorkerGlobalScope).addEventListener('connect', (event) => {
        const port = event.ports[0]!;
        Comlink.expose(accessor, port);
    });
}
