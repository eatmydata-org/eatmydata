/// Universal dev-time worker cache-buster + reloader for every Worker /
/// SharedWorker in the app.
///
/// The problem it solves: a running worker keeps executing its *old*
/// module graph until its instance is recreated. A worker is its own
/// build, separate from the page's HMR graph, so editing a worker source
/// (e.g. `src/lib/wa-sqlite/seed.ts`) does NOT hot-update the running
/// worker and — when the page graph reaches the worker only through
/// type-only imports — doesn't reload the page either. The stale worker
/// lingers (for the OPFS sqlite engine that surfaces as `database is
/// locked`, since the zombie still holds the OPFS file's Web Lock). For a
/// SharedWorker it's worse: identity is (URL, name, credentials) and the
/// dev URL is stable, so the browser reuses the old instance across
/// reloads until DevTools terminates it.
///
/// This plugin, per registered worker directory:
///   1. Exposes `virtual:worker-versions` → `{ [key]: '<16-char hash>' }`,
///      a content hash of that worker's sources. Consumers suffix their
///      Worker `name` with the hash so each rebuild lands on a fresh
///      instance — load-bearing for SharedWorker identity; cosmetic (but
///      tidy in DevTools) for DedicatedWorker.
///   2. On any change under a registered dir, recomputes the hash and, if
///      it moved, sends a full page reload. Partial HMR can't swap a
///      running worker in place; the reload deterministically unloads the
///      document (terminating its DedicatedWorkers) and re-evaluates the
///      client modules so they reconstruct exactly one fresh worker
///      generation — across every connected tab.
///
/// Active in `serve` only. In `build` every version is `'prod'` (Vite
/// content-hashes worker asset URLs, so a name suffix is redundant);
/// consumers gate the suffix on `import.meta.env.DEV`.

import type { Plugin } from 'vite';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

export interface WorkerSpec {
    /// Stable key, used in the version map and by the consumer lookup.
    key: string;
    /// Worker source directory, relative to the Vite project root.
    dir: string;
    /// Filenames in `dir` to skip beyond the always-skipped `*.test.ts`
    /// and non-`.ts` entries — e.g. the consumer-side `client.ts`, which
    /// doesn't run in the worker, or dead/unreferenced workers.
    exclude?: string[];
}

const VIRTUAL_ID = 'virtual:worker-versions';
const RESOLVED_ID = '\0' + VIRTUAL_ID;

/// Content hash of the top-level `.ts` worker sources in `dir`. Flat
/// (non-recursive), matching the flat worker dirs in this repo. File
/// names are folded into the digest so a rename changes the hash.
function hashDir(dir: string, exclude: Set<string>): string {
    const h = createHash('sha256');
    for (const name of readdirSync(dir).sort()) {
        if (exclude.has(name)) continue;
        if (name.endsWith('.test.ts')) continue;
        if (!name.endsWith('.ts')) continue;
        const full = join(dir, name);
        if (!statSync(full).isFile()) continue;
        h.update(name);
        h.update(readFileSync(full));
    }
    return h.digest('hex').slice(0, 16);
}

export function workerVersion(specs: WorkerSpec[]): Plugin {
    type Resolved = { key: string; absDir: string; exclude: Set<string> };
    let resolved: Resolved[] = [];
    const versions: Record<string, string> = {};
    let isServe = false;

    const recompute = (r: Resolved): void => {
        versions[r.key] = isServe ? hashDir(r.absDir, r.exclude) : 'prod';
    };

    return {
        name: 'worker-version',
        config(_, env) {
            isServe = env.command === 'serve';
        },
        configResolved(config) {
            resolved = specs.map((s) => ({
                key: s.key,
                absDir: resolve(config.root, s.dir),
                exclude: new Set(s.exclude ?? []),
            }));
        },
        buildStart() {
            for (const r of resolved) recompute(r);
        },
        resolveId(id) {
            if (id === VIRTUAL_ID) return RESOLVED_ID;
        },
        load(id) {
            if (id === RESOLVED_ID) {
                return `export const workerVersions = ${JSON.stringify(versions)};`;
            }
        },
        configureServer(server) {
            const onChange = (path: string): void => {
                const hit = resolved.find((r) => {
                    const rel = relative(r.absDir, path);
                    return !!rel && !rel.startsWith('..');
                });
                if (!hit) return;
                const next = hashDir(hit.absDir, hit.exclude);
                if (next === versions[hit.key]) return;
                versions[hit.key] = next;
                const mod = server.moduleGraph.getModuleById(RESOLVED_ID);
                if (mod) server.moduleGraph.invalidateModule(mod);
                // Full reload so every client module re-evaluates and
                // reconstructs its worker with the new name. A running
                // worker can't be swapped in place.
                server.ws.send({ type: 'full-reload' });
            };
            server.watcher.on('change', onChange);
            server.watcher.on('add', onChange);
            server.watcher.on('unlink', onChange);
        },
    };
}
