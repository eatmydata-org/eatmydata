/**
 * Runtime application config — the module that manages "which config the app
 * uses", with two sources:
 *
 *  1. BUNDLED DEFAULT — `import embeddedCatalog from '@app-config'`. The build
 *     picks the file (dev vs prod) behind the `@app-config` alias (see
 *     vite.config.ts). Always present; the fallback.
 *
 *  2. RUNTIME OVERRIDE — `window.__APP_CONFIG__`, set by a BLOCKING inline
 *     script in index.html that runs BEFORE this bundle. On any host that is NOT
 *     the official *.eatmydata.ai site it synchronously loads
 *     `/config/app-config.json` into that global. (eatmydata.ai skips it and
 *     uses the bundled default; the public bucket ships no /config — see
 *     deploy/deploy.sh.)
 *
 * Resolution: use (2) when it's defined and well-formed, else (1). This is read
 * SYNCHRONOUSLY at module init — the index.html bootstrap has already run — so
 * `getActiveCatalog()` is correct from its very first call and the first paint
 * never flickers.
 *
 * In unit tests / Node there is no `window`, so the getter returns the embedded
 * `@app-config` (the vitest fixture).
 */
import embeddedCatalog from '@app-config';
import type { AppConfig } from '@app-config';

declare global {
    interface Window {
        /** Catalog stashed by index.html's bootstrap (self-hosted origins only). */
        __APP_CONFIG__?: unknown;
    }
}

/** The runtime override from index.html's bootstrap, else the bundled default. */
function resolveCatalog(): AppConfig {
    const g = typeof window !== 'undefined' ? window.__APP_CONFIG__ : undefined;
    if (g && typeof g === 'object' && Array.isArray((g as AppConfig).providers)) {
        return g as AppConfig;
    }
    return embeddedCatalog;
}

// Resolved ONCE, synchronously, at module init — the index.html bootstrap has
// already populated the global (it runs before this bundle).
const activeCatalog: AppConfig = resolveCatalog();

/** The active provider/model catalog (runtime `/config/app-config.json`, else embedded). */
export function getActiveCatalog(): AppConfig {
    return activeCatalog;
}
