import * as Comlink from 'comlink';
import { WaSqliteDb } from './db';
import type { SqliteDbInitOptions } from './types';
import { getWorkerSessionId } from '@/lib/data-sources/session';
import { withVfsFileLock, tryWithVfsFileLock, SKIPPED } from './file-lock';

/**
 * Convert an arbitrary "filename" into an OPFS-leaf-safe name.
 * `getFileHandle` rejects names containing `/`, so we mirror
 * OPFSCoopSyncVFS's own path-handling: split on `/`, drop empty segments,
 * take the last piece. Defensive — IDB rows written before the leading-`/`
 * convention was dropped still need to work.
 */
function leafName(filename: string): string {
    const parts = filename.split('/').filter((p) => p.length > 0);
    if (parts.length === 0) throw new Error(`empty filename: "${filename}"`);
    return parts[parts.length - 1]!;
}

/**
 * Worker-side accessor that owns a Map<name, WaSqliteDb>. Each opened name
 * maps to a real OPFS file at the root via OPFSCoopSyncVFS.
 * `importIntoOpfs` writes bytes directly to that file via the regular
 * `FileSystemFileHandle` API and then opens it through the VFS.
 */
export class WaSqliteDbInstanceAccessor {
    readonly #instances = new Map<string, WaSqliteDb>();

    /**
     * Open (or return the cached) DB for `name`. Insert into the map
     * BEFORE awaiting init so concurrent callers share the same in-flight
     * promise and don't double-initialise. Failed inits drop the bad
     * entry so retries can succeed.
     */
    async get(
        name: string = 'default',
        options: SqliteDbInitOptions = {},
    ): Promise<WaSqliteDb & Comlink.ProxyMarked> {
        let db = this.#instances.get(name);
        if (!db) {
            db = new WaSqliteDb();
            this.#instances.set(name, db);
        }
        try {
            await db.init(options);
        } catch (e) {
            if (this.#instances.get(name) === db) {
                this.#instances.delete(name);
            }
            throw e;
        }
        return Comlink.proxy(db);
    }

    /**
     * Returns this worker process's session id. Boot cleanup uses it to
     * identify abandoned `temp` sources from prior worker processes.
     */
    getWorkerSessionId(): string {
        return getWorkerSessionId();
    }

    /**
     * Names of OPFS root files that look like our data-source databases —
     * i.e. real files (not directories), not OPFSCoopSyncVFS internals.
     * Used by boot cleanup to detect orphans (files with no matching IDB
     * DataSource row).
     */
    async listDataFileNames(): Promise<string[]> {
        const root = await navigator.storage.getDirectory();
        const out: string[] = [];
        for await (const [name, handle] of root as unknown as AsyncIterable<
            [string, FileSystemHandle]
        >) {
            if (handle.kind !== 'file') continue;
            // Skip OPFSCoopSyncVFS-internal artifacts (it uses .ahp-*
            // directories; just in case it ever creates files, also skip
            // anything starting with a dot).
            if (name.startsWith('.')) continue;
            // Skip SQLite sidecars — they're owned by the VFS and follow
            // the main `.sqlite` file's lifecycle. Listing them here would
            // make boot cleanup treat them as orphans (they aren't in
            // DataSource.dbFile) and try to remove them while another tab's
            // VFS still holds their SyncAccessHandles open.
            if (name.endsWith('-wal') || name.endsWith('-journal') || name.endsWith('-shm'))
                continue;
            out.push(name);
        }
        return out;
    }

    /**
     * Close the cached WaSqliteDb for `name` and wait for the underlying
     * `sqlite3.close()` to finish — important because callers that follow
     * up with a direct OPFS write (importIntoOpfs) need the VFS to have
     * fully released its SAH on the file first. Returns true if there was
     * something to close.
     */
    async close(name: string = 'default'): Promise<boolean> {
        const db = this.#instances.get(name);
        if (!db) return false;
        this.#instances.delete(name);
        await db.close();
        return true;
    }

    /**
     * Close (if open) and unlink the OPFS file for this data source. Used
     * on source deletion and on boot cleanup of abandoned temp sources.
     *
     * `removeEntry` fails with `NoModificationAllowedError` if a peer tab's
     * VFS still holds the file's exclusive access handle, so we close our own
     * connection and then take the VFS's Web Lock (nudging peers to yield)
     * before unlinking. See {@link withVfsFileLock}.
     */
    async destroyOpfs(name: string, filename: string): Promise<void> {
        await this.close(name);
        const leaf = leafName(filename);
        await withVfsFileLock(leaf, async () => {
            try {
                const root = await navigator.storage.getDirectory();
                await root.removeEntry(leaf, { recursive: false });
            } catch (e) {
                const err = e as Error;
                if (err.name === 'NotFoundError') return;
                throw e;
            }
        });
    }

    /**
     * Like {@link destroyOpfs} but skips the file entirely if any live tab is
     * currently using it (its VFS handle / Web Lock is held). Used by the
     * boot-cleanup orphan sweep, which must never unlink a file a peer tab has
     * open. Returns `true` if the file was unlinked (or already gone), `false`
     * if it was skipped because a live peer holds it.
     */
    async destroyOpfsIfIdle(name: string, filename: string): Promise<boolean> {
        const leaf = leafName(filename);
        // Do NOT close our own connection first: if this worker has the file
        // open, the held lock makes `tryWithVfsFileLock` skip — which is the
        // safe outcome (don't delete a file in use anywhere, including here).
        void name;
        const result = await tryWithVfsFileLock(leaf, async () => {
            try {
                const root = await navigator.storage.getDirectory();
                await root.removeEntry(leaf, { recursive: false });
            } catch (e) {
                const err = e as Error;
                if (err.name === 'NotFoundError') return;
                throw e;
            }
        });
        return result !== SKIPPED;
    }

    /**
     * Drop a pre-built .sqlite file into OPFS at `filename`, then open it
     * under `name`. Used by the demo-source factory: a downloaded .sqlite
     * is written to OPFS verbatim (preserving indexes/views/FKs) and then
     * opened through OPFSCoopSyncVFS.
     *
     * If a DB at `name` is already open we close it first, so the freshly-
     * written bytes are what the next opener sees.
     */
    async importIntoOpfs(
        name: string,
        filename: string,
        bytes: ArrayBuffer,
    ): Promise<WaSqliteDb & Comlink.ProxyMarked> {
        // Close BEFORE writing — otherwise the prior sqlite3.close()
        // (async, releasing the VFS's SAH) races against our direct SAH
        // write. The new connection that follows might end up reading a
        // mix of old and new bytes. Closing also drops *our* VFS Web Lock so
        // the `withVfsFileLock` below doesn't deadlock against ourselves.
        await this.close(name);
        const leaf = leafName(filename);
        const expected = bytes.byteLength;
        // Take the VFS's own Web Lock (nudging peer tabs to yield their
        // exclusive handle) before touching the file directly. `readwrite-
        // unsafe` is what makes the raw handle openable while the VFS's mode
        // is exclusive 'readwrite' — and the Web Lock is what makes that safe,
        // since no peer VFS can (re)acquire the handle while we hold the lock.
        // This is the `readwrite-unsafe` + Web-Lock pattern OPFSAdaptiveVFS
        // uses; OPFSCoopSyncVFS does NOT use readwrite-unsafe itself.
        await withVfsFileLock(leaf, async () => {
            const root = await navigator.storage.getDirectory();
            const fileHandle = await root.getFileHandle(leaf, { create: true });
            const sah = await (
                fileHandle as unknown as {
                    createSyncAccessHandle: (opts?: {
                        mode?: 'readwrite' | 'read-only' | 'readwrite-unsafe';
                    }) => Promise<{
                        truncate: (n: number) => void;
                        write: (buf: ArrayBufferView, opts?: { at: number }) => number;
                        flush: () => void;
                        getSize: () => number;
                        close: () => void;
                    }>;
                }
            ).createSyncAccessHandle({ mode: 'readwrite-unsafe' });
            let wrote = 0;
            let finalSize = 0;
            try {
                sah.truncate(0);
                const buf = new Uint8Array(bytes);
                wrote = sah.write(buf, { at: 0 });
                sah.flush();
                finalSize = sah.getSize();
            } finally {
                sah.close();
            }
            if (wrote !== expected || finalSize !== expected) {
                console.warn(
                    `[sqlite] importIntoOpfs(${leaf}): expected ${expected} bytes, wrote ${wrote}, on-disk ${finalSize}`,
                );
            }
        });
        return this.get(name, { filename });
    }
}
