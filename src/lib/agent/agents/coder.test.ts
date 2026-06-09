import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunCtx } from '../agent-def';
import type { AgentControls } from '../loop';
import type { SavedDataSourcePreview } from '@/lib/types';
import type { SandboxResult } from '@/lib/sandbox/runtime';

const sandboxMock = vi.hoisted(() => ({
    run: vi.fn<
        (args: { code: string; globals?: Record<string, unknown> }) => Promise<SandboxResult>
    >(),
}));

vi.mock('@/lib/sandbox/runtime', () => ({
    runInSandbox: sandboxMock.run,
}));

type ValidateResult =
    | { ok: true; warnings: string[] }
    | { ok: false; error: string; warnings: string[] };

const echartsValidateMock = vi.hoisted(() => ({
    validate: vi.fn<(option: Record<string, unknown>) => Promise<ValidateResult>>(),
}));

vi.mock('../echarts-validate', () => ({
    validateEchartsOption: echartsValidateMock.validate,
}));

import { coderAgent } from './coder';

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

const sampleDataSource: SavedDataSourcePreview = {
    name: 'top_customers',
    query: 'SELECT * FROM customers',
    semanticDescription: 'top customers',
    typeDeclaration:
        'type TopCustomers = Array<{ id: number; }>;\ndeclare const top_customers: TopCustomers;',
    sampleColumns: ['id'],
    sampleRows: [{ id: 1 }, { id: 2 }],
    truncated: false,
};

function seededCtx(controlOverrides: Partial<AgentControls> = {}): AgentRunCtx {
    return makeCtx({
        controls: makeControls(controlOverrides),
        runState: { kickoff: { dataSources: [sampleDataSource] } },
    });
}

describe('coder run_in_sandbox executor', () => {
    beforeEach(() => {
        sandboxMock.run.mockReset();
        echartsValidateMock.validate.mockReset();
    });

    it('on user-code error: focused window around the throwing line, labelled user-code phase', async () => {
        sandboxMock.run.mockResolvedValue({
            ok: false,
            phase: 'user-code',
            error: 'ReferenceError: foo is not defined',
            stack: '    at <user-code>:2:5',
            line: 2,
            stdout: [],
        });
        const waitForApproval = vi.fn();
        const def = coderAgent();
        const ctx = seededCtx({ waitForApproval });
        const userCode = 'const x = 1;\nfoo();\n__output = x;';
        const res = await def.toolExecutors.run_in_sandbox!({ code: userCode }, ctx);
        expect(res.ok).toBe(false);
        if (!res.ok) {
            expect(res.error).toMatch(/phase: user-code/);
            expect(res.error).toMatch(/line: 2/);
            expect(res.error).toMatch(/ReferenceError/);
            expect(res.error).toMatch(/>>>\s+2 \| foo\(\);/);
            expect(res.error).toMatch(/1 \| const x = 1;/);
            expect(res.error).toMatch(/run_in_sandbox/);
        }
        expect(waitForApproval).not.toHaveBeenCalled();
    });

    it('on parse error: surfaces the QuickJS message with the full source', async () => {
        sandboxMock.run.mockResolvedValue({
            ok: false,
            phase: 'parse',
            error: 'SyntaxError: unexpected end of string',
            stdout: [],
        });
        const def = coderAgent();
        const ctx = seededCtx();
        const userCode = "let s = 'unterminated";
        const res = await def.toolExecutors.run_in_sandbox!({ code: userCode }, ctx);
        expect(res.ok).toBe(false);
        if (!res.ok) {
            expect(res.error).toMatch(/phase: parse/);
            expect(res.error).toMatch(/SyntaxError/);
            expect(res.error).toMatch(/ {3}1 \| let s = 'unterminated/);
        }
    });

    it('on sandbox success terminates the coder without emitting a confirmation card', async () => {
        sandboxMock.run.mockResolvedValue({
            ok: true,
            output: 'final markdown',
            stdout: ['debug a'],
        });
        const addPart = vi.fn();
        const waitForApproval = vi.fn();
        const def = coderAgent();
        const ctx = seededCtx({ addPart, waitForApproval });

        const res = await def.toolExecutors.run_in_sandbox!({ code: 'noop' }, ctx);

        expect(res.ok).toBe(true);
        expect((res as { terminate?: boolean }).terminate).toBe(true);
        // The orchestrator's review loop owns the thumbs-up/down card now.
        expect(addPart).not.toHaveBeenCalled();
        expect(waitForApproval).not.toHaveBeenCalled();
    });

    it('on success stashes finalResult { kind: "code", code } (no action field)', async () => {
        sandboxMock.run.mockResolvedValue({
            ok: true,
            output: 'x',
            stdout: [],
        });
        const def = coderAgent();
        const ctx = seededCtx();
        const res = await def.toolExecutors.run_in_sandbox!({ code: 'noop' }, ctx);
        expect(res.ok).toBe(true);
        expect((res as { terminate?: boolean }).terminate).toBe(true);
        const fr = ctx.runState.finalResult as Record<string, unknown>;
        expect(fr).toEqual({ kind: 'code', code: 'noop' });
    });

    it('binds each data source sampleRows as a named global', async () => {
        sandboxMock.run.mockResolvedValue({
            ok: true,
            output: null,
            stdout: [],
        });
        const def = coderAgent();
        const ctx = makeCtx({
            controls: makeControls(),
            runState: {
                kickoff: {
                    dataSources: [
                        sampleDataSource,
                        {
                            ...sampleDataSource,
                            name: 'revenue_by_month',
                            sampleRows: [{ month: '2024-01-??', revenue: 1 }],
                        },
                    ],
                },
            },
        });
        await def.toolExecutors.run_in_sandbox!({ code: 'noop' }, ctx);
        const call = sandboxMock.run.mock.calls[0]?.[0];
        expect(call?.globals).toEqual({
            top_customers: sampleDataSource.sampleRows,
            revenue_by_month: [{ month: '2024-01-??', revenue: 1 }],
        });
    });

    it("passes TypeScript code through to the runtime unchanged (stripping is the runtime's job)", async () => {
        sandboxMock.run.mockResolvedValue({
            ok: true,
            output: 42,
            stdout: [],
        });
        const def = coderAgent();
        const ctx = seededCtx();
        const tsCode = 'const x: number = 41; __output = x + 1;';
        const res = await def.toolExecutors.run_in_sandbox!({ code: tsCode }, ctx);
        expect(res.ok).toBe(true);
        const call = sandboxMock.run.mock.calls[0]?.[0];
        expect(call?.code).toBe(tsCode);
    });

    it('returns error when kickoff seeded no data sources', async () => {
        const def = coderAgent();
        const ctx = makeCtx({ runState: {} });
        const res = await def.toolExecutors.run_in_sandbox!({ code: 'noop' }, ctx);
        expect(res.ok).toBe(false);
        if (!res.ok) {
            expect(res.error).toMatch(/No data sources/);
        }
        expect(sandboxMock.run).not.toHaveBeenCalled();
    });
});

describe('coder unified prompt + validate_echarts', () => {
    beforeEach(() => {
        sandboxMock.run.mockReset();
        echartsValidateMock.validate.mockReset();
    });

    it('prompt covers the block model (md/chart/table + present) in a single unified prompt', () => {
        const def = coderAgent();
        // All render paths are mentioned.
        expect(def.systemPrompt).toMatch(/markdown/i);
        expect(def.systemPrompt).toMatch(/ECharts/);
        expect(def.systemPrompt).toMatch(/validate_echarts/);
        // The block builders + collector are documented.
        expect(def.systemPrompt).toMatch(/present\(/);
        expect(def.systemPrompt).toMatch(/\btable\(/);
        expect(def.systemPrompt).toMatch(/\bchart\(/);
        expect(def.systemPrompt).toMatch(/\bmd\(/);
        // All tables go to the grid — never hand-built in markdown.
        expect(def.systemPrompt).toMatch(/never hand-build a markdown/i);
        // No mention of the old output_format / notes fields.
        expect(def.systemPrompt).not.toMatch(/output_format/);
        expect(def.systemPrompt).not.toMatch(/`notes`/);
    });

    it('always exposes both tools (run_in_sandbox + validate_echarts)', () => {
        const def = coderAgent();
        expect(def.tools.run_in_sandbox).toBeDefined();
        expect(def.tools.validate_echarts).toBeDefined();
    });

    it('Coder prompt uses native function calling (no fence-syntax artifacts)', () => {
        const def = coderAgent();
        expect(def.systemPrompt).toMatch(/TOOL CALLING/);
        expect(def.systemPrompt).toMatch(
            /Use the function-calling tools provided by the runtime\./,
        );
        // Fence syntax must NOT be in the prompt — Nano + fence mode have been
        // removed from the codebase, so any TOOL_CALL marker would be stale.
        expect(def.systemPrompt).not.toMatch(/<<<TOOL_CALL/);
        expect(def.systemPrompt).not.toMatch(/<<<END_TOOL_CALL/);
    });

    it('validate_echarts executor returns ok with warnings on a valid option', async () => {
        echartsValidateMock.validate.mockResolvedValue({
            ok: true,
            warnings: [],
        });
        const def = coderAgent();
        const ctx = seededCtx();
        const res = await def.toolExecutors.validate_echarts!(
            { option: { xAxis: {}, yAxis: {}, series: [{ type: 'line', data: [] }] } },
            ctx,
        );
        expect(res.ok).toBe(true);
        if (res.ok) {
            expect(res.value).toEqual({ warnings: [] });
        }
        expect(echartsValidateMock.validate).toHaveBeenCalledOnce();
    });

    it('validate_echarts executor surfaces the validator error verbatim with warnings', async () => {
        echartsValidateMock.validate.mockResolvedValue({
            ok: false,
            error: 'series[0].type "noodleplot" is not registered',
            warnings: ['axis index mismatch'],
        });
        const def = coderAgent();
        const ctx = seededCtx();
        const res = await def.toolExecutors.validate_echarts!(
            { option: { series: [{ type: 'noodleplot' }] } },
            ctx,
        );
        expect(res.ok).toBe(false);
        if (!res.ok) {
            expect(res.error).toMatch(/noodleplot/);
            expect(res.error).toMatch(/echarts_validation_error/);
            expect(res.error).toMatch(/axis index mismatch/);
        }
    });

    it('run_in_sandbox returns a focused error (does NOT throw) when `code` is missing', async () => {
        const def = coderAgent();
        const ctx = seededCtx();
        const res = await def.toolExecutors.run_in_sandbox!(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            {} as any,
            ctx,
        );
        expect(res.ok).toBe(false);
        if (!res.ok) {
            expect(res.error).toMatch(/input_validation_error/);
            expect(res.error).toMatch(/code/);
            expect(res.error).toMatch(/Required: `code`/);
        }
        expect(sandboxMock.run).not.toHaveBeenCalled();
    });

    it('validate_echarts auto-unwraps top-level ECharts keys when `option` is missing', async () => {
        echartsValidateMock.validate.mockResolvedValue({
            ok: true,
            warnings: [],
        });
        const def = coderAgent();
        const ctx = seededCtx();
        const topLevelOption = {
            xAxis: { type: 'category', data: ['a', 'b'] },
            yAxis: { type: 'value' },
            series: [{ type: 'bar', data: [1, 2] }],
        };
        const res = await def.toolExecutors.validate_echarts!(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            topLevelOption as any,
            ctx,
        );
        expect(res.ok).toBe(true);
        expect(echartsValidateMock.validate).toHaveBeenCalledWith(topLevelOption);
    });

    it('validate_echarts passes empty `{}` through to ECharts instead of looping on input_validation_error', async () => {
        echartsValidateMock.validate.mockResolvedValue({
            ok: true,
            warnings: [],
        });
        const def = coderAgent();
        const ctx = seededCtx();
        const res = await def.toolExecutors.validate_echarts!(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            {} as any,
            ctx,
        );
        expect(res.ok).toBe(true);
        expect(echartsValidateMock.validate).toHaveBeenCalledWith({});
    });

    it('run_in_sandbox finalizes without asking for user approval (orchestrator owns the review now)', async () => {
        const optionOutput = {
            xAxis: { type: 'category', data: ['a', 'b'] },
            yAxis: { type: 'value' },
            series: [{ type: 'line', data: [1, 2] }],
        };
        sandboxMock.run.mockResolvedValue({
            ok: true,
            output: optionOutput,
            stdout: [],
        });
        const addPart = vi.fn();
        const waitForApproval = vi.fn();
        const def = coderAgent();
        const ctx = seededCtx({ addPart, waitForApproval });

        const code =
            '__output = {xAxis:{type:"category",data:["a","b"]},yAxis:{type:"value"},series:[{type:"line",data:[1,2]}]};';
        const res = await def.toolExecutors.run_in_sandbox!({ code }, ctx);

        expect(res.ok).toBe(true);
        expect((res as { terminate?: boolean }).terminate).toBe(true);
        // No confirmation card emitted by the coder — review is the
        // orchestrator's responsibility now.
        expect(addPart).not.toHaveBeenCalled();
        expect(waitForApproval).not.toHaveBeenCalled();

        const fr = ctx.runState.finalResult as Record<string, unknown>;
        expect(fr).toEqual({ kind: 'code', code });
    });
});

describe('coder save_markdown_action executor', () => {
    beforeEach(() => {
        sandboxMock.run.mockReset();
        echartsValidateMock.validate.mockReset();
    });

    it('wraps the template as __output = `<template>` and runs it through the sandbox', async () => {
        sandboxMock.run.mockResolvedValue({
            ok: true,
            output: 'Rows: 2',
            stdout: [],
        });
        const def = coderAgent();
        const ctx = seededCtx();
        const res = await def.toolExecutors.save_markdown_action!(
            { template: 'Rows: ${top_customers.length}' },
            ctx,
        );
        expect(res.ok).toBe(true);
        const call = sandboxMock.run.mock.calls[0]?.[0];
        expect(call?.code).toBe('__output = `Rows: ${top_customers.length}`;');
        // Data sources bound as named globals (sampleRows).
        expect(call?.globals).toEqual({
            top_customers: sampleDataSource.sampleRows,
        });
    });

    it('on validation success stashes finalResult { kind: "markdown", template } (no review card)', async () => {
        sandboxMock.run.mockResolvedValue({
            ok: true,
            output: '...',
            stdout: [],
        });
        const addPart = vi.fn();
        const waitForApproval = vi.fn();
        const def = coderAgent();
        const ctx = seededCtx({ addPart, waitForApproval });
        const res = await def.toolExecutors.save_markdown_action!({ template: 'hi' }, ctx);
        expect(res.ok).toBe(true);
        expect((res as { terminate?: boolean }).terminate).toBe(true);
        const fr = ctx.runState.finalResult as Record<string, unknown>;
        expect(fr).toEqual({ kind: 'markdown', template: 'hi' });
        // The coder does NOT ask for approval — the orchestrator handles
        // the thumbs-up/down review after executing against real data.
        expect(addPart).not.toHaveBeenCalled();
        expect(waitForApproval).not.toHaveBeenCalled();
    });

    it('on a sandbox failure (bad ${expr}) returns an error and does NOT stash finalResult', async () => {
        sandboxMock.run.mockResolvedValue({
            ok: false,
            phase: 'user-code',
            error: 'ReferenceError: missing is not defined',
            line: 1,
            stdout: [],
        });
        const def = coderAgent();
        const ctx = seededCtx();
        const res = await def.toolExecutors.save_markdown_action!(
            { template: 'Hello ${missing.length}' },
            ctx,
        );
        expect(res.ok).toBe(false);
        if (!res.ok) {
            expect(res.error).toMatch(/phase: user-code/);
            expect(res.error).toMatch(/ReferenceError/);
        }
        expect(ctx.runState.finalResult).toBeUndefined();
    });

    it('returns a focused error (does NOT throw) when `template` is missing', async () => {
        const def = coderAgent();
        const ctx = seededCtx();
        const res = await def.toolExecutors.save_markdown_action!(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            {} as any,
            ctx,
        );
        expect(res.ok).toBe(false);
        if (!res.ok) {
            expect(res.error).toMatch(/input_validation_error/);
            expect(res.error).toMatch(/template/);
            expect(res.error).toMatch(/Required: `template`/);
        }
        expect(sandboxMock.run).not.toHaveBeenCalled();
    });
});

describe('coder onIdleTurn', () => {
    it('is wired into the agent definition', () => {
        const def = coderAgent();
        expect(def.onIdleTurn).toBeDefined();
    });

    it('first two idle turns nudge the model back to the tool path with feedback', async () => {
        const def = coderAgent();
        const hook = def.onIdleTurn!;
        const ctx = makeCtx({ runState: {} });

        const first = await hook(ctx);
        expect(first.continue).toBe(true);
        expect(first.feedbackForLLM).toMatch(/run_in_sandbox/);
        expect(first.feedbackForLLM).toMatch(/__output/);
        expect(ctx.runState.idleTurnRetries).toBe(1);

        const second = await hook(ctx);
        expect(second.continue).toBe(true);
        expect(second.feedbackForLLM).toMatch(/run_in_sandbox/);
        expect(ctx.runState.idleTurnRetries).toBe(2);
    });

    it('third idle turn exits cleanly without feedback', async () => {
        const def = coderAgent();
        const hook = def.onIdleTurn!;
        const ctx = makeCtx({ runState: { idleTurnRetries: 2 } });

        const outcome = await hook(ctx);
        expect(outcome.continue).toBe(false);
        expect(outcome.feedbackForLLM).toBeUndefined();
        // Counter stays put — no point incrementing on the terminal turn.
        expect(ctx.runState.idleTurnRetries).toBe(2);
    });
});
