import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import solid from 'vite-plugin-solid';
import tailwindcss from '@tailwindcss/vite';
import { tinyPiiAssets } from './tools/vite-plugin-tiny-pii';
import { workerVersion } from './tools/vite-plugin-worker-version';
import { tsxElementBabelPlugin, tsxLocator } from './contrib/vite-plugin-tsx-locator/src/index';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));

// Dev-only "click-to-source" tooling (contrib/vite-plugin-tsx-locator):
// `command === 'serve'` stamps each component's root element with a
// `data-tsx-element="Component@relpath:line"` tag via Solid's existing Babel
// pass, and `tsxLocator()` injects the Shift+Alt+click → editor runtime. Both
// are absent from production builds.
export default defineConfig(({ command }) => ({
    server: {
        port: 5173,
    },
    plugins: [
        solid(
            command === 'serve'
                ? { babel: { plugins: [tsxElementBabelPlugin({ root: projectRoot })] } }
                : undefined,
        ),
        tsxLocator(),
        tailwindcss(),
        tinyPiiAssets(),
        // Dev-time cache-bust + reload for every worker. `client.ts` is the
        // consumer-side module per worker and never runs in the worker, so
        // it's excluded from each hash. `test-worker.ts` under wa-sqlite is
        // dead (no importer); skip it so its edits don't force reloads.
        workerVersion([
            { key: 'pii', dir: 'src/lib/pii', exclude: ['client.ts'] },
            {
                key: 'wa-sqlite',
                dir: 'src/lib/wa-sqlite',
                exclude: ['client.ts', 'test-worker.ts'],
            },
            { key: 'wa-sqlite-probe', dir: 'src/lib/wa-sqlite-probe' },
        ]),
    ],
    build: {
        // Ship unminified prod bundles. Rollup still hashes asset filenames
        // for cache-busting; we just skip the minify pass — readable output is
        // worth more here than the byte savings. No sourcemaps: with
        // unminified, multi-file output the bundles already map cleanly to
        // `src/...`, so they'd only bloat the deploy.
        minify: false,
    },
    // ECharts / zrender reference `global` (Node.js style) at module
    // top-level. In the main thread `window` rescues them via shims,
    // but in the runtime SharedWorker bundle there is no `window` and
    // no `global`, so the load crashes with "global is not defined".
    // Define both to `globalThis` so worker bundles compile cleanly.
    define: {
        global: 'globalThis',
    },
    resolve: {
        alias: [
            {
                find: /^@\/registry\/(.*)$/,
                replacement: fileURLToPath(
                    new URL('./contrib/shadcn-solid/apps/docs/src/registry/$1', import.meta.url),
                ),
            },
            { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
        ],
    },
    optimizeDeps: {
        // Force-bundle the CJS leaves of the unified/remark/micromark stack so
        // esbuild synthesizes proper `default` exports. Without this, Vite serves
        // these CJS files raw and the ESM parents that do `import x from 'cjs-pkg'`
        // crash at runtime.
        //
        // Vite's `parent > child` syntax resolves the dep as it would be from the
        // parent — necessary in pnpm's nested layout where these aren't hoisted.
        include: [
            'solid-markdown > unified > extend',
            'solid-markdown > unified > bail',
            'solid-markdown > unified > is-plain-obj',
            'solid-markdown > unified > trough',
            'solid-markdown > unified > vfile',
            'solid-markdown > unified > vfile-message',
            'solid-markdown > micromark > debug',
            'solid-markdown > debug',
            'solid-markdown > mdast-util-from-markdown > mdast-util-to-string',
            'solid-markdown > mdast-util-from-markdown > unist-util-stringify-position',
            'solid-markdown > property-information',
            'solid-markdown > comma-separated-tokens',
            'solid-markdown > space-separated-tokens',
            'remark-gfm > mdast-util-gfm > mdast-util-find-and-replace',
        ],
        // Keep wa-sqlite out of esbuild's pre-bundle. We don't use the
        // Emscripten dist/*.mjs anymore — our own runtime fetches the
        // wasi-sdk-built /wa-sqlite.wasm from /public — but the package's
        // own JS surface (sqlite-api.js, FacadeVFS.js, examples/*VFS.js) ships
        // as plain ESM that imports via relative paths into the submodule.
        // Pre-bundling those collapses their import graph and breaks the
        // VFS example imports.
        exclude: ['wa-sqlite'],
    },
}));
