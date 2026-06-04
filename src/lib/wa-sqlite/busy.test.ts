/**
 * Vitest coverage for the SQLITE_BUSY/LOCKED retry helper. Pure logic — no
 * OPFS or workers — so it runs in vitest's node environment.
 */
import { describe, expect, it } from 'vitest';
import * as SQLite from 'wa-sqlite';
import { isBusyError, retryOnBusy } from './busy';

const busy = () => new SQLite.SQLiteError('database is locked', SQLite.SQLITE_BUSY);
const locked = () => new SQLite.SQLiteError('database is locked', SQLite.SQLITE_LOCKED);

describe('isBusyError', () => {
    it('is true for SQLITE_BUSY (5) and SQLITE_LOCKED (6)', () => {
        expect(isBusyError(busy())).toBe(true);
        expect(isBusyError(locked())).toBe(true);
    });

    it('is false for other SQLite codes and non-SQLite errors', () => {
        expect(isBusyError(new SQLite.SQLiteError('syntax error', 1))).toBe(false);
        expect(isBusyError(new Error('boom'))).toBe(false);
        expect(isBusyError('nope')).toBe(false);
        expect(isBusyError(undefined)).toBe(false);
    });
});

describe('retryOnBusy', () => {
    it('returns the result without retrying on success', async () => {
        let calls = 0;
        const r = await retryOnBusy(async () => {
            calls++;
            return 42;
        });
        expect(r).toBe(42);
        expect(calls).toBe(1);
    });

    it('retries on busy and then succeeds', async () => {
        let calls = 0;
        const r = await retryOnBusy(
            async () => {
                calls++;
                if (calls < 3) throw busy();
                return 'ok';
            },
            { tries: 5, base: 1 },
        );
        expect(r).toBe('ok');
        expect(calls).toBe(3);
    });

    it('does not retry a non-busy error', async () => {
        let calls = 0;
        await expect(
            retryOnBusy(
                async () => {
                    calls++;
                    throw new Error('syntax error');
                },
                { tries: 5, base: 1 },
            ),
        ).rejects.toThrow('syntax error');
        expect(calls).toBe(1);
    });

    it('rethrows the busy error unchanged after exhausting tries', async () => {
        let calls = 0;
        await expect(
            retryOnBusy(
                async () => {
                    calls++;
                    throw busy();
                },
                { tries: 3, base: 1 },
            ),
        ).rejects.toMatchObject({ code: SQLite.SQLITE_BUSY });
        expect(calls).toBe(3);
    });
});
