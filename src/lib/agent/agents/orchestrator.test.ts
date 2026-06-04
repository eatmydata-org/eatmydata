import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunCtx, SubAgentResult } from '../agent-def';
import type { AgentControls } from '../loop';
import type { SavedDataSourcePreview } from '@/lib/types';
import type { Action } from '@/lib/actions/types';

// Mock the live drafts store so the executor doesn't talk to a real
// BroadcastChannel / IndexedDB during tests. We don't assert anything on
// these — they exist only to satisfy the import graph.
const { activeActionMock, executeActionMock } = vi.hoisted(() => ({
    activeActionMock: vi.fn(),
    // Typed as `(action: Action) => ...` so `mock.calls[0]?.[0]` is the
    // Action argument (otherwise vitest infers `[][]` and the tuple access
    // is a type error).
    executeActionMock: vi.fn<(action: import('@/lib/actions/types').Action) => Promise<unknown>>(
        async () => ({
            id: 'exec-1',
            actionId: 'a-1',
            versionId: 'v-1',
            output: 'ok',
            error: null,
            createdAt: 0,
        }),
    ),
}));
vi.mock('@/lib/runtime/state/drafts', () => ({
    activeAction: activeActionMock,
    attachPendingResult: vi.fn(),
    attachResult: vi.fn(),
    beginDraft: vi.fn(),
    clearPendingReview: vi.fn(),
    finalizeVersion: vi.fn(),
    focusVersion: vi.fn(),
    pushDataSources: vi.fn(),
    pushPendingReview: vi.fn(),
    setInflight: vi.fn(),
}));
vi.mock('@/lib/runtime/state/results', () => ({
    putResult: vi.fn(),
}));
vi.mock('@/lib/actions/store', () => ({
    getActionVersionByHash: vi.fn(async () => undefined),
    listVersionsForAction: vi.fn(async () => []),
    putAction: vi.fn(async () => {}),
    putActionVersion: vi.fn(async () => {}),
}));
vi.mock('@/lib/actions/executor', () => ({
    executeAction: executeActionMock,
    hashActionParams: vi.fn(async () => 'hash-1'),
}));

import { buildCoderKickoffInstruction, orchestratorAgent } from './orchestrator';
import { putAction } from '@/lib/actions/store';

const sampleDataSource: SavedDataSourcePreview = {
    name: 'top_customers',
    query: 'SELECT id, revenue FROM customers ORDER BY revenue DESC LIMIT 10',
    semanticDescription: 'top 10 customers by revenue',
    typeDeclaration:
        'type TopCustomers = Array<{ id: number; revenue: number }>;\ndeclare const top_customers: TopCustomers;',
    sampleColumns: ['id', 'revenue'],
    sampleRows: [
        { id: 1, revenue: 100 },
        { id: 2, revenue: 90 },
    ],
    truncated: false,
};

describe('buildCoderKickoffInstruction', () => {
    it('omits the previous-code section when previousCode is undefined', () => {
        const instr = buildCoderKickoffInstruction(
            'show me top customers',
            [sampleDataSource],
            undefined,
        );
        expect(instr).not.toMatch(/Previous code for this action/);
        expect(instr).toMatch(/top_customers/);
    });

    it('embeds the previous code verbatim when provided (iteration case)', () => {
        const prev = 'const out = top_customers.map(c => c.revenue);\n__output = out;';
        const instr = buildCoderKickoffInstruction(
            'now make the bars purple',
            [sampleDataSource],
            prev,
        );
        expect(instr).toMatch(/Previous code for this action/);
        // The Coder must see the code byte-for-byte so it can edit minimally
        // instead of rewriting.
        expect(instr).toContain(prev);
        expect(instr).toMatch(/edit it minimally/);
    });

    it('rejection feedback is no longer embedded in the kickoff — the orchestrator re-routes it through `intent` on the next work_on_action call', () => {
        // The kickoff helper used to take a `userFeedback` param that
        // synthesized a "rejected by user" block. That arm is gone: the
        // orchestrator now exits work_on_action with a rejection signal,
        // then re-calls work_on_action with a new `intent` that bakes the
        // feedback in. The kickoff just sees one intent string.
        const instr = buildCoderKickoffInstruction(
            'top customers — switch to a bar chart',
            [sampleDataSource],
            'const out = top_customers.map(c => c.revenue);\n__output = out;',
        );
        expect(instr).not.toMatch(/rejected by the user/);
        expect(instr).toMatch(/edit it minimally/);
        expect(instr).toMatch(/top customers — switch to a bar chart/);
    });
});

function makeControls(overrides: Partial<AgentControls> = {}): AgentControls {
    return {
        beginStep: vi.fn(() => 'step-1'),
        appendText: vi.fn(),
        appendReasoning: vi.fn(),
        addPart: vi.fn(),
        updatePart: vi.fn(),
        sweepUnresolved: vi.fn(),
        waitForApproval: vi.fn(),
        updateSubAgentRun: vi.fn(),
        readSubAgentRun: vi.fn(),
        makeSubAgentControls: vi.fn(),
        getMessagesSnapshot: vi.fn(() => []),
        ...overrides,
    } as unknown as AgentControls;
}

function makeCtx(overrides: Partial<AgentRunCtx> = {}): AgentRunCtx {
    return {
        controls: makeControls(),
        stepId: 'step-1',
        toolCallId: 'tc-1',
        signal: new AbortController().signal,
        runState: {},
        spawn: vi.fn(),
        ...overrides,
    };
}

describe('orchestrator ask_user executor', () => {
    it('returns { choiceId, freeText } when the user picks an option', async () => {
        const waitForApproval = vi.fn().mockResolvedValue({
            approved: true,
            response: { choiceId: 'a', freeText: null },
        });
        const addPart = vi.fn();
        const def = orchestratorAgent();
        const ctx = makeCtx({
            controls: makeControls({ waitForApproval, addPart }),
        });
        const res = await def.toolExecutors.ask_user!(
            {
                question: 'Which view do you want?',
                options: [
                    { id: 'a', label: 'Option A' },
                    { id: 'b', label: 'Option B', hint: 'a hint' },
                ],
                allowFreeText: true,
            },
            ctx,
        );
        expect(res.ok).toBe(true);
        if (res.ok) {
            expect(res.value).toEqual({
                choiceId: 'a',
                freeText: null,
            });
        }
        // The renderer card was added with the right id + payload.
        expect(addPart).toHaveBeenCalled();
        const part = (addPart as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
        expect(part).toMatchObject({
            kind: 'confirmation',
            rendererId: 'user-question',
            agent: 'orchestrator',
        });
        expect(part.payload).toEqual({
            question: 'Which view do you want?',
            options: [
                { id: 'a', label: 'Option A' },
                { id: 'b', label: 'Option B', hint: 'a hint' },
            ],
            allowFreeText: true,
        });
        // The confirmation gets its OWN id (derived from but distinct from the
        // tool-call's `tc-1`) so it can't collide with the tool-call part in the
        // same step. The part's id, the ticket key, and the update all use it.
        expect(waitForApproval).toHaveBeenCalledWith(
            'step-1',
            expect.stringMatching(/^tc-1::confirm:/),
        );
        expect(part.toolCallId).toMatch(/^tc-1::confirm:/);
    });

    it('returns { choiceId: null, freeText } when the user submits free text', async () => {
        const waitForApproval = vi.fn().mockResolvedValue({
            approved: true,
            response: { choiceId: null, freeText: 'something custom' },
        });
        const def = orchestratorAgent();
        const ctx = makeCtx({
            controls: makeControls({ waitForApproval }),
        });
        const res = await def.toolExecutors.ask_user!(
            {
                question: 'What do you want?',
                options: [
                    { id: 'a', label: 'A' },
                    { id: 'b', label: 'B' },
                ],
                allowFreeText: true,
            },
            ctx,
        );
        expect(res.ok).toBe(true);
        if (res.ok) {
            expect(res.value).toEqual({
                choiceId: null,
                freeText: 'something custom',
            });
        }
    });

    it('returns ok:false when the user dismisses the question', async () => {
        const waitForApproval = vi.fn().mockResolvedValue({
            approved: false,
        });
        const def = orchestratorAgent();
        const ctx = makeCtx({
            controls: makeControls({ waitForApproval }),
        });
        const res = await def.toolExecutors.ask_user!(
            {
                question: 'Pick one',
                options: [
                    { id: 'a', label: 'A' },
                    { id: 'b', label: 'B' },
                ],
                allowFreeText: false,
            },
            ctx,
        );
        expect(res.ok).toBe(false);
        if (!res.ok) {
            expect(res.error).toMatch(/dismissed/);
        }
    });

    // F5 regression: the chat model previously could omit `question` and
    // crash the Zod parse, killing the turn (see log1.txt's final dead
    // loop). The executor now substitutes a generic fallback so the card
    // renders and the user can route the conversation forward.
    it('F5: synthesizes a fallback `question` when the model omits the field', async () => {
        const waitForApproval = vi.fn().mockResolvedValue({
            approved: true,
            response: { choiceId: 'a', freeText: null },
        });
        const addPart = vi.fn();
        const def = orchestratorAgent();
        const ctx = makeCtx({
            controls: makeControls({ waitForApproval, addPart }),
        });
        // `question` deliberately absent. Pre-F5 this threw Zod.
        const res = await def.toolExecutors.ask_user!(
            {
                options: [
                    { id: 'a', label: 'Option A' },
                    { id: 'b', label: 'Option B' },
                ],
            },
            ctx,
        );
        expect(res.ok).toBe(true);
        const part = (addPart as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
        // Whatever the fallback says, it must be a non-empty string —
        // a blank `question` is the symptom the bug produced.
        expect(part.payload.question).toEqual(expect.any(String));
        expect(part.payload.question.trim().length).toBeGreaterThan(0);
    });

    it('F5: also substitutes when `question` is an empty/whitespace string', async () => {
        const waitForApproval = vi.fn().mockResolvedValue({
            approved: true,
            response: { choiceId: 'a', freeText: null },
        });
        const addPart = vi.fn();
        const def = orchestratorAgent();
        const ctx = makeCtx({
            controls: makeControls({ waitForApproval, addPart }),
        });
        const res = await def.toolExecutors.ask_user!(
            {
                question: '   ',
                options: [
                    { id: 'a', label: 'A' },
                    { id: 'b', label: 'B' },
                ],
            },
            ctx,
        );
        expect(res.ok).toBe(true);
        const part = (addPart as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
        expect(part.payload.question.trim().length).toBeGreaterThan(0);
    });
});

/**
 * The five failure branches of work_on_action must:
 *   1. Return an error string starting with "FAILED:" (so the model can't
 *      misread it as a soft warning).
 *   2. Push a structured `action-failed` part with the right `reason` (so the
 *      user sees a deterministic card regardless of what the model says next).
 */
describe('orchestrator work_on_action failure surfaces', () => {
    const baseInput = {
        name: 'My Action',
        description: '',
        intent: 'Show me something useful',
        mode: 'auto' as const,
    };

    const findFailurePart = (
        addPart: ReturnType<typeof vi.fn>,
    ): Record<string, unknown> | undefined => {
        const calls = addPart.mock.calls as Array<[string, Record<string, unknown>]>;
        return calls.map((c) => c[1]).find((p) => p?.kind === 'action-failed');
    };

    it('planner-error: pushes action-failed card and FAILED: error', async () => {
        const addPart = vi.fn();
        const def = orchestratorAgent();
        const ctx = makeCtx({
            controls: makeControls({ addPart }),
            spawn: vi.fn(
                async (): Promise<SubAgentResult> => ({
                    ok: false,
                    error: 'boom',
                }),
            ),
        });
        const res = await def.toolExecutors.work_on_action!(baseInput, ctx);
        expect(res.ok).toBe(false);
        if (!res.ok) {
            expect(res.error).toMatch(/^FAILED:/);
            expect(res.error).toContain('boom');
        }
        const part = findFailurePart(addPart);
        expect(part).toMatchObject({
            kind: 'action-failed',
            reason: 'planner-error',
            intent: baseInput.intent,
            actionName: baseInput.name,
            detail: 'boom',
        });
    });

    it('planner-empty: pushes action-failed card and FAILED: error', async () => {
        const addPart = vi.fn();
        const def = orchestratorAgent();
        const ctx = makeCtx({
            controls: makeControls({ addPart }),
            spawn: vi.fn(
                async (): Promise<SubAgentResult> => ({
                    ok: true,
                    summary: 'no sources',
                    data: [],
                }),
            ),
        });
        const res = await def.toolExecutors.work_on_action!(baseInput, ctx);
        expect(res.ok).toBe(false);
        if (!res.ok) {
            expect(res.error).toMatch(/^FAILED:/);
        }
        const part = findFailurePart(addPart);
        expect(part).toMatchObject({
            kind: 'action-failed',
            reason: 'planner-empty',
            intent: baseInput.intent,
            actionName: baseInput.name,
        });
    });

    it('coder-error: pushes action-failed card and FAILED: error', async () => {
        const addPart = vi.fn();
        const def = orchestratorAgent();
        const spawn = vi.fn(async (childId: string): Promise<SubAgentResult> => {
            if (childId === 'planner') {
                return {
                    ok: true,
                    summary: 'planned',
                    data: [sampleDataSource],
                };
            }
            // coder
            return { ok: false, error: 'sandbox died' };
        });
        const ctx = makeCtx({
            controls: makeControls({ addPart }),
            spawn,
        });
        const res = await def.toolExecutors.work_on_action!(baseInput, ctx);
        expect(res.ok).toBe(false);
        if (!res.ok) {
            expect(res.error).toMatch(/^FAILED:/);
            expect(res.error).toContain('sandbox died');
        }
        const part = findFailurePart(addPart);
        expect(part).toMatchObject({
            kind: 'action-failed',
            reason: 'coder-error',
            intent: baseInput.intent,
            actionName: baseInput.name,
            detail: 'sandbox died',
        });
    });

    it('coder-empty: pushes action-failed card and FAILED: error', async () => {
        const addPart = vi.fn();
        const def = orchestratorAgent();
        const spawn = vi.fn(async (childId: string): Promise<SubAgentResult> => {
            if (childId === 'planner') {
                return {
                    ok: true,
                    summary: 'planned',
                    data: [sampleDataSource],
                };
            }
            // coder produced no code / no template
            return {
                ok: true,
                summary: 'no finalization',
                data: undefined,
            };
        });
        const ctx = makeCtx({
            controls: makeControls({ addPart }),
            spawn,
        });
        const res = await def.toolExecutors.work_on_action!(baseInput, ctx);
        expect(res.ok).toBe(false);
        if (!res.ok) {
            expect(res.error).toMatch(/^FAILED:/);
            // The new message must not include the apologetic
            // "may have rejected, or it ran out of steps" hedging.
            expect(res.error).not.toMatch(/may have/i);
        }
        const part = findFailurePart(addPart);
        expect(part).toMatchObject({
            kind: 'action-failed',
            reason: 'coder-empty',
            intent: baseInput.intent,
            actionName: baseInput.name,
        });
    });

    it('rejected-with-feedback: F3 iterates internally, re-runs planner+coder, ultimately commits when user approves', async () => {
        const addPart = vi.fn();
        // 1) analysis-review: thumbs-down (no feedback on the card itself).
        // 2) analysis-review-feedback: the user types the explanation in the
        //    chat, which resolves the ticket as `{ freeText }`.
        // 3) analysis-review (2nd iteration): approve.
        // This forces one round of internal iteration.
        const waitForApproval = vi
            .fn()
            .mockResolvedValueOnce({ approved: false })
            .mockResolvedValueOnce({
                approved: true,
                response: {
                    choiceId: null,
                    freeText: 'I need a breakdown by product type',
                },
            })
            .mockResolvedValueOnce({ approved: true });
        const def = orchestratorAgent();
        // Spawn returns canned planner+coder results. The iteration
        // loop should invoke each twice (one per iteration).
        const spawn = vi.fn(async (childId: string): Promise<SubAgentResult> => {
            if (childId === 'planner') {
                return {
                    ok: true,
                    summary: 'planned',
                    data: [sampleDataSource],
                };
            }
            return {
                ok: true,
                summary: 'coded',
                data: {
                    kind: 'code',
                    code: '__output = top_customers.length;',
                },
            };
        });
        const ctx = makeCtx({
            controls: makeControls({ addPart, waitForApproval }),
            spawn,
        });
        const res = await def.toolExecutors.work_on_action!(baseInput, ctx);
        // The chat-side tool sees only the final approved outcome —
        // rejection is swallowed by the internal F3 loop. The model
        // never gets a `status: 'rejected-with-feedback'` shape now.
        expect(res.ok).toBe(true);
        if (res.ok) {
            expect(res.value).toMatchObject({
                actionId: expect.any(String),
                versionId: expect.any(String),
            });
            expect(res.value).not.toHaveProperty('status');
        }
        // Three confirmations happened: thumbs-down, the chat-typed feedback,
        // then the approval on the re-run.
        expect(waitForApproval).toHaveBeenCalledTimes(3);
        // Planner ran twice (initial + replan on rejection).
        const plannerCalls = spawn.mock.calls.filter((c) => c[0] === 'planner');
        expect(plannerCalls.length).toBeGreaterThanOrEqual(2);
        // Coder ran at least twice as well.
        const coderCalls = spawn.mock.calls.filter((c) => c[0] === 'coder');
        expect(coderCalls.length).toBeGreaterThanOrEqual(2);
    });

    it('rejected without feedback (hard cancel): returns ok:false with a cancel error, NO action-failed card', async () => {
        const addPart = vi.fn();
        const waitForApproval = vi.fn().mockResolvedValue({
            approved: false,
            response: { freeText: '' },
        });
        const def = orchestratorAgent();
        const spawn = vi.fn(async (childId: string): Promise<SubAgentResult> => {
            if (childId === 'planner') {
                return {
                    ok: true,
                    summary: 'planned',
                    data: [sampleDataSource],
                };
            }
            return {
                ok: true,
                summary: 'coded',
                data: {
                    kind: 'code',
                    code: '__output = top_customers.length;',
                },
            };
        });
        const ctx = makeCtx({
            controls: makeControls({ addPart, waitForApproval }),
            spawn,
        });
        const res = await def.toolExecutors.work_on_action!(baseInput, ctx);
        expect(res.ok).toBe(false);
        if (!res.ok) {
            expect(res.error).toMatch(/canceled/i);
        }
        const part = findFailurePart(addPart);
        expect(part).toBeUndefined();
    });

    it('persistence-error: pushes action-failed card and FAILED: error', async () => {
        const addPart = vi.fn();
        // Persistence happens AFTER the user thumbs-up. The review loop
        // builds a candidate, executes it, then asks via `waitForApproval`;
        // a successful approval gates the putAction call we want to throw.
        const waitForApproval = vi.fn().mockResolvedValue({ approved: true });
        (putAction as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('idb is full'));
        const def = orchestratorAgent();
        const spawn = vi.fn(async (childId: string): Promise<SubAgentResult> => {
            if (childId === 'planner') {
                return {
                    ok: true,
                    summary: 'planned',
                    data: [sampleDataSource],
                };
            }
            return {
                ok: true,
                summary: 'coded',
                data: {
                    kind: 'code',
                    code: '__output = top_customers.length;',
                },
            };
        });
        const ctx = makeCtx({
            controls: makeControls({ addPart, waitForApproval }),
            spawn,
        });
        const res = await def.toolExecutors.work_on_action!(baseInput, ctx);
        expect(res.ok).toBe(false);
        if (!res.ok) {
            expect(res.error).toMatch(/^FAILED:/);
            expect(res.error).toContain('idb is full');
        }
        const part = findFailurePart(addPart);
        expect(part).toMatchObject({
            kind: 'action-failed',
            reason: 'persistence-error',
            intent: baseInput.intent,
            actionName: baseInput.name,
            detail: 'idb is full',
        });
    });
});

/**
 * F1 regression guards. The chat model in log1.txt sometimes forgets
 * the prior actionName on follow-up `work_on_action` calls (or passes
 * the stub `'New Action'`). Without a runtime guard, the existing
 * draft is renamed and the chat orchestrator no longer recognizes it
 * as the same action — kicking the cascade that ultimately produces
 * the empty `ask_user` + 0-char response from the log.
 */
describe('F1: actionName guard in work_on_action', () => {
    const baseInput = {
        name: 'My Action',
        description: '',
        intent: 'Show me something useful',
    };
    // Suppress the `[drafts]` console.warn the guard emits — it would
    // otherwise pollute the test output. The warn is real behaviour
    // worth keeping in production logs, not in test stdout.
    let warnSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
        warnSpy.mockRestore();
    });

    it('keeps the prior actionName when the next call passes "New Action"', async () => {
        // Existing committed action: "Discount Impact on Order Quantity".
        const priorAction: Action = {
            id: 'action-1',
            name: 'Discount Impact on Order Quantity',
            description: '',
            code: '__output = 1;',
            dataSources: [
                {
                    id: 'ds-1',
                    name: sampleDataSource.name,
                    type: 'sql',
                    query: sampleDataSource.query,
                    semanticDescription: sampleDataSource.semanticDescription,
                    typeDeclaration: sampleDataSource.typeDeclaration,
                },
            ],
            chatLog: [],
            createdAt: 0,
            updatedAt: 0,
        };
        activeActionMock.mockReturnValue({
            id: 'action-1',
            actionName: 'Discount Impact on Order Quantity',
            intent: 'previous intent',
            action: priorAction,
            dataSources: [sampleDataSource],
            versions: [],
            inflight: false,
        });
        const beginDraftMock = (await import('@/lib/runtime/state/drafts'))
            .beginDraft as ReturnType<typeof vi.fn>;
        beginDraftMock.mockClear();

        const waitForApproval = vi.fn().mockResolvedValue({ approved: true });
        const spawn = vi.fn(async (childId: string): Promise<SubAgentResult> => {
            if (childId === 'planner') {
                return {
                    ok: true,
                    summary: 'planned',
                    data: [sampleDataSource],
                };
            }
            return {
                ok: true,
                summary: 'coded',
                data: {
                    kind: 'code',
                    code: '__output = top_customers.length;',
                },
            };
        });
        const ctx = makeCtx({
            controls: makeControls({ waitForApproval }),
            spawn,
        });
        const def = orchestratorAgent();
        await def.toolExecutors.work_on_action!({ ...baseInput, name: 'New Action' }, ctx);
        // The runtime must NOT have renamed the draft to "New Action".
        expect(beginDraftMock).toHaveBeenCalled();
        const beginDraftArgs = beginDraftMock.mock.calls[0]![0] as {
            actionName: string;
        };
        expect(beginDraftArgs.actionName).toBe('Discount Impact on Order Quantity');
    });

    it('accepts the model name on a fresh action (no prior draft)', async () => {
        activeActionMock.mockReturnValue(undefined);
        const beginDraftMock = (await import('@/lib/runtime/state/drafts'))
            .beginDraft as ReturnType<typeof vi.fn>;
        beginDraftMock.mockClear();

        const waitForApproval = vi.fn().mockResolvedValue({ approved: true });
        const spawn = vi.fn(async (childId: string): Promise<SubAgentResult> => {
            if (childId === 'planner') {
                return {
                    ok: true,
                    summary: 'planned',
                    data: [sampleDataSource],
                };
            }
            return {
                ok: true,
                summary: 'coded',
                data: {
                    kind: 'code',
                    code: '__output = 1;',
                },
            };
        });
        const ctx = makeCtx({
            controls: makeControls({ waitForApproval }),
            spawn,
        });
        const def = orchestratorAgent();
        await def.toolExecutors.work_on_action!({ ...baseInput, name: 'Fresh Title' }, ctx);
        const beginDraftArgs = beginDraftMock.mock.calls[0]![0] as {
            actionName: string;
        };
        expect(beginDraftArgs.actionName).toBe('Fresh Title');
    });
});

/**
 * F3 regression guard: the iteration loop must collapse multiple
 * intermediate failures into a SINGLE terminal `action-failed` card.
 * Before F3 each iteration emitted its own card, leaving the chat
 * thread with a stack of red banners after a single user turn.
 */
describe('F3: intermediate iteration failures do not leak action-failed cards', () => {
    const baseInput = {
        name: 'My Action',
        description: '',
        intent: 'Show me something',
    };

    it('aborts in iteration 0 + aborts again in iteration 1 -> exactly ONE terminal card', async () => {
        activeActionMock.mockReturnValue(undefined);
        const addPart = vi.fn();
        const waitForApproval = vi.fn().mockResolvedValue({ approved: true });
        // Planner emits a text turn starting with "ABORT:" on every
        // call. spawnSubAgent's F2 detector promotes that into an
        // aborted outcome; the iteration loop tries once more (with
        // the abort reason appended to the intent) then gives up.
        const spawn = vi.fn(async (childId: string): Promise<SubAgentResult> => {
            if (childId === 'planner') {
                return {
                    ok: true,
                    summary: 'ABORT: cannot answer with this schema',
                    data: {
                        kind: 'aborted',
                        reason: 'cannot answer with this schema',
                    },
                };
            }
            return {
                ok: true,
                summary: 'coded',
                data: {
                    kind: 'code',
                    code: '__output = 1;',
                },
            };
        });
        const ctx = makeCtx({
            controls: makeControls({ addPart, waitForApproval }),
            spawn,
        });
        const def = orchestratorAgent();
        const res = await def.toolExecutors.work_on_action!(baseInput, ctx);
        expect(res.ok).toBe(false);
        const failedParts = (addPart as ReturnType<typeof vi.fn>).mock.calls
            .map((c) => c[1])
            .filter(
                (p): p is { kind: 'action-failed'; reason: string } =>
                    (p as { kind?: string }).kind === 'action-failed',
            );
        expect(
            failedParts,
            'F3 regression: only ONE terminal action-failed card should reach the chat',
        ).toHaveLength(1);
        // Planner ran at least twice (initial + replan with augmented
        // intent) — that's the iteration loop doing its job.
        const plannerCalls = spawn.mock.calls.filter((c) => c[0] === 'planner');
        expect(plannerCalls.length).toBeGreaterThanOrEqual(2);
    });
});

/**
 * Regression: `mode: 'create_new'` against an already-committed action.
 *
 * Symptom: the chart fails at the analysis-review step with
 *   `ReferenceError: <name> is not defined`
 *   `bound data-source globals: (none)` (or the wrong set)
 *
 * Cause was that `dataSources` for executeAction was read off
 * `current.action.dataSources` whenever a committed action existed —
 * including on the Planner path where that array is stale. The Coder
 * writes code against the NEW previews; the runtime bound the OLD
 * (or empty) committed sources. Now `dataSources` derives from
 * `previews` on the Planner path even when an existing action is
 * being updated, while the action's id + metadata are still preserved.
 */
describe('orchestrator work_on_action: data sources on create_new over existing action', () => {
    const newSource: SavedDataSourcePreview = {
        ...sampleDataSource,
        name: 'avg_quantity_with_discount',
    };
    const newSource2: SavedDataSourcePreview = {
        ...sampleDataSource,
        name: 'avg_quantity_without_discount',
    };

    it('uses the new Planner previews for executeAction (not the stale committed dataSources)', async () => {
        // Mock.calls accumulates across tests in the same file; clear it
        // so we can inspect THIS test's call by index 0.
        executeActionMock.mockClear();
        // Simulate an active draft pointing at a committed action with
        // its own (different) data sources. This is the state the user
        // had when the bug fired: the previous attempt left a committed
        // action behind, then the next message arrived with the same
        // intent so the orchestrator picked mode='create_new'.
        const committedSource = {
            id: 'ds-stale-1',
            name: 'something_completely_different',
            type: 'sql' as const,
            query: 'SELECT 1',
            semanticDescription: '',
            typeDeclaration: '',
        };
        const committedAction: Action = {
            id: 'committed-action-id',
            name: 'My Action',
            description: '',
            dataSources: [committedSource],
            chatLog: [],
            createdAt: 0,
            updatedAt: 0,
            code: 'const x = something_completely_different;',
            kind: 'code',
            currentVersionId: 'committed-v-1',
        };
        activeActionMock.mockReturnValueOnce({
            id: committedAction.id,
            actionName: committedAction.name,
            intent: 'old intent',
            action: committedAction,
            dataSources: [],
            code: committedAction.code,
            codeKind: committedAction.kind,
            versions: [],
            currentVersionId: committedAction.currentVersionId,
            inflight: false,
        });
        executeActionMock.mockResolvedValueOnce({
            id: 'exec-create-new',
            actionId: committedAction.id,
            versionId: undefined as unknown as string,
            output: 'ok',
            error: null,
            createdAt: 0,
            // The fields below are required by ActionExecution but the
            // test only inspects the call arguments, not the result.
        } as unknown as Awaited<ReturnType<typeof executeActionMock>>);

        const waitForApproval = vi.fn().mockResolvedValue({ approved: true });
        const def = orchestratorAgent();
        const spawn = vi.fn(async (childId: string): Promise<SubAgentResult> => {
            if (childId === 'planner') {
                return {
                    ok: true,
                    summary: 'planned',
                    data: [newSource, newSource2],
                };
            }
            return {
                ok: true,
                summary: 'coded',
                data: {
                    kind: 'markdown',
                    template:
                        'avg w/  : ${avg_quantity_with_discount[0].x}, avg w/o: ${avg_quantity_without_discount[0].x}',
                },
            };
        });
        const ctx = makeCtx({
            controls: makeControls({ waitForApproval }),
            spawn,
        });
        const res = await def.toolExecutors.work_on_action!(
            {
                name: 'My Action',
                description: '',
                intent: 'Same intent again',
                mode: 'create_new',
            },
            ctx,
        );
        expect(res.ok).toBe(true);

        // executeAction must be called with the NEW previews' names, not
        // the stale committed `something_completely_different`.
        const exec = executeActionMock.mock.calls[0]?.[0] as
            | { dataSources: Array<{ name: string }> }
            | undefined;
        expect(exec).toBeDefined();
        const boundNames = (exec!.dataSources ?? []).map((d) => d.name).sort();
        expect(boundNames).toEqual(['avg_quantity_with_discount', 'avg_quantity_without_discount']);
        // Sanity: the stale source from the committed action must NOT
        // leak through.
        expect(boundNames).not.toContain('something_completely_different');

        // The action id is preserved so this is an update to the
        // existing action, not a new one.
        expect((exec as unknown as { id: string }).id).toBe(committedAction.id);
    });
});

/**
 * Samples are agent-runtime only. They must never appear on the persisted
 * Action or ActionVersion — putting perturbed/synthetic rows there made
 * the Action panel render synthetic data as "results" after reload.
 */
describe('orchestrator work_on_action: sample-data isolation', () => {
    it('persisted Action.dataSources carry no `sampleData` (samples stay in the agent runtime)', async () => {
        executeActionMock.mockClear();
        activeActionMock.mockReturnValueOnce(undefined);
        const waitForApproval = vi.fn().mockResolvedValue({ approved: true });
        const def = orchestratorAgent();
        const previewWithSamples: SavedDataSourcePreview = {
            ...sampleDataSource,
            sampleColumns: ['id', 'revenue'],
            sampleRows: [
                { id: 1, revenue: 100 },
                { id: 2, revenue: 90 },
            ],
        };
        const spawn = vi.fn(async (childId: string): Promise<SubAgentResult> => {
            if (childId === 'planner') {
                return {
                    ok: true,
                    summary: 'planned',
                    data: [previewWithSamples],
                };
            }
            return {
                ok: true,
                summary: 'coded',
                data: { kind: 'code', code: '__output = 1;' },
            };
        });
        const ctx = makeCtx({
            controls: makeControls({ waitForApproval }),
            spawn,
        });
        const putActionMock = putAction as ReturnType<typeof vi.fn>;
        putActionMock.mockClear();
        await def.toolExecutors.work_on_action!(
            {
                name: 'My Action',
                description: '',
                intent: 'show me anything',
                mode: 'auto',
            },
            ctx,
        );

        // Inspect both the executor's argument and the persisted Action:
        // neither should carry sample rows or sample columns. The previews
        // (with their sanitized samples) live ONLY in the agent's draft
        // state, never on the Action.
        const execArg = executeActionMock.mock.calls[0]?.[0] as
            | { dataSources: Array<Record<string, unknown>> }
            | undefined;
        for (const ds of execArg?.dataSources ?? []) {
            expect(ds.sampleData).toBeUndefined();
        }

        const putArg = putActionMock.mock.calls[0]?.[0] as
            | { dataSources: Array<Record<string, unknown>> }
            | undefined;
        expect(putArg).toBeDefined();
        for (const ds of putArg?.dataSources ?? []) {
            expect(ds.sampleData).toBeUndefined();
        }
    });
});

/**
 * Regression: replan after a user rejection must pass the in-progress
 * draft's data sources to the Planner. The original bug:
 *   1. User typed a question → orchestrator → Planner saved 1 source →
 *      Coder produced a chart → review card shown.
 *   2. User rejected with "add breakdown by product category".
 *   3. Orchestrator re-called `work_on_action` with mode='create_new'.
 *   4. Planner cold-started: it called list_tables once, then bailed
 *      with no `save_data_source` because nothing in its kickoff told
 *      it "extend this existing set" — the new intent ("...broken down
 *      by category") read as half a sentence without the prior state.
 *   5. work_on_action returned `planner-empty`. User saw "action failed".
 *
 * The fix moves two pieces of context across the rejection→replan
 * boundary: (a) the prior previews are passed into the Planner spawn so
 * the Planner can EXTEND rather than start over, and (b) the prior code
 * is passed into the Coder kickoff so it can edit minimally even though
 * the Planner re-ran.
 */
describe('orchestrator work_on_action: replan-after-rejection carries prior draft state', () => {
    const priorSource: SavedDataSourcePreview = {
        ...sampleDataSource,
        name: 'avg_quantity_by_discount_status',
        query: "SELECT CASE WHEN Discount > 0 THEN 'Discount Applied' ELSE 'No Discount' END AS DiscountStatus, AVG(Quantity) AS AverageQuantity FROM \"Order Details\" GROUP BY DiscountStatus",
        sampleColumns: ['DiscountStatus', 'AverageQuantity'],
        sampleRows: [
            { DiscountStatus: 'A', AverageQuantity: 25.5 },
            { DiscountStatus: 'B', AverageQuantity: 25.5 },
        ],
    };
    const rejectedCode =
        "const labels = avg_quantity_by_discount_status.map(r => r.DiscountStatus);\n__output = { xAxis: { type: 'category', data: labels }, yAxis: { type: 'value' }, series: [{ type: 'bar', data: avg_quantity_by_discount_status.map(r => r.AverageQuantity) }] };";

    it('passes prior previews to the Planner kickoff context + adds them to the kickoff instruction', async () => {
        executeActionMock.mockClear();
        // Simulate the post-rejection state: a live draft exists with
        // the Planner's first source and the rejected Coder code, but
        // no committed action / version yet (the user clicked No).
        activeActionMock.mockReturnValueOnce({
            id: 'draft-1',
            actionName: 'Discount impact on order quantity',
            intent: 'previous intent',
            action: undefined,
            dataSources: [priorSource],
            code: rejectedCode,
            codeKind: 'code',
            versions: [],
            currentVersionId: undefined,
            inflight: false,
        });
        const waitForApproval = vi.fn().mockResolvedValue({ approved: true });
        const def = orchestratorAgent();

        const plannerSpy = vi.fn();
        const coderSpy = vi.fn();
        const spawn = vi.fn(
            async (
                childId: string,
                kickoff: { instruction: string; context?: Record<string, unknown> },
            ): Promise<SubAgentResult> => {
                if (childId === 'planner') {
                    plannerSpy(kickoff);
                    // Simulate the Planner adding ONE new source on top
                    // of the seeded set (the orchestrator hands off
                    // whatever the planner returns — in production the
                    // planner.test cases assert the seeding/handoff).
                    return {
                        ok: true,
                        summary: 'extended',
                        data: [
                            priorSource,
                            {
                                ...sampleDataSource,
                                name: 'avg_quantity_by_category_and_discount',
                            },
                        ],
                    };
                }
                coderSpy(kickoff);
                return {
                    ok: true,
                    summary: 'coded',
                    data: {
                        kind: 'code',
                        code: '__output = avg_quantity_by_category_and_discount;',
                    },
                };
            },
        );
        const ctx = makeCtx({
            controls: makeControls({ waitForApproval }),
            spawn,
        });
        await def.toolExecutors.work_on_action!(
            {
                name: 'Discount impact on order quantity',
                description: '',
                intent: 'Compare the average quantity of products ordered when a discount is applied versus when no discount is applied, broken down by product category.',
                mode: 'create_new',
            },
            ctx,
        );

        // Planner got the prior previews via kickoff context (so its
        // state can pre-seed `state.drafts`).
        expect(plannerSpy).toHaveBeenCalledOnce();
        const plannerKickoff = plannerSpy.mock.calls[0]![0]!;
        expect(plannerKickoff.context).toMatchObject({
            existingPreviews: [priorSource],
        });
        // And the kickoff instruction explicitly labels itself a REPLAN
        // and lists the prior sources so the model knows to extend.
        expect(plannerKickoff.instruction).toMatch(/REPLAN/);
        expect(plannerKickoff.instruction).toContain(priorSource.name);
        // Plus the previous code so the Planner can see how the sources
        // were being consumed when picking what to keep/rename.
        expect(plannerKickoff.instruction).toContain('Previous code step');

        // Coder also receives the prior code as `previousCode` even
        // though canIterate=false (mode='create_new') — the rejected
        // chart's structure is still the right starting point.
        expect(coderSpy).toHaveBeenCalledOnce();
        const coderKickoff = coderSpy.mock.calls[0]![0]!;
        expect(coderKickoff.context).toMatchObject({
            previousCode: rejectedCode,
        });
        expect(coderKickoff.instruction).toContain('Previous code for this action');
    });

    it('cold start (no prior draft): planner kickoff is bare intent, no REPLAN block, no existingPreviews in context', async () => {
        executeActionMock.mockClear();
        activeActionMock.mockReturnValueOnce(undefined);
        const waitForApproval = vi.fn().mockResolvedValue({ approved: true });
        const def = orchestratorAgent();
        const plannerSpy = vi.fn();
        const spawn = vi.fn(
            async (
                childId: string,
                kickoff: { instruction: string; context?: Record<string, unknown> },
            ): Promise<SubAgentResult> => {
                if (childId === 'planner') {
                    plannerSpy(kickoff);
                    return {
                        ok: true,
                        summary: 'planned',
                        data: [sampleDataSource],
                    };
                }
                return {
                    ok: true,
                    summary: 'coded',
                    data: { kind: 'code', code: '__output = 1;' },
                };
            },
        );
        const ctx = makeCtx({
            controls: makeControls({ waitForApproval }),
            spawn,
        });
        await def.toolExecutors.work_on_action!(
            {
                name: 'Fresh action',
                description: '',
                intent: 'show me top customers by revenue',
                mode: 'create_new',
            },
            ctx,
        );
        const plannerKickoff = plannerSpy.mock.calls[0]![0]!;
        expect(plannerKickoff.instruction).not.toMatch(/REPLAN/);
        expect(plannerKickoff.instruction).toBe('show me top customers by revenue');
        expect(plannerKickoff.context).toMatchObject({
            existingPreviews: [],
        });
    });
});

describe('buildPlannerKickoffInstruction', () => {
    // Inline lookup so the test file doesn't grow another import surface;
    // also gives us a chance to assert the helper is exported (the
    // orchestrator's regression test above already covers the
    // integration path, this just nails down the shape).
    it('with no existing previews: returns the intent verbatim', async () => {
        const { buildPlannerKickoffInstruction } = await import('./orchestrator');
        expect(buildPlannerKickoffInstruction('do X', [], undefined)).toBe('do X');
    });

    it('with existing previews: emits a REPLAN block listing names + SQL', async () => {
        const { buildPlannerKickoffInstruction } = await import('./orchestrator');
        const out = buildPlannerKickoffInstruction(
            'add breakdown by category',
            [sampleDataSource],
            'const x = top_customers.length;',
        );
        expect(out).toMatch(/REPLAN/);
        expect(out).toContain(sampleDataSource.name);
        expect(out).toContain(sampleDataSource.query);
        expect(out).toContain('add breakdown by category');
        // Hand-off contract the Planner depends on:
        expect(out).toMatch(/Reuse names where the underlying SQL is unchanged/);
        // Previous code is surfaced so the Planner sees how the sources
        // were consumed when deciding what to rename / keep.
        expect(out).toContain('const x = top_customers.length;');
    });
});
