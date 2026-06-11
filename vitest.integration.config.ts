import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

/**
 * Integration tests that hit the real OpenRouter API and exercise the full
 * multi-agent loop against a Northwind SQLite fixture. Gated on
 * OPENROUTER_API_KEY — tests skip cleanly when absent.
 *
 * Kept in a separate config from the default `vitest.config.ts` because:
 *   - Longer per-test timeouts (real network latency, multi-agent loops).
 *   - `singleThread` to serialize wa-sqlite init and avoid worker-pool churn.
 *   - Different include pattern so `pnpm test` stays fast/offline.
 *
 * The plugin/define/alias trio below mirrors vitest.config.ts: this suite's
 * import graph reaches the same worker-client (`virtual:worker-versions`),
 * asset-base globals, and `@app-config` catalog as the unit suite, so it needs
 * the same shims to load.
 */
function workerVersionsStub(): Plugin {
    const VIRTUAL_ID = 'virtual:worker-versions';
    const RESOLVED_ID = '\0' + VIRTUAL_ID;
    return {
        name: 'worker-versions-stub',
        resolveId(id) {
            if (id === VIRTUAL_ID) return RESOLVED_ID;
        },
        load(id) {
            if (id === RESOLVED_ID) return 'export const workerVersions = {};';
        },
    };
}

export default defineConfig({
    plugins: [workerVersionsStub()],
    define: {
        TRANSFORMERS_ASSET_BASE: JSON.stringify('/test/transformers'),
        DEMO_ASSET_BASE: JSON.stringify('/test/demo'),
    },
    resolve: {
        alias: [
            {
                // Pin the stable fixture catalog (all providers enabled) so the
                // suite doesn't depend on the app's mutable src/assets/config.
                find: '@app-config',
                replacement: fileURLToPath(
                    new URL('./src/lib/runtime/state/app-config.fixture.json', import.meta.url),
                ),
            },
            {
                find: '@',
                replacement: fileURLToPath(new URL('./src', import.meta.url)),
            },
        ],
    },
    test: {
        environment: 'node',
        include: ['src/**/*.integration.test.ts'],
        // Per-file global setup: surfaces the cost reminder, resolves the
        // OpenRouter key into globalThis.__INTEGRATION_API_KEY, and wires the
        // QuickJS sandbox to read qjs.wasm from disk (see setup.ts). Was
        // documented in setup.ts's header but never actually registered.
        setupFiles: ['./src/lib/agent/integration/setup.ts'],
        testTimeout: 120_000,
        hookTimeout: 60_000,
        // wa-sqlite + QuickJS WASM modules carry global state; running in a
        // single thread avoids flaky cross-test races on init.
        pool: 'threads',
        // Vitest 4: poolOptions are now top-level pool fields.
        singleThread: true,
    },
});
