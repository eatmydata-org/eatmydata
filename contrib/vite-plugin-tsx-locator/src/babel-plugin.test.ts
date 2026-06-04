import { describe, it, expect } from 'vitest';
import { transformSync } from '@babel/core';
import { tsxElementBabelPlugin } from './babel-plugin';

const ROOT = '/proj';

/// Transform a TSX snippet through *only* our plugin (no Solid preset), so the
/// generated output still contains readable JSX we can assert against. The
/// component-border resolution is identical with or without the preset; a
/// separate end-to-end check confirms the tags survive `babel-preset-solid`'s
/// template folding.
function run(code: string, file = 'src/components/foo.tsx'): string {
    const out = transformSync(code, {
        filename: `${ROOT}/${file}`,
        babelrc: false,
        configFile: false,
        parserOpts: { plugins: ['jsx', 'typescript'] },
        plugins: [tsxElementBabelPlugin({ root: ROOT })],
    });
    if (!out?.code) throw new Error('no output from transform');
    return out.code;
}

describe('tsxElementBabelPlugin', () => {
    it('tags a component root, not its nested children', () => {
        const out = run(
            ['const Foo = () => (', '  <div class="x">', '    <button>go</button>', '  </div>', ');'].join(
                '\n',
            ),
        );
        expect(out).toContain('data-tsx-element="Foo@src/components/foo.tsx:1"');
        expect(out).not.toMatch(/<button[^>]*data-tsx-element/);
        expect((out.match(/data-tsx-element/g) ?? []).length).toBe(1);
    });

    it('names the component from a function declaration', () => {
        const out = run(`function Page() {\n  return <section>x</section>;\n}`);
        expect(out).toContain('data-tsx-element="Page@src/components/foo.tsx:1"');
    });

    it('descends through control-flow (Show) to the first host element', () => {
        const out = run(`const Bar = () => <Show when={x}><span>y</span></Show>;`);
        expect(out).toContain('data-tsx-element="Bar@src/components/foo.tsx:1"'); // <span>
        expect(out).not.toMatch(/<Show[^>]*data-tsx-element/);
    });

    it('descends into a For render callback', () => {
        const out = run(`const List = () => <For each={a}>{(i) => <li>{i}</li>}</For>;`);
        expect(out).toContain('data-tsx-element="List@src/components/foo.tsx:1"'); // <li>
    });

    it('tags both branches of a conditional return', () => {
        const out = run(`const C = (c) => (c ? <a>1</a> : <b>2</b>);`);
        expect((out.match(/data-tsx-element="C@src\/components\/foo\.tsx:1"/g) ?? []).length).toBe(2);
    });

    it('does not tag a component whose root is another component', () => {
        const out = run(`const Wrapper = () => <Inner data-x="1" />;`);
        expect(out).not.toContain('data-tsx-element');
    });

    it('ignores lowercase helper functions (not components)', () => {
        const out = run(`const make = () => <p>hi</p>;`);
        expect(out).not.toContain('data-tsx-element');
    });

    it('never double-stamps an element that already has the attribute', () => {
        const out = run(`const Foo = () => <div data-tsx-element="manual">x</div>;`);
        expect(out).toContain('data-tsx-element="manual"');
        expect((out.match(/data-tsx-element/g) ?? []).length).toBe(1);
    });

    it('makes the path relative to the configured root', () => {
        const out = run(`const Button = () => <button>y</button>;`, 'contrib/shadcn-solid/ui/button.tsx');
        expect(out).toContain('data-tsx-element="Button@contrib/shadcn-solid/ui/button.tsx:1"');
    });
});
