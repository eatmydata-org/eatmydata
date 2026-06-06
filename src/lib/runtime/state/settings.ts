import { openDB, type IDBPDatabase } from 'idb';
import {
    defaultSettings,
    findModelEntryIn,
    mergeWithDefaults,
    type ModelEntry,
    type Settings,
} from './settings-types';
import { publish } from './broadcast';
import { STORAGE_VERSION } from '@/lib/storage';

/**
 * Tab-side settings store. Owns reads/writes to a dedicated IndexedDB
 * database and broadcasts patches to all connected tabs (including a
 * self-delivery to the writing tab via `publish`).
 *
 * Boot is async (IDB is async). Callers that need post-load state must
 * await `whenReady()` before reading `getSettings()`. The runtime host
 * awaits it before any handler that touches settings.
 */

const DB_NAME = `analyst-settings:v${STORAGE_VERSION}`;
const DB_VERSION = 1;
const STORE = 'kv';
const KEY = 'settings';

let dbPromise: Promise<IDBPDatabase> | null = null;

function openSettingsDb(): Promise<IDBPDatabase> {
    if (!dbPromise) {
        dbPromise = openDB(DB_NAME, DB_VERSION, {
            upgrade(db) {
                if (!db.objectStoreNames.contains(STORE)) {
                    db.createObjectStore(STORE);
                }
            },
        });
    }
    return dbPromise;
}

let settings: Settings = defaultSettings();

const ready: Promise<void> = (async () => {
    const db = await openSettingsDb();
    const stored = (await db.get(STORE, KEY)) as Partial<Settings> | undefined;
    if (stored) settings = mergeWithDefaults(stored);
})();

ready.catch((e) => {
    // Loud failure: persistence is broken, the user will lose
    // settings on the next refresh. Surface it in the console
    // rather than letting them rediscover it by losing data.
    console.error('[settings] initial load from IDB failed:', e);
});

/** Resolves once the initial load from IDB has settled. */
export function whenReady(): Promise<void> {
    return ready;
}

export function getSettings(): Settings {
    return settings;
}

export function patchSettings(patch: Partial<Settings>): void {
    // Callers may hand us Solid store proxies — the Settings UI maps over the
    // live `providers` store to build a patch. Both `persist` (IDB `put`) and
    // the broadcast self-delivery use `structuredClone`, which throws
    // `DataCloneError` on a proxy: the patch would then neither save nor reach
    // the tab mirror. Settings is fully JSON-serializable (it's what we
    // persist), so a JSON round-trip losslessly normalizes the patch — and
    // every value `mergeWithDefaults` carries forward — to a plain graph.
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
    void persist(settings);
}

export function resetSettings(): void {
    settings = defaultSettings();
    publish({ kind: 'settings-patch', patch: settings });
    void persist(settings);
}

async function persist(s: Settings): Promise<void> {
    try {
        const db = await openSettingsDb();
        // The provider/model catalog is build-time config (@app-config), never
        // user state — persist everything EXCEPT the derived `providers`. Only
        // `apiKeys` carries provider-related state into IDB; on load
        // `mergeWithDefaults` rebuilds `providers` from the catalog + keys.
        const { providers: _omitProviders, ...persistable } = s;
        void _omitProviders;
        await db.put(STORE, persistable, KEY);
    } catch (e) {
        // Quota exceeded / private-browsing / disabled storage / etc.
        // Don't swallow — settings will silently revert on refresh
        // otherwise, which is exactly the bug this module just fixed.
        console.error('[settings] persist to IDB failed:', e);
    }
}

export function findModelEntry(id: string): ModelEntry {
    return findModelEntryIn(settings.providers, id);
}
