import { createStore, produce } from 'solid-js/store';
import { createSignal } from 'solid-js';
import { clearDebugBlocks, loadDebugBlocks, loadDebugEnabled, saveDebugEnabled } from './storage';

export type DebugBlockKind = 'request' | 'response' | 'system';

export type DebugBlock = {
    id: string;
    kind: DebugBlockKind;
    /** Maps to the assistant Message.id this block belongs to. */
    stepId: string;
    /** Optional header label (e.g. tool name for system blocks). */
    label?: string;
    text: string;
    done: boolean;
    expanded: boolean;
    createdAt: number;
};

/**
 * `debugLog` is consumed in two contexts:
 *
 * - **Runtime SharedWorker** — the agent's log-middleware calls
 *   `open`/`append`/`close` to record LLM request/response streams
 *   and tool-dispatch events. The worker doesn't store anything; it
 *   just publishes structured events onto the `rh-debug` channel.
 *
 * - **Tabs** — `DebugLogView` reactively renders `debugLog.blocks`.
 *   On the tab side this module owns a Solid store, hydrates it from
 *   `localStorage`, and listens to the worker's `rh-debug` events
 *   so anything the agent writes shows up in the tab's debug panel.
 *
 * Context detection: `typeof window === 'undefined'` is true inside
 * a worker, false inside a tab.
 */

type DebugEvent =
    | { kind: 'open'; block: DebugBlock }
    | { kind: 'append'; id: string; delta: string }
    | { kind: 'close'; id: string }
    | { kind: 'system'; block: DebugBlock }
    | { kind: 'closeAllOpen' }
    | { kind: 'clear' }
    | { kind: 'enabled'; v: boolean }
    | { kind: 'enabled-query' };

const DEBUG_CHANNEL = 'rh-debug';
const isWorker = typeof window === 'undefined';

let bc: BroadcastChannel | null = null;
function getBc(): BroadcastChannel {
    if (!bc) bc = new BroadcastChannel(DEBUG_CHANNEL);
    return bc;
}

function emit(event: DebugEvent): void {
    try {
        getBc().postMessage(event);
    } catch (e) {
        console.warn('[debug-log] emit failed', e);
    }
}

type Store = { blocks: DebugBlock[] };

const [store, setStore] = createStore<Store>({
    blocks: isWorker ? [] : loadDebugBlocks(),
});
const [enabled, setEnabled] = createSignal(isWorker ? false : loadDebugEnabled());

function applyEvent(event: DebugEvent): void {
    switch (event.kind) {
        case 'open':
            setStore(
                'blocks',
                produce((b) => {
                    b.push(event.block);
                }),
            );
            break;
        case 'append':
            setStore(
                'blocks',
                (b) => b.id === event.id,
                produce((b) => {
                    b.text += event.delta;
                }),
            );
            break;
        case 'close':
            setStore(
                'blocks',
                (b) => b.id === event.id,
                produce((b) => {
                    b.done = true;
                }),
            );
            break;
        case 'system':
            setStore(
                'blocks',
                produce((b) => {
                    b.push(event.block);
                }),
            );
            break;
        case 'closeAllOpen':
            setStore(
                'blocks',
                (b) => !b.done,
                produce((b) => {
                    b.done = true;
                }),
            );
            break;
        case 'clear':
            setStore('blocks', []);
            break;
    }
}

// Subscribe to broadcast events. Tabs apply log mutations and respond to
// enabled-state queries from freshly-booted workers; workers listen only
// for enabled-state pushes from tabs (the source of truth).
if (!isWorker) {
    getBc().addEventListener('message', (e) => {
        const event = e.data as DebugEvent;
        if (event.kind === 'enabled') {
            // Tab is the source of truth; ignore echoes to avoid loops.
            return;
        }
        if (event.kind === 'enabled-query') {
            emit({ kind: 'enabled', v: enabled() });
            return;
        }
        applyEvent(event);
    });
} else {
    getBc().addEventListener('message', (e) => {
        const event = e.data as DebugEvent;
        if (event.kind === 'enabled') {
            setEnabled(event.v);
        }
    });
    // Ask any live tab for the current enabled state.
    try {
        emit({ kind: 'enabled-query' });
    } catch (e) {
        console.warn('[debug-log] enabled-query emit failed', e);
    }
}

function makeId(): string {
    return crypto.randomUUID().slice(0, 8);
}

function makeBlock(
    kind: DebugBlockKind,
    stepId: string,
    initial = '',
    label?: string,
    done = false,
): DebugBlock {
    return {
        id: makeId(),
        kind,
        stepId,
        label,
        text: initial,
        done,
        expanded: false,
        createdAt: Date.now(),
    };
}

export const debugLog = {
    get blocks(): DebugBlock[] {
        return store.blocks;
    },
    get enabled() {
        return enabled();
    },
    setEnabled(v: boolean) {
        if (isWorker) return;
        setEnabled(v);
        saveDebugEnabled(v);
        emit({ kind: 'enabled', v });
    },
    toggleEnabled() {
        if (isWorker) return;
        const next = !enabled();
        setEnabled(next);
        saveDebugEnabled(next);
        emit({ kind: 'enabled', v: next });
    },
    clear() {
        if (isWorker) {
            emit({ kind: 'clear' });
            return;
        }
        setStore('blocks', []);
        clearDebugBlocks();
        // Inform other tabs too so a clear in one tab clears all.
        emit({ kind: 'clear' });
    },
    /** Append a new block; returns its id. */
    open(kind: DebugBlockKind, stepId: string, initial = '', label?: string): string {
        const block = makeBlock(kind, stepId, initial, label, false);
        if (isWorker) emit({ kind: 'open', block });
        else applyEvent({ kind: 'open', block });
        return block.id;
    },
    /**
     * One-shot helper: emit a fully-formed `system` block (already closed).
     * Used for tool dispatch logs where the input and result are known at
     * once — no streaming.
     */
    system(stepId: string, label: string, text: string) {
        const block = makeBlock('system', stepId, text, label, true);
        if (isWorker) emit({ kind: 'system', block });
        else applyEvent({ kind: 'system', block });
        return block.id;
    },
    append(blockId: string, delta: string) {
        if (!delta) return;
        if (isWorker) emit({ kind: 'append', id: blockId, delta });
        else applyEvent({ kind: 'append', id: blockId, delta });
    },
    close(blockId: string) {
        if (isWorker) emit({ kind: 'close', id: blockId });
        else applyEvent({ kind: 'close', id: blockId });
    },
    /** Mark any still-open blocks as done — e.g. after an abort. */
    closeAllOpen() {
        if (isWorker) emit({ kind: 'closeAllOpen' });
        else applyEvent({ kind: 'closeAllOpen' });
    },
    setExpanded(blockId: string, v: boolean) {
        // Tab-side UI state only — never published.
        if (isWorker) return;
        setStore(
            'blocks',
            (b) => b.id === blockId,
            produce((b) => {
                b.expanded = v;
            }),
        );
    },
    expandAll() {
        if (isWorker) return;
        setStore(
            'blocks',
            () => true,
            produce((b) => {
                b.expanded = true;
            }),
        );
    },
    collapseAll() {
        if (isWorker) return;
        setStore(
            'blocks',
            () => true,
            produce((b) => {
                b.expanded = false;
            }),
        );
    },
};

export const PREVIEW_CHARS = 512;
