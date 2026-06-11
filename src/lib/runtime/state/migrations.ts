import { openDB, deleteDB } from 'idb';
import { SETTINGS_KEY, STORAGE_VERSION } from '@/lib/storage';

/**
 * App-level storage migrations — a single, general init step run ONCE at boot
 * (see `runMigrations()` awaited in src/index.tsx, before `render()` and before
 * anything reads persisted state). Each migration is id-keyed and idempotent;
 * applied ids are tracked in localStorage so a one-off transfer runs once ever.
 * The framework also accommodates future IndexedDB schema upgrades or other
 * store transfers — add an entry to `MIGRATIONS`.
 *
 * IMPORTANT: this module must NOT import `settings.ts` (or anything that does).
 * `settings.ts` reads localStorage synchronously at module init; keeping it out
 * of this module's import graph is what lets `runMigrations()` finish before the
 * settings store is ever evaluated.
 *
 * Atomicity is best-effort (IndexedDB + localStorage can't be transactionally
 * atomic): each migration is idempotent and only marked applied AFTER it
 * succeeds, so a failure mid-way simply retries on the next load.
 */

interface Migration {
    id: string;
    run: () => Promise<void>;
}

/** localStorage key holding the JSON array of applied migration ids (unversioned). */
const APPLIED_KEY = 'analyst:migrations';

const MIGRATIONS: Migration[] = [
    { id: 'settings-idb-to-localstorage', run: migrateSettingsIdbToLocalStorage },
];

function getApplied(): Set<string> {
    try {
        const raw = localStorage.getItem(APPLIED_KEY);
        const arr: unknown = raw ? JSON.parse(raw) : [];
        return new Set(
            Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [],
        );
    } catch (e) {
        console.error('[migrations] reading applied set failed:', e);
        return new Set();
    }
}

function markApplied(id: string): void {
    const applied = getApplied();
    applied.add(id);
    try {
        localStorage.setItem(APPLIED_KEY, JSON.stringify([...applied]));
    } catch (e) {
        console.error(`[migrations] persisting applied id "${id}" failed:`, e);
    }
}

/**
 * Run every not-yet-applied migration in order. Never rejects — a failing
 * migration is logged and left unmarked (retried next load) so boot proceeds.
 */
export async function runMigrations(): Promise<void> {
    const applied = getApplied();
    for (const m of MIGRATIONS) {
        if (applied.has(m.id)) continue;
        try {
            await m.run();
            markApplied(m.id);
        } catch (e) {
            console.error(`[migrations] "${m.id}" failed; will retry next load:`, e);
        }
    }
}

const OLD_SETTINGS_DB = `analyst-settings:v${STORAGE_VERSION}`;
const OLD_SETTINGS_STORE = 'kv';
const OLD_SETTINGS_RECORD = 'settings';

/**
 * Settings used to live in IndexedDB; they now persist to localStorage (so they
 * can be read synchronously at boot — no flicker). Copy the stored value verbatim
 * to localStorage (the settings store runs it through `mergeWithDefaults` on
 * read), then delete the old IndexedDB database completely. Idempotent: a no-op
 * once localStorage already holds settings.
 */
async function migrateSettingsIdbToLocalStorage(): Promise<void> {
    if (localStorage.getItem(SETTINGS_KEY) !== null) return; // already in localStorage

    let stored: unknown;
    try {
        const db = await openDB(OLD_SETTINGS_DB); // no version → don't trigger an upgrade
        try {
            if (db.objectStoreNames.contains(OLD_SETTINGS_STORE)) {
                stored = await db.get(OLD_SETTINGS_STORE, OLD_SETTINGS_RECORD);
            }
        } finally {
            db.close();
        }
    } catch (e) {
        // Couldn't open / read the old DB — nothing to copy; still delete below.
        console.warn(`[migrations] could not read old settings IDB (${OLD_SETTINGS_DB}):`, e);
    }

    if (stored !== undefined && stored !== null) {
        // May throw (quota / private mode) — let it propagate so the migration is
        // NOT marked applied and retries next load (and the IDB stays for retry).
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(stored));
    }

    // Remove the settings IndexedDB completely (whether or not data was found).
    try {
        await deleteDB(OLD_SETTINGS_DB);
    } catch (e) {
        console.warn(`[migrations] deleting old settings IDB (${OLD_SETTINGS_DB}) failed:`, e);
    }
}
