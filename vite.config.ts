import { defineConfig, defaultClientConditions } from 'vite';
import { fileURLToPath } from 'node:url';
import { isAbsolute, resolve } from 'node:path';
import solid from 'vite-plugin-solid';
import tailwindcss from '@tailwindcss/vite';
import { workerVersion } from './tools/vite-plugin-worker-version';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { tsxElementBabelPlugin, tsxLocator } from './contrib/vite-plugin-tsx-locator/src/index';
import pkg from './package.json';

function bigintToBase62(val: bigint): string {
    // eslint-disable-next-line no-secrets/no-secrets
    const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    let result = '';
    const base = 62n;
    if (val < 0n) {
        val = val + 2n ** 64n;
    }
    while (val > 0) {
        let remainder = val % base;
        result = ALPHABET[Number(remainder)] + result;
        val = val / base;
    }
    return result || '0';
}

export default defineConfig(({ command }) => {
    const isProduction = 'production' == process.env.NODE_ENV;
    const APP_VERSION =
        command !== 'serve'
            ? `${pkg.version}-${bigintToBase62(BigInt(+new Date()))}`
            : 'src/assets';
    const projectRoot = fileURLToPath(new URL('.', import.meta.url));

    // The LLM provider/model catalog is seeded from a JSON config file chosen
    // at build time. `APP_CONFIG` (a project-relative or absolute path) wins;
    // otherwise default to the dev catalog under `vite serve` and the prod
    // catalog when bundling. The `@app-config` alias makes it importable from
    // settings-types.ts (see also vitest.config.ts, which pins the dev file).
    const defaultAppConfig =
        command === 'serve'
            ? 'src/assets/config/app-config.dev.json'
            : 'src/assets/config/app-config.prod.json';
    const appConfigEnv = process.env.APP_CONFIG;
    let appConfigPath: string;
    if (!appConfigEnv) {
        appConfigPath = resolve(projectRoot, defaultAppConfig);
    } else {
        appConfigPath = isAbsolute(appConfigEnv)
            ? appConfigEnv
            : resolve(projectRoot, appConfigEnv);
    }

    return {
        server: {
            port: 5173,
        },
        plugins: [
            solid(
                // click on element to navigate to vscode + inline element file/line
                command === 'serve'
                    ? { babel: { plugins: [tsxElementBabelPlugin({ root: projectRoot })] } }
                    : undefined,
            ),
            tsxLocator(),
            tailwindcss(),
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
            viteStaticCopy({
                targets: [
                    {
                        src: 'src/assets/tiny-pii/**',
                        dest: `${APP_VERSION}/tiny-pii/`,
                        rename: { stripBase: 3 },
                    },
                    {
                        src: 'src/assets/demo/**',
                        dest: `${APP_VERSION}/demo/`,
                        rename: { stripBase: 3 },
                    },
                ],
            }),
        ],
        publicDir: './public',
        build: {
            // Minify prod bundles (esbuild pass), and emit external source maps
            // so the minified output still resolves back to `src/...` in DevTools.
            // `sourcemap: true` writes standalone `.map` files referenced by a
            // `//# sourceMappingURL=` comment — the standard Source Map v3 format
            // Chrome DevTools consumes natively.
            minify: 'esbuild',
            sourcemap: true,

            target: 'esnext',
            outDir: `dist/${isProduction ? 'production' : 'development'}`,
            copyPublicDir: true,
            assetsDir: APP_VERSION,
        },
        // ECharts / zrender reference `global` (Node.js style) at module
        // top-level. In the main thread `window` rescues them via shims,
        // but in the runtime SharedWorker bundle there is no `window` and
        // no `global`, so the load crashes with "global is not defined".
        // Define both to `globalThis` so worker bundles compile cleanly.
        define: {
            global: 'globalThis',
            APP_VERSION: JSON.stringify(APP_VERSION),
        },
        resolve: {
            // Stop rolldown from emitting a phantom 23 MB
            // `ort-wasm-simd-threaded.asyncify-<hash>.wasm` into the bundle.
            //
            // Chain: src/lib/pii/worker.ts imports @huggingface/transformers,
            // whose web build (`transformers.web.js`) does a *static*
            // `import * as ONNX_WEB from "onnxruntime-web/webgpu"`. That
            // export's `default` condition resolves to the *bundle* variant
            // (`ort.webgpu.bundle.min.mjs`), which INLINES the emscripten glue
            // containing `new URL("ort-wasm-simd-threaded.asyncify.wasm",
            // import.meta.url)`. Vite/rolldown statically resolves that
            // `new URL(..., import.meta.url)` at build time and emits the 23 MB
            // wasm as a hashed asset — independent of (and ignored by) the
            // runtime `env.backends.onnx.wasm.wasmPaths` override in worker.ts,
            // so we'd ship the wasm twice (once dead).
            //
            // onnxruntime-web ships the `onnxruntime-web-use-extern-wasm`
            // export condition for exactly this: it resolves /webgpu to
            // `ort.webgpu.min.mjs`, which keeps the wasm external (loaded at
            // runtime from `wasmPaths`) and has no static `new URL`, so nothing
            // is emitted. Prepend it to Vite's client defaults (spread so we
            // don't drop `module`/`browser`/`development|production`).
            conditions: ['onnxruntime-web-use-extern-wasm', ...defaultClientConditions],
            alias: [
                {
                    find: /^@\/registry\/(.*)$/,
                    replacement: fileURLToPath(
                        new URL(
                            './contrib/shadcn-solid/apps/docs/src/registry/$1',
                            import.meta.url,
                        ),
                    ),
                },
                { find: '@app-config', replacement: appConfigPath },
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
    };
});
