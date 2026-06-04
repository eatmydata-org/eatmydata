/**
 * Cross-tab coordination for *raw* OPFS file operations that bypass the VFS.
 *
 * `importIntoOpfs` (direct SyncAccessHandle write) and `destroyOpfs`
 * (`removeEntry`) touch a database file directly, not through
 * OPFSCoopSyncVFS. The VFS holds the DB's access handle in **exclusive**
 * `'readwrite'` mode (see `contrib/wa-sqlite/src/examples/OPFSCoopSyncVFS.js`
 * line ~529: `createSyncAccessHandle()` with no mode), which cannot coexist
 * with *any* other handle. So a raw write/remove while a peer tab's VFS holds
 * the handle throws `NoModificationAllowedError` — the intermittent "locked".
 *
 * The VFS coordinates handle ownership with a Web Lock **and** a
 * BroadcastChannel, both named `ahp:<vfsPath>` — a waiting context posts on
 * the channel to nudge the holder, which yields its handle (and releases the
 * lock) on its next idle moment. We replicate exactly that waiter here: nudge
 * peers, take the same Web Lock, and only then run the raw op. While we hold
 * the lock, no peer VFS can (re)acquire the handle, so even an exclusive raw
 * handle is safe. This is the `readwrite-unsafe` + Web-Lock pattern that
 * `OPFSAdaptiveVFS` uses (its lines 119 + 107) — applied at the app layer.
 *
 * Pin: the `ahp:<path>` naming and the nudge-to-yield protocol are read from
 * OPFSCoopSyncVFS. If `git submodule update --remote contrib/wa-sqlite` ever
 * changes them, this module must be re-synced.
 */

/** Sentinel returned by {@link tryWithVfsFileLock} when a live peer holds the file. */
export const SKIPPED = Symbol('vfs-file-lock-skipped');

/** How often we re-nudge peers to yield while waiting (VFS itself uses 1000ms). */
const NUDGE_INTERVAL_MS = 100;

/**
 * The Web-Lock / BroadcastChannel name OPFSCoopSyncVFS uses for a root-level
 * OPFS leaf. The VFS path of a file opened as `<leaf>` is `/<leaf>`
 * (`new URL(zName, 'file://').pathname`), and both its lock and its channel
 * are named `ahp:${path}`.
 */
export function vfsLockName(leaf: string): string {
    return `ahp:/${leaf}`;
}

function hasWebLocks(): boolean {
    return (
        typeof navigator !== 'undefined' &&
        typeof navigator.locks?.request === 'function' &&
        typeof BroadcastChannel !== 'undefined'
    );
}

/**
 * Acquire exclusive ownership of `leaf`'s OPFS file (mutually exclusive with
 * every tab's VFS handle), run `fn`, then release. Blocks until peers yield.
 *
 * The caller MUST have closed its *own* VFS connection for this file first —
 * a BroadcastChannel does not deliver to the sender, so our nudge can't make
 * our own VFS yield, and we'd self-deadlock waiting on a lock we hold.
 */
export async function withVfsFileLock<T>(leaf: string, fn: () => Promise<T>): Promise<T> {
    if (!hasWebLocks()) return fn();
    const name = vfsLockName(leaf);
    const channel = new BroadcastChannel(name);
    const nudge = () => channel.postMessage(null);
    nudge(); // immediate, like the VFS's `setTimeout(notify)`
    const timer = setInterval(nudge, NUDGE_INTERVAL_MS);
    try {
        return await navigator.locks.request(name, async () => {
            clearInterval(timer); // we own it; stop nudging
            return fn();
        });
    } finally {
        clearInterval(timer);
        channel.close();
    }
}

/**
 * Like {@link withVfsFileLock} but non-blocking: if *any* context (peer or
 * local) currently holds the file's VFS handle, return {@link SKIPPED} instead
 * of forcing a yield. Used by boot-cleanup so it never deletes a file a live
 * tab is using. Does NOT nudge — a held lock means "in use, leave it alone".
 */
export async function tryWithVfsFileLock<T>(
    leaf: string,
    fn: () => Promise<T>,
): Promise<T | typeof SKIPPED> {
    if (!hasWebLocks()) return fn();
    const name = vfsLockName(leaf);
    return navigator.locks.request(name, { ifAvailable: true }, async (lock) =>
        lock ? fn() : SKIPPED,
    );
}
