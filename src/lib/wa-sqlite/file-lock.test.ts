/**
 * Vitest coverage for the VFS file-lock helper. The lock-name derivation is
 * pure and load-bearing (it must match OPFSCoopSyncVFS's `ahp:/<path>`); the
 * fallback behaviour is checked too, since vitest's node environment has no
 * Web Locks API (so the helpers run `fn` directly). Real cross-tab contention
 * lives in the browser testbed (`src/lib/test-runner/tests-wa-sqlite.ts`).
 */
import { describe, expect, it } from 'vitest';
import { vfsLockName, withVfsFileLock, tryWithVfsFileLock, SKIPPED } from './file-lock';

describe('vfsLockName', () => {
    it('matches OPFSCoopSyncVFS ahp:/<leaf> convention for a root file', () => {
        expect(vfsLockName('ds_abc.sqlite')).toBe('ahp:/ds_abc.sqlite');
    });
});

describe('fallback without Web Locks (node env)', () => {
    it('withVfsFileLock runs fn directly and returns its value', async () => {
        let ran = false;
        const r = await withVfsFileLock('x.sqlite', async () => {
            ran = true;
            return 7;
        });
        expect(ran).toBe(true);
        expect(r).toBe(7);
    });

    it('tryWithVfsFileLock runs fn (never SKIPPED) when no locks exist', async () => {
        const r = await tryWithVfsFileLock('x.sqlite', async () => 'done');
        expect(r).toBe('done');
        expect(r).not.toBe(SKIPPED);
    });
});
