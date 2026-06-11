import { defineConfig, defaultClientConditions } from 'vite';
import { fileURLToPath } from 'node:url';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import solid from 'vite-plugin-solid';
import tailwindcss from '@tailwindcss/vite';
import { workerVersion } from './tools/vite-plugin-worker-version';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { tsxElementBabelPlugin, tsxLocator } from './contrib/vite-plugin-tsx-locator/src/index';

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

/// True when `dir` exists and contains at least one file. Used to gate the
/// viteStaticCopy targets: an empty/absent source folder makes the plugin throw
/// "No file was found to copy", which would break any build that legitimately
/// ships without that asset family — e.g. a production build with the ONNX
/// comparison assets (src/assets/transformers, `make onnx-models`) omitted, or
/// a fresh clone before `make demo-data`.
function dirHasFiles(dir: string): boolean {
    try {
        return collectFiles(dir).length > 0;
    } catch {
        return false;
    }
}

export default defineConfig(({ command }) => {
    const isProduction = 'production' == process.env.NODE_ENV;
    const projectRoot = fileURLToPath(new URL('.', import.meta.url));

    // The large static assets that are NOT part of Vite's bundle graph — the
    // demo .sqlite databases and the Transformers Worker's models + tokenizers
    // + ort wasm (copied verbatim by viteStaticCopy and fetched at runtime via
    // the injected *_ASSET_BASE globals) — get a path keyed by a content
    // checksum of their source folder, NOT a per-build version. An unchanged
    // asset therefore keeps the same URL across releases, so deploy/deploy.sh
    // can skip re-uploading it (no byte-identical copies ballooning the CDN).
    // The wa-sqlite/qjs/semantic engine wasm + bge-embed .gguf DO go through the
    // bundle (`new URL('@/assets/…', import.meta.url)`) and land under cache/
    // with a per-file content hash (see build.rollupOptions below) — the same
    // stable-URL guarantee at finer granularity. In dev everything stays under
    // `src/assets/...`; the checksum is computed only when bundling.
    const isServe = command === 'serve';
    const assetVersion = (rel: string): string =>
        isServe ? 'src/assets' : hashAssetDir(resolve(projectRoot, rel));
    const demoVersion = assetVersion('src/assets/demo');
    const transformersVersion = assetVersion('src/assets/transformers');
    // Root-relative bases injected as globals (below) and read at runtime by
    // demo-source.ts / transformers/worker.ts. Build: `/<hash>/demo`; dev:
    // `/src/assets/demo`.
    const DEMO_ASSET_BASE = `/${demoVersion}/demo`;
    const TRANSFORMERS_ASSET_BASE = `/${transformersVersion}/transformers`;

    // Only copy an asset family whose source folder actually has files — the
    // plugin errors on an empty glob. A production bundle built without the ONNX
    // comparison assets (INCLUDE_ONNX off / `make onnx-models` not run) ships no
    // src/assets/transformers, and that's fine: the /pii + /tests ONNX surfaces
    // simply 404 until those assets are built.
    const staticCopyTargets = [
        {
            src: 'src/assets/transformers/**',
            dest: `${transformersVersion}/transformers/`,
            rename: { stripBase: 3 },
            present: dirHasFiles(resolve(projectRoot, 'src/assets/transformers')),
        },
        {
            src: 'src/assets/demo/**',
            dest: `${demoVersion}/demo/`,
            rename: { stripBase: 3 },
            present: dirHasFiles(resolve(projectRoot, 'src/assets/demo')),
        },
    ]
        .filter((t) => t.present)
        .map(({ present: _present, ...t }) => t);

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

    // The build emits the RUNTIME config to the stable, un-hashed
    // `config/app-config.json` via the `rh-emit-runtime-config` plugin below —
    // NOT viteStaticCopy, which preserves a single file's source dir structure
    // (it landed at config/src/assets/config/…). A direct write gives the exact
    // output path. See src/lib/runtime/state/app-config-runtime.ts.
    const outDir = `dist/${isProduction ? 'production' : 'development'}`;

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
            viteStaticCopy({ targets: staticCopyTargets }),
            // Build: write the runtime config to the EXACT output path
            // `config/app-config.json` (the chosen catalog — authoritative at
            // runtime; the app embeds a fallback). A direct write avoids
            // viteStaticCopy's single-file dir-structure quirk.
            {
                name: 'rh-emit-runtime-config',
                apply: 'build',
                closeBundle() {
                    const cfgDir = resolve(projectRoot, outDir, 'config');
                    mkdirSync(cfgDir, { recursive: true });
                    writeFileSync(resolve(cfgDir, 'app-config.json'), readFileSync(appConfigPath));
                },
            },
            // Dev: serve `/config/app-config.json` (from the chosen catalog) so
            // `vite serve` exercises the same path the deployed build uses.
            {
                name: 'rh-runtime-config-dev',
                configureServer(server) {
                    server.middlewares.use((req, res, next) => {
                        const url = (req.url ?? '').split('?')[0];
                        if (url === '/config/app-config.json') {
                            res.setHeader('Content-Type', 'application/json');
                            res.setHeader('Cache-Control', 'no-store');
                            res.end(readFileSync(appConfigPath));
                            return;
                        }
                        next();
                    });
                },
            },
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
            // Every bundled output — JS entry + chunks, CSS, and emitted assets
            // (incl. the engine .wasm + bge-embed .gguf reached via
            // `new URL('@/assets/…', import.meta.url)`) — is content-addressed
            // under cache/. `[hash]` is a pure content hash, so a file whose
            // bytes are unchanged keeps the SAME URL across releases and
            // deploy/deploy.sh's rsync skips it. Only index.html carries
            // per-release paths; it is the unversioned entry point, uploaded
            // LAST after everything it references is already in place.
            rollupOptions: {
                output: {
                    assetFileNames: 'cache/[hash]-[name][extname]',
                    chunkFileNames: 'cache/[hash]-[name].js',
                    entryFileNames: 'cache/[hash]-[name].js',
                },
            },
        },
        // Worker bundles (wa-sqlite DedicatedWorker, transformers SharedWorker,
        // the probe/test workers) are produced by a separate rollup pass; route
        // them to the same content-addressed cache/ layout. Format is left at
        // Vite's default — only the output paths change.
        worker: {
            rollupOptions: {
                output: {
                    assetFileNames: 'cache/[hash]-[name][extname]',
                    chunkFileNames: 'cache/[hash]-[name].js',
                    entryFileNames: 'cache/[hash]-[name].js',
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
