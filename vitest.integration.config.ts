import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Integration tests that hit the real OpenRouter API and exercise the full
 * multi-agent loop against a Northwind SQLite fixture. Gated on
 * OPENROUTER_API_KEY — tests skip cleanly when absent.
 *
 * Kept in a separate config from the default `vitest.config.ts` because:
 *   - Longer per-test timeouts (real network latency, multi-agent loops).
 *   - `singleThread` to serialize wa-sqlite init and avoid worker-pool churn.
 *   - Different include pattern so `pnpm test` stays fast/offline.
 */
export default defineConfig({
    resolve: {
        alias: [
            {
                find: '@',
                replacement: fileURLToPath(new URL('./src', import.meta.url)),
            },
        ],
    },
    test: {
        environment: 'node',
        include: ['src/**/*.integration.test.ts'],
        testTimeout: 120_000,
        hookTimeout: 60_000,
        // wa-sqlite + QuickJS WASM modules carry global state; running in a
        // single thread avoids flaky cross-test races on init.
        pool: 'threads',
        // Vitest 4: poolOptions are now top-level pool fields.
        singleThread: true,
    },
});
