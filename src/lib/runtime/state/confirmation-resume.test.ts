import { describe, it, expect } from 'vitest';
import type { Message } from '@/lib/types';
import { openTicket, resolveTicket } from './tickets';
import * as sessions from './sessions';

/**
 * Regression coverage for the "type after reload does nothing" bug.
 *
 * A chat-input confirmation (ask_user "Other" / analysis-review "Revise
 * draft") parks the agent loop on a ticket Deferred that lives only in the
 * running tab's memory. After a window reload (or opening the chat in a tab
 * that never ran the loop) that Deferred is gone, but the persisted chat log
 * still shows the card as `approved: null`. The composer routes the typed
 * text to `resolveTicket`, which used to silently no-op.
 *
 * The fix splits the two cases via two signals exercised here:
 *   - `resolveTicket` returns whether a LIVE Deferred was resumed.
 *   - `resolveConfirmationPart` settles the orphaned card so it stops
 *     blocking the composer, letting the host restart the turn instead.
 */

function uid(prefix: string): string {
    return `${prefix}-${crypto.randomUUID()}`;
}

describe('tickets.resolveTicket — live-vs-orphan signal', () => {
    it('returns true and resolves the Deferred when a live ticket is parked', async () => {
        const id = uid('ticket');
        const promise = openTicket({ id, actionId: uid('action'), kind: 'confirmation' });
        const decision = { approved: true, response: { choiceId: null, freeText: 'go' } };

        expect(resolveTicket(id, decision)).toBe(true);
        await expect(promise).resolves.toEqual(decision);
    });

    it('returns false for an unknown ticket (the post-reload orphan case) without throwing', () => {
        // No openTicket — mirrors the empty in-memory map after a reload.
        expect(resolveTicket(uid('ghost'), { approved: true })).toBe(false);
    });

    it('returns false on a second resolution of the same ticket', () => {
        const id = uid('ticket');
        void openTicket({ id, actionId: uid('action'), kind: 'confirmation' });
        expect(resolveTicket(id, { approved: true })).toBe(true);
        expect(resolveTicket(id, { approved: true })).toBe(false);
    });
});

describe('sessions.resolveConfirmationPart — settle an orphaned card', () => {
    function seedPendingConfirmation(rendererId: string): { actionId: string; partId: string } {
        const actionId = uid('action');
        const partId = uid('tc') + '::confirm:abcd1234';
        sessions.ensureSession(actionId);
        const msg: Message = {
            id: crypto.randomUUID(),
            role: 'assistant',
            content: '',
            createdAt: Date.now(),
            parts: [
                { kind: 'text', id: 't1', text: 'here is the draft' },
                {
                    kind: 'confirmation',
                    toolCallId: partId,
                    rendererId,
                    payload: {},
                    approved: null,
                },
            ],
        };
        sessions.appendMessage(actionId, msg);
        return { actionId, partId };
    }

    it('stamps approved/response/decidedAt onto the pending part and returns true', () => {
        const { actionId, partId } = seedPendingConfirmation('analysis-review-feedback');
        const decision = { approved: true, response: { choiceId: null, freeText: 'fix the axis' } };

        expect(sessions.resolveConfirmationPart(actionId, partId, decision)).toBe(true);

        const part = sessions
            .getSession(actionId)!
            .messages.flatMap((m) => m.parts ?? [])
            .find((p) => p.kind === 'confirmation' && p.toolCallId === partId);
        expect(part).toBeDefined();
        if (part?.kind !== 'confirmation') throw new Error('expected confirmation part');
        // approved !== null is exactly what `pendingChatInput` checks, so the
        // card no longer blocks the composer.
        expect(part.approved).toBe(true);
        expect(part.response).toEqual({ choiceId: null, freeText: 'fix the axis' });
        expect(typeof part.decidedAt).toBe('number');
    });

    it('returns false (no double-settle) once the part is already decided', () => {
        const { actionId, partId } = seedPendingConfirmation('user-question');
        expect(sessions.resolveConfirmationPart(actionId, partId, { approved: true })).toBe(true);
        expect(sessions.resolveConfirmationPart(actionId, partId, { approved: true })).toBe(false);
    });

    it('returns false for an unknown part id', () => {
        const { actionId } = seedPendingConfirmation('analysis-review-feedback');
        expect(sessions.resolveConfirmationPart(actionId, uid('missing'), { approved: true })).toBe(
            false,
        );
    });

    it('returns false when the session does not exist', () => {
        expect(
            sessions.resolveConfirmationPart(uid('no-session'), uid('p'), { approved: true }),
        ).toBe(false);
    });
});

describe('sessions.findConfirmationPart — orphan-decision lookup', () => {
    it('finds the confirmation part by id regardless of decided state and exposes its rendererId', () => {
        const actionId = uid('action');
        const partId = uid('tc') + '::confirm:beef';
        sessions.ensureSession(actionId);
        sessions.appendMessage(actionId, {
            id: crypto.randomUUID(),
            role: 'assistant',
            content: '',
            createdAt: Date.now(),
            parts: [
                {
                    kind: 'confirmation',
                    toolCallId: partId,
                    rendererId: 'analysis-review',
                    payload: {},
                    approved: null,
                },
            ],
        });

        const pending = sessions.findConfirmationPart(actionId, partId);
        expect(pending?.rendererId).toBe('analysis-review');
        expect(pending?.approved).toBe(null);

        // Still found after it's decided (so a double-click can be guarded on
        // `approved !== null` rather than on absence).
        sessions.resolveConfirmationPart(actionId, partId, { approved: true });
        expect(sessions.findConfirmationPart(actionId, partId)?.approved).toBe(true);
    });

    it('returns undefined for an unknown id or missing session', () => {
        const actionId = uid('action');
        sessions.ensureSession(actionId);
        expect(sessions.findConfirmationPart(actionId, uid('nope'))).toBeUndefined();
        expect(sessions.findConfirmationPart(uid('no-session'), uid('p'))).toBeUndefined();
    });
});
