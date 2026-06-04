import type { RuntimeEvent } from '@/lib/runtime/api';
import { RUNTIME_CHANNEL } from '@/lib/runtime/api';

/**
 * Per-tab broadcaster. One BroadcastChannel instance per tab; both
 * sending and receiving go through it.
 *
 * Two BroadcastChannel objects on the same channel name *in the same
 * browsing context* deliver to each other (the spec excludes only the
 * exact instance that posted, not all instances in the same context).
 * Keeping a single instance here avoids doubling every event.
 *
 * Three publish modes:
 *
 *   - `publish`: self-deliver to this tab's Solid mirror AND broadcast
 *     to peer tabs. Used for agent-loop mutations that legitimately
 *     change shared action state.
 *   - `publishLocal`: self-delivery only. Used for IDB-hydration paths
 *     where peer tabs are independent authorities for their own
 *     sessions and would lose in-flight state if a peer's hydration
 *     clobbered them.
 *   - `publishPeer`: broadcast-only. Used for cross-tab coordination
 *     messages (snapshot-request/-response) where the sender never
 *     needs to handle its own event.
 */

let channel: BroadcastChannel | null = null;
let localListener: ((event: RuntimeEvent) => void) | null = null;
const peerListeners = new Set<(event: RuntimeEvent) => void>();
const localTaps = new Set<(event: RuntimeEvent) => void>();

function getChannel(): BroadcastChannel {
    if (!channel) {
        channel = new BroadcastChannel(RUNTIME_CHANNEL);
        channel.addEventListener('message', (e) => {
            const ev = e.data as RuntimeEvent;
            for (const fn of peerListeners) {
                try {
                    fn(ev);
                } catch (err) {
                    console.warn('[runtime/broadcast] peer listener threw', err, ev);
                }
            }
        });
    }
    return channel;
}

/**
 * Register the in-process listener invoked synchronously by `publish`
 * before the BroadcastChannel post. Used by the writing tab so its own
 * mutations reach its Solid mirror.
 */
export function setLocalListener(listener: ((event: RuntimeEvent) => void) | null): void {
    localListener = listener;
}

/**
 * Add a passive observer of this tab's own published events (the same stream
 * the local mirror listener sees). Unlike `setLocalListener` — which is a
 * single slot owned by the Solid mirror — taps are additive side-channels.
 * Used by the host to auto-persist the chat whenever session state changes.
 * Returns an unsubscribe.
 */
export function addLocalEventTap(listener: (event: RuntimeEvent) => void): () => void {
    localTaps.add(listener);
    return () => {
        localTaps.delete(listener);
    };
}

/**
 * Subscribe to events from *other* tabs. The local listener is the
 * mechanism for same-tab delivery; this is strictly cross-tab.
 */
export function subscribePeerEvents(listener: (event: RuntimeEvent) => void): () => void {
    getChannel();
    peerListeners.add(listener);
    return () => {
        peerListeners.delete(listener);
    };
}

export function publish(event: RuntimeEvent): void {
    deliverLocal(event);
    try {
        getChannel().postMessage(event);
    } catch (e) {
        console.warn('[runtime/broadcast] publish failed', e, event);
    }
}

/**
 * Self-deliver an event to this tab's Solid mirror WITHOUT broadcasting
 * to peer tabs.
 */
export function publishLocal(event: RuntimeEvent): void {
    deliverLocal(event);
}

/**
 * Broadcast to peer tabs only — no self-delivery.
 */
export function publishPeer(event: RuntimeEvent): void {
    try {
        getChannel().postMessage(event);
    } catch (e) {
        console.warn('[runtime/broadcast] publishPeer failed', e, event);
    }
}

function deliverLocal(event: RuntimeEvent): void {
    if (!localListener && localTaps.size === 0) return;
    let cloned: RuntimeEvent;
    try {
        // structuredClone so the mirror operates on an independent object
        // graph — otherwise a later state-module mutation on a shared
        // nested array (msg.parts, run.messages, …) would also surface
        // through the mirror as if it had happened twice.
        cloned = structuredClone(event) as RuntimeEvent;
    } catch (e) {
        console.error(
            `[runtime/broadcast] structuredClone failed on event kind=${event.kind}`,
            e,
            event,
        );
        return;
    }
    if (localListener) {
        try {
            localListener(cloned);
        } catch (e) {
            console.warn('[runtime/broadcast] local listener threw', e, event);
        }
    }
    for (const tap of localTaps) {
        try {
            tap(cloned);
        } catch (e) {
            console.warn('[runtime/broadcast] local tap threw', e, event);
        }
    }
}
