import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunCtx } from '../agent-def';
import type { AgentControls } from '../loop';
import type { SavedDataSourcePreview } from '@/lib/types';

// `saveDataSourceExecutor` resolves a DB via `resolveDb` to validate SQL
// and sample rows. The Planner agent's other tools are wrapped versions
// of executeAgentTool — they take the same DB path. Mock both.
const resolverMock = vi.hoisted(() => ({
    resolveDb: vi.fn(),
}));
vi.mock('@/lib/data-sources/resolver', () => ({
    resolveDb: resolverMock.resolveDb,
}));

const sanitizerMock = vi.hoisted(() => ({
    sanitize: vi.fn((raw: unknown) => raw),
}));
vi.mock('../sample-sanitizer', () => ({
    getActiveSanitizer: () => ({ sanitize: sanitizerMock.sanitize }),
}));

// `pushDataSources` writes to the live drafts store. The Planner state
// already handles the in-memory draft array; the broadcast is a side
// effect we don't need under test.
vi.mock('@/lib/runtime/state/drafts', () => ({
    pushDataSources: vi.fn(),
}));

import { plannerAgent } from './planner';

const sourceWithDiscountOnly: SavedDataSourcePreview = {
    name: 'average_quantity_by_discount_status',
    query: "SELECT CASE WHEN Discount > 0 THEN 'Discount Applied' ELSE 'No Discount' END AS DiscountStatus, AVG(Quantity) AS AverageQuantity FROM \"Order Details\" GROUP BY DiscountStatus",
    semanticDescription: 'Average quantity grouped by whether a discount was applied.',
    typeDeclaration:
        'type AvgQuantityByDiscountStatus = Array<{ DiscountStatus: string; AverageQuantity: number }>;\ndeclare const average_quantity_by_discount_status: AvgQuantityByDiscountStatus;',
    sampleColumns: ['DiscountStatus', 'AverageQuantity'],
    sampleRows: [
        { DiscountStatus: 'D******* A******', AverageQuantity: 25.5 },
        { DiscountStatus: 'N* D*******', AverageQuantity: 25.5 },
    ],
    truncated: false,
};

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

describe('planner agent: kickoff seeding for replan', () => {
    beforeEach(() => {
        resolverMock.resolveDb.mockReset();
    });

    it('pre-seeds state.drafts with `existingPreviews` from the kickoff context', async () => {
        // The orchestrator passes `existingPreviews` on a mode='create_new'
        // replan. The Planner must adopt them as its starting drafts so
        // (a) the Coder hand-off includes them even if the Planner only
        // adds new sources, and (b) the dedupe-by-name logic in the
        // save_data_source executor can REPLACE one without losing the
        // others.
        const def = plannerAgent();
        const ctx = makeCtx({
            runState: {
                kickoff: {
                    actionName: 'Discount impact',
                    draftId: 'draft-1',
                    existingPreviews: [sourceWithDiscountOnly],
                },
            },
        });

        // No tool call needed — the seeding happens lazily on the first
        // state access. Trigger it via the idle-turn hook, which is the
        // first thing the loop calls when the model emits text-only.
        // With seeded drafts present, the hook should NOT exit empty:
        // it should hand off the seeded set as the finalResult.
        const idle = def.onIdleTurn!;
        const outcome = await idle(ctx);
        expect(outcome.continue).toBe(false);
        expect(ctx.runState.finalResult).toEqual([sourceWithDiscountOnly]);
    });

    it('NO existingPreviews: state.drafts starts empty and the idle hook nudges (not exits silently)', async () => {
        // Cold start — this is the regression case: the model called
        // list_tables, then emitted text-only without saving anything.
        // The old hook returned `{ continue: false }` silently; the
        // spawner then reported `planner-empty` with no signal to the
        // user about what went wrong. The new hook nudges first.
        const def = plannerAgent();
        const ctx = makeCtx({
            runState: { kickoff: { draftId: 'draft-1' } },
        });
        const idle = def.onIdleTurn!;
        const first = await idle(ctx);
        expect(first.continue).toBe(true);
        expect(first.feedbackForLLM).toMatch(/save_data_source/);
        expect(first.feedbackForLLM).toMatch(/ABORT:/);
    });

    it('NO existingPreviews: idle hook gives up after MAX_EMPTY_IDLE_RETRIES (2) nudges', async () => {
        // Bounded retries prevent a model stuck in text-only mode from
        // looping forever. After two unanswered nudges the run exits
        // and the spawner reports `planner-empty`.
        const def = plannerAgent();
        const ctx = makeCtx({
            runState: { kickoff: { draftId: 'draft-1' } },
        });
        const idle = def.onIdleTurn!;
        await idle(ctx); // nudge 1
        await idle(ctx); // nudge 2
        const third = await idle(ctx);
        expect(third.continue).toBe(false);
        expect(third.feedbackForLLM).toBeUndefined();
        // No finalResult set: the spawner will see undefined and surface
        // `planner-empty`.
        expect(ctx.runState.finalResult).toBeUndefined();
    });

    it('REPLAN with NO model action: hands off the seeded set verbatim (untouched is the legitimate hand-off)', async () => {
        // The model can rightfully decide the existing sources already
        // answer (part of) the new intent and only need to be combined
        // differently by the Coder. In that case it makes no tool calls
        // and emits text. The hook must NOT nudge here — the seeded
        // drafts are a valid hand-off.
        const def = plannerAgent();
        const ctx = makeCtx({
            runState: {
                kickoff: {
                    draftId: 'draft-1',
                    existingPreviews: [sourceWithDiscountOnly],
                },
            },
        });
        const idle = def.onIdleTurn!;
        const outcome = await idle(ctx);
        expect(outcome.continue).toBe(false);
        expect(outcome.feedbackForLLM).toBeUndefined();
        expect(ctx.runState.finalResult).toEqual([sourceWithDiscountOnly]);
    });

    it('REPLAN + save_data_source(same name, new SQL): replaces the seeded source in-place (no duplicate)', async () => {
        // The user asked for "breakdown by product category". The model
        // re-saves `average_quantity_by_discount_status` with extended
        // SQL (joining Products + Categories). The replacement keeps
        // the same name so the Coder's previous code can keep referring
        // to it; the dedupe-by-name in saveDataSourceExecutor preserves
        // exactly one entry under that name.
        const replacementName = sourceWithDiscountOnly.name;
        const replacementSql =
            "SELECT c.CategoryName, CASE WHEN od.Discount > 0 THEN 'Discount Applied' ELSE 'No Discount' END AS DiscountStatus, AVG(od.Quantity) AS AverageQuantity FROM \"Order Details\" od JOIN Products p ON od.ProductID = p.ProductID JOIN Categories c ON p.CategoryID = c.CategoryID GROUP BY c.CategoryName, DiscountStatus";
        resolverMock.resolveDb.mockResolvedValue({
            validateQuery: vi.fn(async () => ({ ok: true })),
            execQuery: vi.fn(async () => ({
                columns: ['CategoryName', 'DiscountStatus', 'AverageQuantity'],
                declaredTypes: ['', '', ''],
                rows: [
                    {
                        CategoryName: 'A',
                        DiscountStatus: 'D**',
                        AverageQuantity: 12,
                    },
                ],
                truncated: false,
            })),
        });

        const def = plannerAgent();
        const ctx = makeCtx({
            runState: {
                kickoff: {
                    draftId: 'draft-1',
                    existingPreviews: [sourceWithDiscountOnly],
                },
            },
        });

        const exec = def.toolExecutors.save_data_source!;
        const res = await exec(
            {
                name: replacementName,
                query: replacementSql,
                semantic_description:
                    'Average quantity broken down by product category and discount status.',
            },
            ctx,
        );
        expect(res.ok).toBe(true);

        // The seeded set had one entry under this name; the replacement
        // must be the only entry under that name afterward.
        const idle = def.onIdleTurn!;
        await idle(ctx);
        const handoff = ctx.runState.finalResult as SavedDataSourcePreview[];
        const matches = handoff.filter((p) => p.name === replacementName);
        expect(matches).toHaveLength(1);
        expect(matches[0]!.query).toBe(replacementSql);
        // And it carries the NEW columns / sample, not the seeded ones.
        expect(matches[0]!.sampleColumns).toEqual([
            'CategoryName',
            'DiscountStatus',
            'AverageQuantity',
        ]);
    });

    it('REPLAN + save_data_source(new name): appends to the seeded set without disturbing the existing entry', async () => {
        resolverMock.resolveDb.mockResolvedValue({
            validateQuery: vi.fn(async () => ({ ok: true })),
            execQuery: vi.fn(async () => ({
                columns: ['CategoryName', 'AverageQuantity'],
                declaredTypes: ['', ''],
                rows: [{ CategoryName: 'A', AverageQuantity: 10 }],
                truncated: false,
            })),
        });

        const def = plannerAgent();
        const ctx = makeCtx({
            runState: {
                kickoff: {
                    draftId: 'draft-1',
                    existingPreviews: [sourceWithDiscountOnly],
                },
            },
        });
        const exec = def.toolExecutors.save_data_source!;
        await exec(
            {
                name: 'avg_quantity_by_category',
                query: 'SELECT c.CategoryName, AVG(od.Quantity) AS AverageQuantity FROM "Order Details" od JOIN Products p ON od.ProductID = p.ProductID JOIN Categories c ON p.CategoryID = c.CategoryID GROUP BY c.CategoryName',
                semantic_description: 'Average quantity per category.',
            },
            ctx,
        );

        const idle = def.onIdleTurn!;
        await idle(ctx);
        const handoff = ctx.runState.finalResult as SavedDataSourcePreview[];
        expect(handoff.map((p) => p.name).sort()).toEqual([
            'average_quantity_by_discount_status',
            'avg_quantity_by_category',
        ]);
    });
});

describe('planner prompt covers the replan extend-mode contract', () => {
    it('the system prompt explicitly explains REPLAN MODE so the model knows when to extend vs cold-start', () => {
        const def = plannerAgent();
        const prompt = def.systemPrompt as string;
        expect(prompt).toMatch(/REPLAN MODE/);
        // The two key behaviors the orchestrator depends on:
        expect(prompt).toMatch(/already seeded into your drafts/i);
        expect(prompt).toMatch(/Reuse names where the SQL is unchanged/i);
        // ABORT path is the escape hatch when the schema can't support
        // the intent (replaces the previous "respond with text and exit
        // silently" behavior that hid failures).
        expect(prompt).toMatch(/ABORT:/);
    });
});
