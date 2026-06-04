import type { AgentControls } from '@/lib/agent/loop';
import type { Message } from '@/lib/types';
import * as sessions from './state/sessions';
import { openTicket } from './state/tickets';

/**
 * AgentControls bound to a specific actionId. Methods mutate worker
 * session state in place and emit fine-grained broadcast events so
 * tabs apply each delta to the precise store path — no full-array
 * round-tripping per LLM token.
 */

export function buildRuntimeControls(actionId: string): AgentControls {
    return {
        beginStep(agent) {
            const id = crypto.randomUUID();
            const msg: Message = {
                id,
                role: 'assistant',
                content: '',
                parts: [],
                createdAt: Date.now(),
                agent,
            };
            sessions.appendMessage(actionId, msg);
            sessions.setInflightId(actionId, id);
            return id;
        },
        appendText(stepId, delta) {
            sessions.appendTextDelta(actionId, stepId, delta);
        },
        appendReasoning(stepId, delta) {
            sessions.appendReasoningDelta(actionId, stepId, delta);
        },
        addPart(stepId, part) {
            sessions.addPart(actionId, stepId, part);
        },
        updatePart(stepId, toolCallId, patch) {
            sessions.updateToolCallPart(actionId, stepId, toolCallId, patch);
        },
        sweepUnresolved(stepId, reason) {
            sessions.sweepUnresolvedParts(actionId, stepId, reason);
        },
        waitForApproval(_stepId, toolCallId) {
            return openTicket({
                id: toolCallId,
                actionId,
                kind: 'confirmation',
            });
        },
        updateSubAgentRun(stepId, runId, patch) {
            sessions.mutateSubAgentRun(actionId, stepId, runId, (run) => {
                Object.assign(run, patch);
            });
        },
        readSubAgentRun(stepId, runId) {
            return sessions.readSubAgentRun(actionId, stepId, runId);
        },
        makeSubAgentControls(stepId, runId) {
            return buildChildControls(actionId, stepId, runId);
        },
        getMessagesSnapshot() {
            const s = sessions.getSession(actionId);
            return s ? structuredClone(s.messages) : [];
        },
    };
}

function buildChildControls(
    actionId: string,
    rootStepId: string,
    rootRunId: string,
): AgentControls {
    return {
        beginStep(agent) {
            const id = crypto.randomUUID();
            const msg: Message = {
                id,
                role: 'assistant',
                content: '',
                parts: [],
                createdAt: Date.now(),
                agent,
            };
            sessions.appendSubAgentMessage(actionId, rootStepId, rootRunId, msg);
            return id;
        },
        appendText(stepId, delta) {
            sessions.appendSubAgentTextDelta(actionId, rootStepId, rootRunId, stepId, delta);
        },
        appendReasoning(stepId, delta) {
            sessions.appendSubAgentReasoningDelta(actionId, rootStepId, rootRunId, stepId, delta);
        },
        addPart(stepId, part) {
            sessions.addSubAgentPart(actionId, rootStepId, rootRunId, stepId, part);
        },
        updatePart(stepId, toolCallId, patch) {
            sessions.updateSubAgentToolCallPart(
                actionId,
                rootStepId,
                rootRunId,
                stepId,
                toolCallId,
                patch,
            );
        },
        sweepUnresolved(stepId, reason) {
            sessions.sweepSubAgentUnresolvedParts(actionId, rootStepId, rootRunId, stepId, reason);
        },
        waitForApproval(_stepId, toolCallId) {
            return openTicket({
                id: toolCallId,
                actionId,
                kind: 'confirmation',
            });
        },
        updateSubAgentRun() {
            throw new Error('Nested sub-agents are not supported yet.');
        },
        readSubAgentRun() {
            return undefined;
        },
        makeSubAgentControls() {
            throw new Error('Nested sub-agents are not supported yet.');
        },
        getMessagesSnapshot() {
            const s = sessions.getSession(actionId);
            return s ? structuredClone(s.messages) : [];
        },
    };
}
