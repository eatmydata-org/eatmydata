/// <reference types="vite/client" />

interface ImportMetaEnv {
    /** Dev-only OpenRouter key, from `.env.local`. Empty in prod / when unset. */
    readonly VITE_DEV_OPENROUTER_KEY?: string;
    /** Dev-only Google AI Studio key, from `.env.local`. Empty in prod / when unset. */
    readonly VITE_DEV_GOOGLE_AI_STUDIO_KEY?: string;
    /** App release version */
    readonly APP_VERSION: string;
}

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
    const APP_VERSION: string;
}

export {};
