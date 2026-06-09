import * as Comlink from 'comlink';
import type { TransformersAccessor } from './worker';
import { workerVersions } from 'virtual:worker-versions';

export const PII_REGEX_ONLY = false;

// SharedWorker identity is (URL, name, credentials). The URL is stable
// across dev reloads (Vite serves `worker.ts` from the same path), so
// without a name buster the browser reuses the running instance with
// stale code on each rebuild. In dev we suffix the name with a content
// hash of the worker sources; in prod we use the bare name because
// Vite already content-hashes the worker asset URL.
export const TRANSFORMERS_WORKER_NAME = import.meta.env.DEV
    ? `AnalystTransformersWorker-${workerVersions.transformers}`
    : 'AnalystTransformersWorker';

let cached: Comlink.Remote<TransformersAccessor> | null = null;

export function getTransformersAccessor(): Comlink.Remote<TransformersAccessor> {
    if (cached) return cached;
    const worker = new SharedWorker(new URL('./worker.ts', import.meta.url), {
        credentials: 'same-origin',
        type: 'module',
        name: TRANSFORMERS_WORKER_NAME,
    });
    cached = Comlink.wrap<TransformersAccessor>(worker.port);
    return cached;
}

export type {
    ModelKey,
    ManifestEntry,
    TransformersManifest,
    PiiEntity,
    PiiEntitySource,
    PiiDetector,
    AnalyzeStats,
    AnalyzeOptions,
} from './worker';
