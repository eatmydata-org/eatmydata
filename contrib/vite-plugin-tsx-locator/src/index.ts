/// `vite-plugin-tsx-locator` — dev-only "where did this DOM come from" tooling
/// for SolidJS apps. Two halves:
///
///   1. `tsxElementBabelPlugin({ root })` — a Babel plugin you pass into
///      vite-plugin-solid's babel pipeline. It stamps each component's root
///      element with `data-tsx-element="Component@relpath:line"`.
///
///   2. `tsxLocator()` — a Vite plugin (serve only) that injects a tiny runtime
///      into the page: Shift+Alt+click any element to open the owning
///      component's source in your editor, plus a small bottom-right reminder.
///
/// Wiring (in vite.config.ts):
///
///   import solid from 'vite-plugin-solid'
///   import { tsxElementBabelPlugin, tsxLocator } from '<this package>'
///
///   plugins: [
///     solid(command === 'serve'
///       ? { babel: { plugins: [tsxElementBabelPlugin({ root: projectRoot })] } }
///       : undefined),
///     tsxLocator(),
///   ]
///
/// Nothing ships to production: the Babel plugin is only added in `serve`, and
/// `tsxLocator` is `apply: 'serve'`.

import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

export { tsxElementBabelPlugin } from './babel-plugin';

export function tsxLocator(): Plugin {
    // Absolute path to the browser runtime, resolved relative to THIS module.
    // Vite's config loader rewrites `import.meta.url` to the original file, so
    // this points at the real on-disk `runtime.js` even when the config is
    // bundled. POSIX separators for the `/@fs/` URL.
    const runtimePath = fileURLToPath(new URL('../runtime.js', import.meta.url)).split('\\').join('/');

    return {
        name: 'tsx-locator',
        apply: 'serve',
        transformIndexHtml(_html, ctx) {
            // Pass the project root to the runtime via a query param so it can
            // build absolute `vscode://file/…` links from the relative paths in
            // `data-tsx-element`. `/@fs/` lets Vite serve the runtime by path.
            const root = ctx.server?.config.root ?? process.cwd();
            const src = `/@fs${runtimePath}?root=${encodeURIComponent(root)}`;
            return [
                {
                    tag: 'script',
                    attrs: { type: 'module', src },
                    injectTo: 'body',
                },
            ];
        },
    };
}
