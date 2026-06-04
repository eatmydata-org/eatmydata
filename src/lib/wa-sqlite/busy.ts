/**
 * SQLITE_BUSY / SQLITE_LOCKED handling for the multi-tab OPFS stack.
 *
 * OPFSCoopSyncVFS time-shares a single exclusive OPFS access handle between
 * tabs (Web Lock + BroadcastChannel handoff). wa-sqlite's JS layer retries a
 * pending handle acquisition only twice (`retry()` in sqlite-api.js), so under
 * cross-tab contention a transient `SQLITE_BUSY` can still surface to us. There
 * is no usable SQLite busy-handler path here (the VFS resolves BUSY in JS, not
 * via the C-level busy handler that `PRAGMA busy_timeout` installs), so we add
 * the backoff at the application layer instead.
 */
import * as SQLite from 'wa-sqlite';
import { randomInt } from '@/lib/random';

/** True if `e` is a wa-sqlite SQLITE_BUSY (5) / SQLITE_LOCKED (6) error. */
export function isBusyError(e: unknown): boolean {
    return (
        e instanceof SQLite.SQLiteError &&
        (e.code === SQLite.SQLITE_BUSY || e.code === SQLite.SQLITE_LOCKED)
    );
}

export interface RetryOnBusyOptions {
    /** Total attempts including the first. */
    tries?: number;
    /** Base backoff in ms; grows ~exponentially with jitter. */
    base?: number;
}

/**
 * Run `fn`, retrying with exponential backoff + jitter **only** on
 * SQLITE_BUSY/LOCKED. Any other error propagates immediately. After the last
 * attempt the busy error is rethrown unchanged so callers see the real cause.
 */
export async function retryOnBusy<T>(
    fn: () => Promise<T>,
    { tries = 6, base = 25 }: RetryOnBusyOptions = {},
): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < tries; attempt++) {
        try {
            return await fn();
        } catch (e) {
            if (!isBusyError(e)) throw e;
            lastErr = e;
            if (attempt === tries - 1) break;
            const delay = base * 2 ** attempt + randomInt(base);
            await new Promise((resolve) => setTimeout(resolve, delay));
        }
    }
    throw lastErr;
}
