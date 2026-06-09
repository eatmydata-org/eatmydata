/**
 * Test-only async ONNX embedder via transformers.js / onnxruntime-web.
 *
 * This module lives in the test-runner tree and is NEVER imported by the main
 * app. It is loaded via `await import('./onnx-embed')` inside individual test
 * functions so Vite code-splits it into its own chunk — it only fetches at
 * runtime when a test that needs it actually runs.
 *
 * Uses the same TRANSFORMERS_ASSET_BASE and BGE ONNX model that the demo-data
 * Node builder uses (BAAI/bge-small-en-v1.5, q8). Runs the pipeline on the
 * calling thread (the /tests page is a developer tool; main-thread inference
 * is acceptable there).
 */
import { pipeline, env, type FeatureExtractionPipeline } from '@huggingface/transformers';

const ASSET_BASE = TRANSFORMERS_ASSET_BASE;
const MODEL_ID = 'BAAI/bge-small-en-v1.5';

let pipe: FeatureExtractionPipeline | null = null;

/** Boot the BGE feature-extraction pipeline (idempotent). */
export async function warmupOnnxEmbed(): Promise<void> {
    if (pipe) return;
    env.localModelPath = ASSET_BASE + '/';
    env.allowLocalModels = true;
    env.allowRemoteModels = false;
    // Point onnxruntime-web at the deployed ort/ wasm set.
    const ortBackend = env.backends.onnx;
    if (ortBackend.wasm && typeof self !== 'undefined' && 'location' in self) {
        ortBackend.wasm.wasmPaths = ASSET_BASE + '/ort/';
    }
    const p = (await pipeline('feature-extraction', MODEL_ID, {
        dtype: 'q8',
    })) as FeatureExtractionPipeline;
    // Clamp tokenizer context (shipped config says 1e19; real limit is 512).
    const cfg = (p.model as { config?: { max_position_embeddings?: number } }).config;
    const max = cfg?.max_position_embeddings;
    if (typeof max === 'number' && max > 0) {
        (
            p.tokenizer as { _tokenizerConfig?: { model_max_length?: number } }
        )._tokenizerConfig!.model_max_length = max;
    }
    pipe = p;
}

/** Embed texts via the ONNX pipeline: CLS pooling + L2 normalize. */
export async function onnxEmbed(texts: string[]): Promise<number[][]> {
    if (!pipe) throw new Error('[onnx-embed] call warmupOnnxEmbed first');
    if (!texts.length) return [];
    const out = await pipe(texts, { pooling: 'cls', normalize: true });
    return out.tolist() as number[][];
}

/** Release the pipeline (optional; useful between test suites). */
export async function releaseOnnxEmbed(): Promise<void> {
    if (!pipe) return;
    await pipe.dispose();
    pipe = null;
}
