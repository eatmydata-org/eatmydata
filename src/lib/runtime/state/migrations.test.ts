import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openDB, deleteDB } from 'idb';
import { SETTINGS_KEY } from '@/lib/storage';
import { runMigrations } from './migrations';

// migrations.ts opens/deletes IndexedDB; mock `idb` so we can exercise the
// settings IDB→localStorage transfer without a real IndexedDB (vitest runs under
// `node`). localStorage is the in-memory polyfill from src/test-setup.ts.
vi.mock('idb', () => ({ openDB: vi.fn(), deleteDB: vi.fn() }));

const APPLIED_KEY = 'analyst:migrations';
const MIGRATION_ID = 'settings-idb-to-localstorage';

function fakeDb(opts: { hasStore: boolean; stored?: unknown }) {
    return {
        objectStoreNames: { contains: (s: string) => opts.hasStore && s === 'kv' },
        get: vi.fn(async () => opts.stored),
        close: vi.fn(),
    };
}

function appliedIds(): string[] {
    const raw = localStorage.getItem(APPLIED_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
}

beforeEach(() => {
    localStorage.clear();
    vi.mocked(deleteDB).mockReset().mockResolvedValue(undefined);
    vi.mocked(openDB).mockReset();
});

describe('runMigrations — settings IDB → localStorage', () => {
    it('transfers existing IDB settings to localStorage, deletes the DB, marks applied', async () => {
        const stored = { piiEnabled: false, agentModels: { coder: 'openrouter:x' } };
        vi.mocked(openDB).mockResolvedValue(fakeDb({ hasStore: true, stored }) as never);

        await runMigrations();

        expect(JSON.parse(localStorage.getItem(SETTINGS_KEY)!)).toEqual(stored);
        expect(deleteDB).toHaveBeenCalledTimes(1);
        expect(appliedIds()).toContain(MIGRATION_ID);
    });

    it('is a no-op for a fresh user (no old store) but still deletes + marks applied', async () => {
        vi.mocked(openDB).mockResolvedValue(fakeDb({ hasStore: false }) as never);

        await runMigrations();

        expect(localStorage.getItem(SETTINGS_KEY)).toBeNull();
        expect(deleteDB).toHaveBeenCalledTimes(1);
        expect(appliedIds()).toContain(MIGRATION_ID);
    });

    it('skips the IDB entirely when localStorage settings already exist', async () => {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify({ piiEnabled: true }));

        await runMigrations();

        expect(openDB).not.toHaveBeenCalled();
        expect(deleteDB).not.toHaveBeenCalled();
        expect(appliedIds()).toContain(MIGRATION_ID); // marked applied (idempotent)
    });

    it('is idempotent: a second run does nothing (already applied)', async () => {
        vi.mocked(openDB).mockResolvedValue(
            fakeDb({ hasStore: true, stored: { piiEnabled: false } }) as never,
        );
        await runMigrations();
        vi.mocked(openDB).mockClear();
        vi.mocked(deleteDB).mockClear();

        await runMigrations();

        expect(openDB).not.toHaveBeenCalled();
        expect(deleteDB).not.toHaveBeenCalled();
    });

    it('does not mark applied if the transfer throws (retries next load)', async () => {
        vi.mocked(openDB).mockResolvedValue(
            fakeDb({ hasStore: true, stored: { piiEnabled: false } }) as never,
        );
        // setItem throws (e.g. quota) → migration fails → not marked. Spy on the
        // stub instance (our polyfill defines setItem on the object, not a prototype).
        const setItem = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
            throw new Error('quota');
        });
        // Silence the expected error log.
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});

        await runMigrations();

        expect(appliedIds()).not.toContain(MIGRATION_ID);
        setItem.mockRestore();
        err.mockRestore();
    });
});
