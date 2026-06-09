/// <reference lib="webworker" />
/**
 * Sqlite worker — DedicatedWorker hosting the wa-sqlite engine via
 * `WaSqliteDbInstanceAccessor`. Spawned by each tab (and by the runtime
 * SharedWorker) directly through `new Worker(...)`.
 *
 * `createSyncAccessHandle` is DedicatedWorker-only per spec, so this worker
 * is where the wa-sqlite + OPFSCoopSyncVFS stack runs. All tabs sharing
 * the app concurrently read/write the same OPFS files; OPFSCoopSyncVFS
 * coordinates via Web Locks at the VFS layer.
 */
import * as Comlink from 'comlink';
import { WaSqliteDbInstanceAccessor } from './accessor';

// The C `vector_search` vtab now embeds queries with an in-module C call (the
// BGE engine is compiled into wa-sqlite.wasm) — no embed hook to install. The
// model is lazy-loaded by the accessor: maybeWarmSemanticSearch() on opening a
// DB that carries a semantic index, and embedTexts() while indexing. A tab that
// never touches semantic search never loads it.
const accessor = new WaSqliteDbInstanceAccessor();
Comlink.expose(accessor);

export type { WaSqliteDbInstanceAccessor };
