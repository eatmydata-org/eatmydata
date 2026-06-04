import type { ConfirmationDecision, Ticket } from '@/lib/runtime/api';
import { publish } from './broadcast';

/**
 * Tickets — the writing tab's source of truth for one-shot user
 * actions (today: tool confirmations). The agent awaits the returned
 * Deferred; resolution arrives when `resolveTicket` is called from
 * the same tab (the running tab owns its own confirmations).
 *
 * Resolution publishes a broadcast so the local Solid mirror updates
 * and peer tabs see the resolved state if they were observing it.
 */

type Deferred<T> = {
    promise: Promise<T>;
    resolve(value: T): void;
};

function makeDeferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}

const tickets = new Map<string, Ticket>();
const pending = new Map<string, Deferred<ConfirmationDecision>>();

export function openTicket(args: {
    id: string;
    actionId: string;
    kind: string;
}): Promise<ConfirmationDecision> {
    const ticket: Ticket = {
        id: args.id,
        actionId: args.actionId,
        kind: args.kind,
        createdAt: Date.now(),
        state: 'pending',
    };
    tickets.set(args.id, ticket);
    const deferred = makeDeferred<ConfirmationDecision>();
    pending.set(args.id, deferred);
    publish({ kind: 'ticket-opened', ticket });
    return deferred.promise;
}

/**
 * Resolve a pending ticket. Returns `true` only when a *live* Deferred was
 * resolved — i.e. an agent loop in THIS tab is parked on it and will now
 * wake. Returns `false` when the ticket is unknown, already resolved, or has
 * no live Deferred (the common case after a reload or when a different tab
 * ran the loop: the in-memory `pending` map is empty). Callers use the
 * `false` result to fall back to restarting the turn from the persisted
 * chat log — see `host.answerPendingConfirmation`.
 */
export function resolveTicket(ticketId: string, decision: ConfirmationDecision): boolean {
    const t = tickets.get(ticketId);
    if (!t || t.state !== 'pending') return false;
    t.state = 'resolved';
    t.decision = decision;
    t.resolvedAt = Date.now();
    publish({ kind: 'ticket-resolved', ticketId, decision });
    const d = pending.get(ticketId);
    pending.delete(ticketId);
    if (!d) return false;
    d.resolve(decision);
    return true;
}

export function expireTicketsForAction(actionId: string): void {
    for (const [id, t] of tickets) {
        if (t.actionId === actionId && t.state === 'pending') {
            t.state = 'expired';
            t.resolvedAt = Date.now();
            publish({ kind: 'ticket-expired', ticketId: id });
            const d = pending.get(id);
            pending.delete(id);
            d?.resolve({ approved: false });
        }
    }
}

export function snapshotTickets(): Record<string, Ticket> {
    const out: Record<string, Ticket> = {};
    for (const [k, v] of tickets) out[k] = v;
    return out;
}
