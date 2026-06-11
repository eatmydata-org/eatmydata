import {
    defaultSettings,
    findModelEntryIn,
    mergeWithDefaults,
    type ModelEntry,
    type Settings,
} from './settings-types';
import { publish } from './broadcast';
import { SETTINGS_KEY } from '@/lib/storage';

/**
 * Tab-side settings store. Persists to **localStorage** (synchronous) and
 * broadcasts patches to all connected tabs (including a self-delivery to the
 * writing tab via `publish`).
 *
 * localStorage (not IndexedDB) so the persisted settings are read SYNCHRONOUSLY
 * at module init — the tab mirror seeds from the fully-merged settings on the
 * first paint, with no async hydration flicker. Settings are main-thread only
 * (no worker touches this module), so localStorage is safe here. Any existing
 * IndexedDB settings are moved to localStorage once by the storage migration
 * (migrations.ts), which runs before this module is imported.
 */

/** Read + merge persisted settings synchronously; `defaultSettings()` on miss. */
function loadSettings(): Settings {
    let raw: string | null = null;
    try {
        raw = localStorage.getItem(SETTINGS_KEY);
    } catch (e) {
        // Private browsing / disabled storage. Don't swallow — surface it.
        console.error('[settings] read from localStorage failed:', e);
    }
    if (!raw) return defaultSettings();
    try {
        return mergeWithDefaults(JSON.parse(raw) as Partial<Settings>);
    } catch (e) {
        console.error('[settings] stored settings are not valid JSON; using defaults:', e);
        return defaultSettings();
    }
}

let settings: Settings = loadSettings();

// Settings load synchronously above, so there is nothing async to await. Kept
// for API compatibility (the runtime host awaits it before settings handlers).
const ready: Promise<void> = Promise.resolve();

/** Resolves once the initial load has settled (synchronous now → already done). */
export function whenReady(): Promise<void> {
    return ready;
}

export function getSettings(): Settings {
    return settings;
}

export function patchSettings(patch: Partial<Settings>): void {
    // Callers may hand us Solid store proxies — the Settings UI maps over the
    // live `providers` store to build a patch. Both `persist` and the broadcast
    // self-delivery use `structuredClone`, which throws `DataCloneError` on a
    // proxy: the patch would then neither save nor reach the tab mirror. Settings
    // is fully JSON-serializable (it's what we persist), so a JSON round-trip
    // losslessly normalizes the patch — and every value `mergeWithDefaults`
    // carries forward — to a plain graph.
    const plain = JSON.parse(JSON.stringify(patch)) as Partial<Settings>;
    settings = mergeWithDefaults({ ...settings, ...plain });
    // `providers` is derived (the @app-config catalog + persisted keys), so a
    // patch that touches keys — or carries a providers/pricing change — must
    // hand peer mirrors the freshly-merged `providers` (+ `apiKeys`); they don't
    // re-derive. Other patches broadcast verbatim.
    const touchesProviders = 'apiKeys' in plain || 'providers' in plain;
    const broadcastPatch: Partial<Settings> = touchesProviders
        ? { ...plain, apiKeys: settings.apiKeys, providers: settings.providers }
        : plain;
    publish({ kind: 'settings-patch', patch: broadcastPatch });
    persist(settings);
}

export function resetSettings(): void {
    settings = defaultSettings();
    publish({ kind: 'settings-patch', patch: settings });
    persist(settings);
}

function persist(s: Settings): void {
    try {
        // The provider/model catalog is config (@app-config / runtime config),
        // never user state — persist everything EXCEPT the derived `providers`.
        // On load `mergeWithDefaults` rebuilds `providers` from the catalog + keys.
        const { providers: _omitProviders, ...persistable } = s;
        void _omitProviders;
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(persistable));
    } catch (e) {
        // Quota exceeded / private-browsing / disabled storage / etc.
        // Don't swallow — settings would silently revert on refresh otherwise.
        console.error('[settings] persist to localStorage failed:', e);
    }
}

export function findModelEntry(id: string): ModelEntry {
    return findModelEntryIn(settings.providers, id);
}
