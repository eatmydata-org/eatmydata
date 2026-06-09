/// <reference lib="webworker" />
/**
 * DedicatedWorker host for `WaSqliteDb` instances. Comlink-exposes a tiny
 * factory; callers do `factory.createDb()` to get a `Comlink.Remote<WaSqliteDb>`
 * that proxies into the worker.
 *
 * Used by the browser testbed. The production accessor in `worker.ts` uses
 * the same pattern but exposes a single shared `WaSqliteDbInstanceAccessor`
 * instead of letting tests mint independent connections.
 */
import * as Comlink from 'comlink';
import { WaSqliteDb } from './db';
import { WaSqliteDbInstanceAccessor } from './accessor';
import { warmSemanticModel } from './semantic-embed';

export class WaSqliteFactory {
    /**
     * Load the BGE GGUF into the shared wa-sqlite module so the C
     * `vector_search` vtab can embed query phrases. In production this warm is
     * triggered automatically (opening an indexed DB, or indexing); the testbed
     * builds its sidecar by hand so it warms explicitly before querying.
     */
    async warmSemanticSearch(): Promise<void> {
        await warmSemanticModel();
    }

    /**
     * Construct a fresh `WaSqliteDb` and return a Comlink proxy. The
     * underlying instance lives in this worker; the proxy travels back to
     * the caller through a private MessageChannel, so each `createDb()`
     * call yields an independent connection.
     */
    createDb(): WaSqliteDb & Comlink.ProxyMarked {
        return Comlink.proxy(new WaSqliteDb());
    }

    /**
     * Construct a fresh `WaSqliteDbInstanceAccessor` (the production worker's
     * top-level object) and return a Comlink proxy. Lets the testbed exercise
     * the real `importIntoOpfs`/`destroyOpfs` cross-tab coordination from an
     * isolated worker — give two factories (= two "tabs") to test contention.
     */
    createAccessor(): WaSqliteDbInstanceAccessor & Comlink.ProxyMarked {
        return Comlink.proxy(new WaSqliteDbInstanceAccessor());
    }
}

Comlink.expose(new WaSqliteFactory());
