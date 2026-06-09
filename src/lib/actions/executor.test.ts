import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SandboxResult } from '@/lib/sandbox/runtime';

const sandboxMock = vi.hoisted(() => ({
    run: vi.fn<
        (args: { code: string; globals?: Record<string, unknown> }) => Promise<SandboxResult>
    >(),
}));

vi.mock('@/lib/sandbox/runtime', () => ({
    runInSandbox: sandboxMock.run,
}));

const resolverMock = vi.hoisted(() => ({
    resolveDb: vi.fn<(sourceId?: string) => Promise<unknown>>(),
}));

vi.mock('@/lib/data-sources/resolver', () => ({
    resolveDb: resolverMock.resolveDb,
}));

import {
    deriveTableColumns,
    executeAction,
    inferOutputFormat,
    normalizeTableColumns,
    parseMarkdownTemplate,
    toBlocks,
    wrapMarkdownTemplate,
} from './executor';
import type { Action } from './types';

/**
 * Evaluate the wrapped JS source (an `__output = \`...\`;` statement) in a
 * sandboxed Function with the given globals bound by name. Returns the value
 * of `__output`. This is how we assert that the wrapped template actually
 * round-trips through the JS template-literal engine the way QuickJS would
 * see it — no QuickJS needed for parser unit tests.
 */
function evalWrapped(wrapped: string, globals: Record<string, unknown> = {}): unknown {
    const names = Object.keys(globals);
    const values = names.map((n) => globals[n]);
    const body = `let __output; ${wrapped} return __output;`;
    const fn = new Function(...names, body);
    return fn(...values);
}

describe('inferOutputFormat', () => {
    it('returns markdown for strings', () => {
        expect(inferOutputFormat('hello')).toBe('markdown');
        expect(inferOutputFormat('')).toBe('markdown');
    });

    it('returns echarts for a bare option object (legacy single-chart form)', () => {
        const option = {
            xAxis: { type: 'category', data: ['a', 'b'] },
            yAxis: { type: 'value' },
            series: [{ type: 'line', data: [1, 2] }],
        };
        expect(inferOutputFormat(option)).toBe('echarts');
    });

    it('returns echarts for an array of option objects (multi-chart form)', () => {
        const charts = [
            { xAxis: { type: 'category', data: ['a'] }, yAxis: {}, series: [] },
            { xAxis: { type: 'category', data: ['b'] }, yAxis: {}, series: [] },
        ];
        expect(inferOutputFormat(charts)).toBe('echarts');
    });

    it('returns json for an empty array', () => {
        expect(inferOutputFormat([])).toBe('json');
    });

    it('returns json for an array mixing options and non-options', () => {
        const mixed = [{ xAxis: {}, yAxis: {}, series: [] }, 'a string slipped in'];
        expect(inferOutputFormat(mixed)).toBe('json');
    });

    it('returns json for objects without ECharts keys', () => {
        expect(inferOutputFormat({ totalRows: 42 })).toBe('json');
    });

    it('returns blocks for a bare array of flat scalar records (convenience table)', () => {
        // Was 'json' before the block model — a bare array of rows now renders
        // as a single table block (AG-Grid).
        expect(inferOutputFormat([{ a: 1 }, { b: 2 }])).toBe('blocks');
    });

    it('returns json for arrays of records with nested object/array values', () => {
        expect(inferOutputFormat([{ a: { nested: true } }])).toBe('json');
        expect(inferOutputFormat([{ a: [1, 2, 3] }])).toBe('json');
    });

    it('returns blocks for the present() wrapper', () => {
        const wrapper = {
            __kind: 'blocks',
            blocks: [
                { __kind: 'block', type: 'markdown', text: '## Hi' },
                { __kind: 'block', type: 'table', rows: [{ a: 1 }] },
            ],
        };
        expect(inferOutputFormat(wrapper)).toBe('blocks');
    });

    it('returns blocks for a lone table()/chart() block and a bare array of blocks', () => {
        expect(inferOutputFormat({ __kind: 'block', type: 'table', rows: [{ a: 1 }] })).toBe(
            'blocks',
        );
        expect(
            inferOutputFormat([
                { __kind: 'block', type: 'markdown', text: 'x' },
                { __kind: 'block', type: 'chart', option: { series: [] } },
            ]),
        ).toBe('blocks');
    });

    it('keeps a bare ECharts option array as echarts (ordering: charts win over flat-array)', () => {
        const charts = [{ xAxis: { type: 'category', data: ['a'] }, yAxis: {}, series: [] }];
        expect(inferOutputFormat(charts)).toBe('echarts');
    });

    it('returns json for primitives other than strings', () => {
        expect(inferOutputFormat(42)).toBe('json');
        expect(inferOutputFormat(null)).toBe('json');
        expect(inferOutputFormat(undefined)).toBe('json');
    });
});

describe('toBlocks', () => {
    it('unwraps a present() wrapper, mapping type→kind and deriving table columns', () => {
        const wrapper = {
            __kind: 'blocks',
            blocks: [
                { __kind: 'block', type: 'markdown', text: '# Title' },
                {
                    __kind: 'block',
                    type: 'table',
                    rows: [
                        { a: 1, b: 2 },
                        { a: 3, c: 4 },
                    ],
                    title: 'T',
                    caption: 'cap',
                },
                { __kind: 'block', type: 'chart', option: { series: [] } },
            ],
        };
        expect(toBlocks(wrapper)).toEqual([
            { kind: 'markdown', text: '# Title' },
            {
                kind: 'table',
                // union of keys across all rows, first-seen order
                columns: ['a', 'b', 'c'],
                rows: [
                    { a: 1, b: 2 },
                    { a: 3, c: 4 },
                ],
                title: 'T',
                caption: 'cap',
            },
            { kind: 'chart', option: { series: [] } },
        ]);
    });

    it('honors explicit table columns over derived ones', () => {
        const block = {
            __kind: 'block',
            type: 'table',
            columns: ['b', 'a'],
            rows: [{ a: 1, b: 2 }],
        };
        expect(toBlocks(block)).toEqual([
            { kind: 'table', columns: ['b', 'a'], rows: [{ a: 1, b: 2 }] },
        ]);
    });

    it('coerces AG-Grid-style column descriptor objects to string field names', () => {
        // The model sometimes passes `{ field, headerName }` objects — these
        // must become string names or AG-Grid crashes on `field.includes`.
        const block = {
            __kind: 'block',
            type: 'table',
            columns: [{ field: 'id', headerName: 'ID' }, { name: 'amount' }],
            rows: [{ id: 1, amount: 2 }],
        };
        expect(toBlocks(block)).toEqual([
            { kind: 'table', columns: ['id', 'amount'], rows: [{ id: 1, amount: 2 }] },
        ]);
    });

    it('treats a bare flat-record array as one table block', () => {
        expect(toBlocks([{ a: 1 }, { a: 2 }])).toEqual([
            { kind: 'table', columns: ['a'], rows: [{ a: 1 }, { a: 2 }] },
        ]);
    });

    it('returns [] for shapes that are not blocks (renderer falls back to JSON)', () => {
        expect(toBlocks({ totalRows: 42 })).toEqual([]);
        expect(toBlocks('a string')).toEqual([]);
        expect(toBlocks(42)).toEqual([]);
    });
});

describe('normalizeTableColumns', () => {
    const rows = [{ a: 1, b: 2 }];
    it('passes string column names through', () => {
        expect(normalizeTableColumns(['a', 'b'], rows)).toEqual(['a', 'b']);
    });
    it('extracts field/name/key/id from column-descriptor objects', () => {
        expect(
            normalizeTableColumns([{ field: 'a' }, { name: 'b' }, { key: 'c' }, { id: 'd' }], rows),
        ).toEqual(['a', 'b', 'c', 'd']);
    });
    it('falls back to row keys when columns is absent, empty, or unusable', () => {
        expect(normalizeTableColumns(undefined, rows)).toEqual(['a', 'b']);
        expect(normalizeTableColumns([], rows)).toEqual(['a', 'b']);
        expect(normalizeTableColumns([{ headerName: 'only-a-header' }], rows)).toEqual(['a', 'b']);
    });
});

describe('deriveTableColumns', () => {
    it('unions keys across all rows preserving first-seen order', () => {
        expect(deriveTableColumns([{ a: 1, b: 2 }, { b: 3, c: 4 }, { a: 5 }])).toEqual([
            'a',
            'b',
            'c',
        ]);
    });

    it('handles sparse rows where a column is absent from the first row', () => {
        expect(deriveTableColumns([{ a: 1 }, { a: 2, z: 9 }])).toEqual(['a', 'z']);
    });
});

describe('wrapMarkdownTemplate', () => {
    it('wraps a plain template as __output = `<template>`;', () => {
        expect(wrapMarkdownTemplate('hello world')).toBe('__output = `hello world`;');
    });

    it('preserves ${expr} interpolations verbatim — that IS the point', () => {
        expect(wrapMarkdownTemplate('# Total: $${data.length}')).toBe(
            '__output = `# Total: $${data.length}`;',
        );
    });

    it('escapes backticks so the template cannot break out of the literal', () => {
        // A backtick inside the template would close our wrapper literal —
        // must be escaped.
        expect(wrapMarkdownTemplate('Use `code` like this')).toBe(
            '__output = `Use \\`code\\` like this`;',
        );
    });

    it('escapes backslashes BEFORE backticks (order matters)', () => {
        // If backtick escaping ran first, the resulting `\\\`` would itself be
        // double-escaped on the next pass. Backslash first prevents that.
        expect(wrapMarkdownTemplate('a\\b')).toBe('__output = `a\\\\b`;');
        // Combined: a literal "\`" in the template should produce an escaped
        // backslash followed by an escaped backtick in the wrapper.
        expect(wrapMarkdownTemplate('x\\`y')).toBe('__output = `x\\\\\\`y`;');
    });

    it('passes nested template literals inside ${expr} through verbatim (failure-1)', () => {
        // The Coder writes:  ${arr.map(r => `| ${r.id} |`).join('\n')}
        // The old wrapper escaped the inner backticks, breaking QuickJS parse.
        const tpl = "${arr.map(r => `| ${r.id} |`).join('\\n')}";
        const wrapped = wrapMarkdownTemplate(tpl);
        expect(wrapped).toBe("__output = `${arr.map(r => `| ${r.id} |`).join('\\n')}`;");
        // And it actually runs — inner backticks survive, newlines materialize.
        const out = evalWrapped(wrapped, {
            arr: [{ id: 1 }, { id: 2 }, { id: 3 }],
        });
        expect(out).toBe('| 1 |\n| 2 |\n| 3 |');
    });

    it('does NOT double backslashes inside ${expr} string literals (failure-2)', () => {
        // The Coder writes:  a${arr.join('\n')}b
        // The old wrapper turned '\n' into '\\n' — JS then read it as a 2-char
        // string, joining rows with a literal backslash-n instead of newline.
        const tpl = "a${arr.join('\\n')}b";
        const wrapped = wrapMarkdownTemplate(tpl);
        expect(wrapped).toBe("__output = `a${arr.join('\\n')}b`;");
        const out = evalWrapped(wrapped, { arr: ['a', 'b', 'c'] });
        // Real newlines, not literal backslash-n.
        expect(out).toBe('aa\nb\ncb');
        expect(out).not.toContain('\\n');
    });

    it('honors \\${ as an opt-out from interpolation', () => {
        // Template source: "price: \${total}" — the \${ tells the wrapper to
        // emit a literal `${total}` in the output, not interpolate `total`.
        const wrapped = wrapMarkdownTemplate('price: \\${total}');
        expect(wrapped).toBe('__output = `price: \\${total}`;');
        const out = evalWrapped(wrapped, { total: 42 });
        expect(out).toBe('price: ${total}');
    });

    it('balances object literals in ${expr} via brace depth', () => {
        const wrapped = wrapMarkdownTemplate('${({a: 1, b: 2}).a}');
        expect(wrapped).toBe('__output = `${({a: 1, b: 2}).a}`;');
        const out = evalWrapped(wrapped);
        expect(out).toBe('1');
    });

    it('does not let { or } inside a string literal in ${expr} affect brace depth', () => {
        // The `{` and `}` inside the '{a}' string must be ignored by the
        // depth counter — otherwise the outer `}` would close too early.
        const wrapped = wrapMarkdownTemplate("${obj['{a}']}");
        expect(wrapped).toBe("__output = `${obj['{a}']}`;");
        const out = evalWrapped(wrapped, { obj: { '{a}': 'hit' } });
        expect(out).toBe('hit');
    });

    it('degrades gracefully on an unterminated ${', () => {
        // Defensive: don't crash. The wrapped output will be malformed JS,
        // which the sandbox will surface as a parse error at execute time.
        expect(() => wrapMarkdownTemplate('${unfinished')).not.toThrow();
    });
});

describe('parseMarkdownTemplate', () => {
    it('returns the input as a single literal when there is no ${...}', () => {
        expect(parseMarkdownTemplate('hello world')).toEqual({
            literals: ['hello world'],
            expressions: [],
        });
    });

    it('splits literal and expression on a simple interpolation', () => {
        expect(parseMarkdownTemplate('hi ${name}')).toEqual({
            literals: ['hi ', ''],
            expressions: ['name'],
        });
    });

    it('captures nested template literals inside an expression verbatim', () => {
        // Template source contains a backtick-quoted JS template inside ${...}.
        // The inner ${r.id} must NOT close the outer interpolation early.
        const tpl = "${arr.map(r => `| ${r.id} |`).join('\\n')}";
        const parsed = parseMarkdownTemplate(tpl);
        expect(parsed.literals).toEqual(['', '']);
        expect(parsed.expressions).toEqual(["arr.map(r => `| ${r.id} |`).join('\\n')"]);
    });

    it("preserves backslashes inside string literals in expressions (the '\\n' case)", () => {
        const parsed = parseMarkdownTemplate("a${arr.join('\\n')}b");
        expect(parsed.literals).toEqual(['a', 'b']);
        // The expression source is exactly what the Coder typed — including
        // the backslash-n inside the string literal.
        expect(parsed.expressions).toEqual(["arr.join('\\n')"]);
    });

    it('treats \\${ as a literal ${ and consumes the backslash', () => {
        expect(parseMarkdownTemplate('price: \\${total}')).toEqual({
            literals: ['price: ${total}'],
            expressions: [],
        });
    });

    it('keeps brace depth correct across object literals in expressions', () => {
        expect(parseMarkdownTemplate('${({a: 1, b: 2}).a}')).toEqual({
            literals: ['', ''],
            expressions: ['({a: 1, b: 2}).a'],
        });
    });

    it('ignores braces that live inside string literals inside expressions', () => {
        expect(parseMarkdownTemplate("${obj['{a}'].toString()}")).toEqual({
            literals: ['', ''],
            expressions: ["obj['{a}'].toString()"],
        });
    });

    it('handles multiple interpolations in sequence', () => {
        expect(parseMarkdownTemplate('${a} and ${b}!')).toEqual({
            literals: ['', ' and ', '!'],
            expressions: ['a', 'b'],
        });
    });

    it('does not crash on an unterminated ${', () => {
        // Graceful degradation: the rest of the template becomes the
        // expression body; the literal list ends with the empty trailing slot.
        expect(() => parseMarkdownTemplate('${unfinished')).not.toThrow();
        const parsed = parseMarkdownTemplate('${unfinished');
        expect(parsed.literals[0]).toBe('');
        expect(parsed.expressions.length).toBe(1);
    });
});

function makeAction(overrides: Partial<Action> = {}): Action {
    return {
        id: 'a-1',
        name: 'A',
        description: '',
        dataSources: [
            {
                id: 'ds-1',
                name: 'data',
                type: 'sql',
                query: 'SELECT 1',
                semanticDescription: '',
                typeDeclaration: '',
            },
        ],
        code: null,
        chatLog: [],
        createdAt: 0,
        updatedAt: 0,
        ...overrides,
    };
}

describe('executeAction kind: markdown', () => {
    beforeEach(() => {
        sandboxMock.run.mockReset();
        resolverMock.resolveDb.mockReset();
    });

    it('wraps a markdown template and feeds it to the sandbox; outputFormat is forced to markdown', async () => {
        resolverMock.resolveDb.mockResolvedValue({
            execFull: async () => ({
                columns: ['id'],
                rows: [{ id: 1 }, { id: 2 }, { id: 3 }],
                truncated: false,
            }),
        });
        sandboxMock.run.mockResolvedValue({
            ok: true,
            output: 'Rows: 3',
            stdout: [],
        });
        const action = makeAction({
            kind: 'markdown',
            code: 'Rows: ${data.length}',
        });
        const exec = await executeAction(action);
        expect(exec.error).toBeUndefined();
        expect(exec.outputFormat).toBe('markdown');
        const call = sandboxMock.run.mock.calls[0]?.[0];
        // The runtime saw the WRAPPED template, not the raw markdown.
        expect(call?.code).toBe('__output = `Rows: ${data.length}`;');
        // Data source bound by name as the row array.
        expect(call?.globals).toEqual({
            data: [{ id: 1 }, { id: 2 }, { id: 3 }],
        });
        // The pretended sandbox output flows through to the execution.
        expect(exec.output).toBe('Rows: 3');
    });

    it('surfaces a bad ${expr} as a topError tagged with the user-code phase', async () => {
        resolverMock.resolveDb.mockResolvedValue({
            execFull: async () => ({
                columns: [],
                rows: [],
                truncated: false,
            }),
        });
        sandboxMock.run.mockResolvedValue({
            ok: false,
            phase: 'user-code',
            error: 'ReferenceError: missing is not defined',
            line: 1,
            stdout: [],
        });
        const action = makeAction({
            kind: 'markdown',
            code: 'Hello ${missing.length}',
        });
        const exec = await executeAction(action);
        expect(exec.error).toBeDefined();
        expect(exec.error).toMatch(/phase: user-code/);
        expect(exec.error).toMatch(/ReferenceError/);
        // Even on error, outputFormat is still markdown for a markdown action.
        expect(exec.outputFormat).toBe('markdown');
    });

    it('legacy actions (kind: undefined) still go through the JS path unchanged', async () => {
        resolverMock.resolveDb.mockResolvedValue({
            execFull: async () => ({
                columns: [],
                rows: [],
                truncated: false,
            }),
        });
        sandboxMock.run.mockResolvedValue({
            ok: true,
            output: { totalRows: 0 },
            stdout: [],
        });
        const action = makeAction({
            code: '__output = { totalRows: data.length };',
        });
        await executeAction(action);
        const call = sandboxMock.run.mock.calls[0]?.[0];
        // No wrapping — the executor passed the JS source straight through.
        expect(call?.code).toBe('__output = { totalRows: data.length };');
    });
});
