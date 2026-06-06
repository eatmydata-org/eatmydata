import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

// Stub the dev-only `virtual:worker-versions` module (provided by
// tools/vite-plugin-worker-version in the real Vite build) so test suites
// whose import graph transitively reaches a worker client — e.g. the agent
// tools pulling in sqlite/client → wa-sqlite/client — can load under vitest.
// The version values only suffix worker names at runtime; they're irrelevant
// in tests, so an empty map is sufficient.
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
    // Mirror the real build's global define (vite.config.ts) so worker
    // modules that read the bare `APP_VERSION` global at import time
    // (e.g. src/lib/pii/worker.ts's ASSET_BASE) can load under vitest.
    define: {
        APP_VERSION: JSON.stringify('test'),
    },
    resolve: {
        alias: [
            {
                // Tests pin a stable fixture catalog (openrouter + google +
                // chrome-ai, all enabled) so they don't depend on the app's
                // mutable src/assets/config/*.json.
                find: '@app-config',
                replacement: fileURLToPath(
                    new URL('./src/lib/runtime/state/app-config.fixture.json', import.meta.url),
                ),
            },
            { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
        ],
    },
    test: {
        environment: 'node',
        include: [
            'src/**/*.test.ts',
            'scripts/**/*.test.ts',
            'contrib/vite-plugin-tsx-locator/**/*.test.ts',
        ],
        exclude: ['**/node_modules/**', '**/*.integration.test.ts'],
    },
});
