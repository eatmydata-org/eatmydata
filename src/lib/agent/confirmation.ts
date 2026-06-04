import type { AgentId, MessagePart } from '@/lib/types';
import type { AgentControls } from './loop';

export type ConfirmationResponse = {
    approved: boolean;
    response?: unknown;
};

export type RequestConfirmationArgs = {
    controls: AgentControls;
    stepId: string;
    toolCallId: string;
    rendererId: string;
    payload: unknown;
    agent?: AgentId;
};

/**
 * Drop a structured confirmation card into the active step and block until the
 * user decides. Any agent can call this from a tool executor.
 */
export async function requestConfirmation(
    args: RequestConfirmationArgs,
): Promise<ConfirmationResponse> {
    // The confirmation lives in the SAME step as the generic `tool-call` part
    // the agent loop created for this tool call — and both would default to the
    // executor's `ctx.toolCallId`. Reusing it verbatim makes the two parts
    // collide: `updateToolCallPart` matches by id and finds the tool-call part
    // (added first), so the decision's `approved`/`response` lands on the
    // tool-call instead of the confirmation — the card stays `approved: null`
    // forever (no live update, nothing persisted). A fresh per-call id also
    // keeps multiple confirmations in one step (e.g. across review iterations)
    // from clobbering each other. This id is BOTH the part's identity and the
    // ticket key (the card resolves the ticket via the part's `toolCallId`), so
    // one derived id is used for the part, the ticket, and the update.
    const partId = `${args.toolCallId}::confirm:${crypto.randomUUID().slice(0, 8)}`;
    const part: Extract<MessagePart, { kind: 'confirmation' }> = {
        kind: 'confirmation',
        toolCallId: partId,
        agent: args.agent,
        rendererId: args.rendererId,
        payload: args.payload,
        approved: null,
    };
    args.controls.addPart(args.stepId, part);
    const decision = await args.controls.waitForApproval(args.stepId, partId);
    args.controls.updatePart(args.stepId, partId, {
        approved: decision.approved,
        response: decision.response,
        decidedAt: Date.now(),
    });
    return decision;
}
