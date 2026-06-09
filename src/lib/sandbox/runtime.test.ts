import { beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setWasmLoader } from '@/lib/qjs';
import { runInSandbox } from './runtime';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmPath = resolve(__dirname, '../../../src/assets/wasm/qjs.wasm');

beforeAll(async () => {
    // Inject the local wasm file as bytes — Node's fetch can't resolve the
    // browser-style `/qjs.wasm` URL and there's no HTTP server in tests.
    const bytes = await readFile(wasmPath);
    setWasmLoader(() => bytes);
});

describe('runInSandbox', () => {
    it('returns ok with __output value on success', async () => {
        const result = await runInSandbox({
            code: '__output = 6 * 7;',
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.output).toBe(42);
            expect(result.stdout).toEqual([]);
        }
    });

    it('captures console.log lines as stdout', async () => {
        const result = await runInSandbox({
            code: "console.log('hello'); console.log('world', 1); __output = null;",
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.stdout).toEqual(['hello', 'world 1']);
        }
    });

    it('binds globals so user code can read them', async () => {
        const result = await runInSandbox({
            code: '__output = greeting + " " + name;',
            globals: { greeting: 'hi', name: 'denis' },
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.output).toBe('hi denis');
        }
    });

    it('binds array globals as actual arrays (not stringified)', async () => {
        const rows = [
            { name: 'A', revenue: 100 },
            { name: 'B', revenue: 50 },
        ];
        const result = await runInSandbox({
            code: '__output = customers.reduce((s, c) => s + c.revenue, 0);',
            globals: { customers: rows },
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.output).toBe(150);
        }
    });

    it('returns error string when user code throws', async () => {
        const result = await runInSandbox({
            code: 'throw new Error("boom");',
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error).toMatch(/boom/);
        }
    });

    it('returns error for syntactically invalid code', async () => {
        const result = await runInSandbox({
            code: 'let __output = (((;',
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            // QuickJS surfaces SyntaxError for malformed input.
            expect(result.error.length).toBeGreaterThan(0);
        }
    });

    it('isolates declarations between runs', async () => {
        // First run defines a local; second run must not see it.
        const first = await runInSandbox({
            code: 'const secret = 7; __output = secret;',
        });
        expect(first.ok).toBe(true);
        if (first.ok) expect(first.output).toBe(7);

        const second = await runInSandbox({
            code: '__output = typeof secret;',
        });
        expect(second.ok).toBe(true);
        if (second.ok) expect(second.output).toBe('undefined');
    });

    it('clears bound globals between runs', async () => {
        await runInSandbox({
            code: '__output = customers.length;',
            globals: { customers: [1, 2, 3] },
        });
        const second = await runInSandbox({
            code: '__output = typeof customers;',
        });
        expect(second.ok).toBe(true);
        if (second.ok) expect(second.output).toBe('undefined');
    });

    it('runs user code in strict mode (assigning to undeclared throws)', async () => {
        // Outside strict, `foo = 1` would silently create globalThis.foo.
        // Under strict, it's a ReferenceError.
        const result = await runInSandbox({
            code: 'foo = 1; __output = foo;',
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.phase).toBe('user-code');
            expect(result.error).toMatch(/foo/);
        }
    });

    it('user-code runtime error reports a USER-CODE line number, not a wrapped-script line', async () => {
        const userCode = [
            'const a = 1;',
            'const b = 2;',
            "throw new Error('boom');",
            '__output = a + b;',
        ].join('\n');
        const result = await runInSandbox({ code: userCode });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.phase).toBe('user-code');
            // The throw is at user-code line 3. Wrapped-script reports
            // something like line 30+; the adjusted `line` field must be 3.
            expect(result.line).toBe(3);
            expect(result.stack ?? '').toMatch(/<user-code>:3:/);
        }
    });

    it('strips TS annotations and runs as JS', async () => {
        const result = await runInSandbox({
            code: 'const x: number = 41; __output = x + 1;',
        });
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.output).toBe(42);
    });

    it('preserves line numbers across TS stripping', async () => {
        // Line 1 has a TS-only annotation; line 3 throws. If ts-blank-space
        // didn't preserve whitespace, the reported line would shift to 2.
        const code = ['const x: number = 1;', 'const y = x + 1;', "throw new Error('boom');"].join(
            '\n',
        );
        const result = await runInSandbox({ code });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.phase).toBe('user-code');
            expect(result.line).toBe(3);
        }
    });

    it('returns outputs larger than the WASM result buffer intact (no truncation)', async () => {
        // The previous wrapper used a fixed 8KB buffer + snprintf and the
        // host walked the result with strlen, silently truncating large
        // outputs (e.g. multi-MB aggregation JSON from action executions).
        // Generate ~64KB of distinct strings to blow past anything plausibly
        // small the wrapper could cap at.
        const result = await runInSandbox({
            code: [
                'const out = [];',
                'for (let i = 0; i < 4000; i++) {',
                "  out.push({ i, label: 'row-' + i + '-' + 'x'.repeat(8) });",
                '}',
                '__output = JSON.stringify(out);',
            ].join('\n'),
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(typeof result.output).toBe('string');
            const parsed = JSON.parse(result.output as string);
            expect(Array.isArray(parsed)).toBe(true);
            expect(parsed.length).toBe(4000);
            // The last row must be present — that's what truncation kills first.
            expect(parsed[3999]).toEqual({
                i: 3999,
                label: 'row-3999-xxxxxxxx',
            });
        }
    });

    it('md()/chart()/table() build tagged blocks; present() wraps them', async () => {
        const result = await runInSandbox({
            code: "present(md('## Hi'), table([{ a: 1 }], { title: 'T' }), chart({ series: [] }));",
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.output).toEqual({
                __kind: 'blocks',
                blocks: [
                    { __kind: 'block', type: 'markdown', text: '## Hi' },
                    { __kind: 'block', type: 'table', rows: [{ a: 1 }], title: 'T' },
                    { __kind: 'block', type: 'chart', option: { series: [] } },
                ],
            });
        }
    });

    it('md supports the tagged-template form md`…${x}…`', async () => {
        const result = await runInSandbox({
            code: 'const total = 42; present(md`Revenue: **${total}**`);',
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.output).toEqual({
                __kind: 'blocks',
                blocks: [{ __kind: 'block', type: 'markdown', text: 'Revenue: **42**' }],
            });
        }
    });

    it('present() accumulates blocks across multiple calls', async () => {
        const result = await runInSandbox({
            code: "present(md('a')); present(md('b'));",
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
            const out = result.output as { blocks: unknown[] };
            expect(out.blocks.length).toBe(2);
        }
    });

    it('table(nonArray) throws a user-code TypeError', async () => {
        const result = await runInSandbox({ code: "present(table('nope'));" });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.phase).toBe('user-code');
            expect(result.error).toMatch(/rows must be an array/);
        }
    });

    it('rejects TS constructs that emit runtime code (enums)', async () => {
        // ts-blank-space refuses constructs that would otherwise compile to
        // runtime values; we surface that as a parse-phase failure so the
        // Coder sees what it actually wrote.
        const result = await runInSandbox({
            code: 'enum E { A } __output = E.A;',
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            // Either the strip step throws or the un-stripped runtime code
            // reaches QuickJS and errors there — either way the phase is
            // 'parse' because the code never produced a clean `__output`.
            expect(result.phase).toBe('parse');
        }
    });
});
