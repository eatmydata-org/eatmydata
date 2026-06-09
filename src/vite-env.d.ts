/// <reference types="vite/client" />

interface ImportMetaEnv {
    /** Dev-only OpenRouter key, from `.env.local`. Empty in prod / when unset. */
    readonly VITE_DEV_OPENROUTER_KEY?: string;
    /** Dev-only Google AI Studio key, from `.env.local`. Empty in prod / when unset. */
    readonly VITE_DEV_GOOGLE_AI_STUDIO_KEY?: string;
}

// Ambient augmentation of the global `ImportMeta` so `import.meta.env` is
// typed as `ImportMetaEnv`. Consumed by the type checker, not by runtime
// code, so the linter can't see the use.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
interface ImportMeta {
    readonly env: ImportMetaEnv;
}

declare module 'virtual:worker-versions' {
    /// Per-worker content hashes keyed by the `WorkerSpec.key` registered
    /// in tools/vite-plugin-worker-version.ts. Each value is a 16-char hash
    /// of that worker's sources, or the literal `'prod'` in production
    /// builds. Consumers suffix their Worker `name` with the relevant entry
    /// to bust a stale instance on dev rebuilds.
    export const workerVersions: Record<string, string>;
}

declare global {
    /** Root-relative base URL for the Transformers Worker's models +
     *  tokenizers + ort wasm. Injected by vite.config.ts. Build:
     *  `/<content-hash>/transformers`; dev: `/src/assets/transformers`;
     *  vitest: `/test/transformers`. The hash keeps the URL stable across
     *  releases while the assets are unchanged. */
    const TRANSFORMERS_ASSET_BASE: string;
    /** Root-relative base URL for the demo `.sqlite` databases. Injected by
     *  vite.config.ts. Build: `/<content-hash>/demo`; dev: `/src/assets/demo`;
     *  vitest: `/test/demo`. */
    const DEMO_ASSET_BASE: string;
}

export {};
