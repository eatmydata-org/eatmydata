import { defineConfig, defaultClientConditions } from 'vite';
import { fileURLToPath } from 'node:url';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
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
        const remainder = val % base;
        result = ALPHABET[Number(remainder)] + result;
        val = val / base;
    }
    return result || '0';
}

/// Dir-relative file paths under `dir`, recursively, sorted per level.
function collectFiles(dir: string, base = dir): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir).sort()) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
            out.push(...collectFiles(full, base));
        } else {
            out.push(relative(base, full));
        }
    }
    return out;
}

/// 16-char content checksum of every file under `dir`, folding each file's
/// dir-relative path and bytes into the digest (so a rename or an edit moves
/// the hash). Gives a large static-asset folder a URL that stays untouched
/// across releases while its content is unchanged — letting deploy/deploy.sh
/// skip re-uploading it. Returns `'unbuilt'` (with a loud warning) when the
/// folder is missing, preserving the prior "build succeeds, runtime 404s"
/// behavior for assets that haven't been generated yet.
function hashAssetDir(dir: string): string {
    let files: string[];
    try {
        files = collectFiles(dir);
    } catch (err) {
        console.warn(
            `[asset-hash] ${dir} missing/unreadable (${String(err)}); using 'unbuilt'. ` +
                `Run the matching make target (demo-data / transformers / wa-sqlite) to populate it.`,
        );
        return 'unbuilt';
    }
    const h = createHash('sha256');
    for (const rel of files.sort()) {
        h.update(rel);
        h.update(readFileSync(join(dir, rel)));
    }
    return h.digest('hex').slice(0, 16);
}

export default defineConfig(({ command }) => {
    const isProduction = 'production' == process.env.NODE_ENV;
    const APP_VERSION =
        command !== 'serve'
            ? `${pkg.version}-${bigintToBase62(BigInt(+new Date()))}`
            : 'src/assets';
    const projectRoot = fileURLToPath(new URL('.', import.meta.url));

    // Large static assets (the demo .sqlite databases, the Transformers
    // Worker's models + tokenizers + ort wasm, and the wa-sqlite/qjs engine
    // wasm) get a path keyed by a content checksum of their source folder —
    // NOT the per-build APP_VERSION. An unchanged asset therefore keeps the
    // same URL across releases, so deploy/deploy.sh can skip re-uploading it
    // (and we don't balloon the CDN with byte-identical copies under fresh
    // timestamps). In dev they stay under `src/assets/...` exactly as before;
    // the checksum is computed only when bundling, never under `vite serve`.
    const isServe = command === 'serve';
    const assetVersion = (rel: string): string =>
        isServe ? 'src/assets' : hashAssetDir(resolve(projectRoot, rel));
    const demoVersion = assetVersion('src/assets/demo');
    const transformersVersion = assetVersion('src/assets/transformers');
    const wasmVersion = assetVersion('src/assets/wasm');
    // Root-relative bases injected as globals (below) and read at runtime by
    // demo-source.ts / transformers/worker.ts. Build: `/<hash>/demo`; dev:
    // `/src/assets/demo`.
    const DEMO_ASSET_BASE = `/${demoVersion}/demo`;
    const TRANSFORMERS_ASSET_BASE = `/${transformersVersion}/transformers`;

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
            watch: {
                // A Chrome instance launched for CDP debugging keeps its
                // --user-data-dir under the repo root (chrome-debug-profile/)
                // and rewrites its Cache/History/Sessions hundreds of times a
                // second. Vite's watcher treats each write as a source change
                // and fires a full page reload — an infinite reload loop that
                // also pegs the dev server near 100% CPU. Exclude it (Vite
                // keeps its built-in node_modules/.git ignores; this appends).
                ignored: ['**/chrome-debug-profile/**'],
            },
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
                { key: 'transformers', dir: 'src/lib/transformers', exclude: ['client.ts'] },
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
                        src: 'src/assets/transformers/**',
                        dest: `${transformersVersion}/transformers/`,
                        rename: { stripBase: 3 },
                    },
                    {
                        src: 'src/assets/demo/**',
                        dest: `${demoVersion}/demo/`,
                        rename: { stripBase: 3 },
                    },
                ],
            }),
        ],
        publicDir: './public',
        // .gguf (bge-embed model weights) isn't a built-in Vite asset type;
        // register it so `new URL('@/assets/models/*.gguf', import.meta.url)` in
        // src/lib/bge-embed/runtime.ts is emitted + served as a hashed asset.
        assetsInclude: ['**/*.gguf'],
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
            // App JS/CSS chunks + non-wasm assets stay under the per-build
            // APP_VERSION folder (they change every release anyway). The wasm
            // engine binaries (wa-sqlite.wasm, qjs.wasm) are routed to their
            // own content-checksum folder so an unchanged engine build keeps a
            // stable URL across releases — the `new URL('@/assets/wasm/…',
            // import.meta.url)` references in runtime.ts / qjs.ts pick up this
            // emitted path automatically.
            assetsDir: APP_VERSION,
            rollupOptions: {
                output: {
                    assetFileNames: (info) => {
                        const meta = info as { names?: string[]; name?: string };
                        const names = meta.names ?? (meta.name ? [meta.name] : []);
                        // Large engine binaries — wasm + the bge-embed .gguf weights —
                        // go to the content-checksum folder so an unchanged build keeps
                        // a stable URL across releases (no 67 MB re-download per deploy).
                        const isEngineBinary = names.some(
                            (n) => n.endsWith('.wasm') || n.endsWith('.gguf'),
                        );
                        return isEngineBinary
                            ? `${wasmVersion}/[name]-[hash][extname]`
                            : `${APP_VERSION}/[name]-[hash][extname]`;
                    },
                },
            },
        },
        // ECharts / zrender reference `global` (Node.js style) at module
        // top-level. In the main thread `window` rescues them via shims,
        // but in the runtime SharedWorker bundle there is no `window` and
        // no `global`, so the load crashes with "global is not defined".
        // Define both to `globalThis` so worker bundles compile cleanly.
        define: {
            global: 'globalThis',
            DEMO_ASSET_BASE: JSON.stringify(DEMO_ASSET_BASE),
            TRANSFORMERS_ASSET_BASE: JSON.stringify(TRANSFORMERS_ASSET_BASE),
        },
        resolve: {
            // Stop rolldown from emitting a phantom 23 MB
            // `ort-wasm-simd-threaded.asyncify-<hash>.wasm` into the bundle.
            //
            // Chain: src/lib/transformers/worker.ts imports @huggingface/transformers,
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
