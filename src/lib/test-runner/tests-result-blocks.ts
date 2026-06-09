/**
 * Browser tests for the composable block renderer. These exercise things
 * vitest's jsdom can't measure: AG-Grid's real layout + row virtualization for
 * a large table, and autoHeight sizing for a small one. Every table renders in
 * AG-Grid — there is no inline/markdown table path. Run from `/tests`.
 */
import { render } from 'solid-js/web';
import { createComponent } from 'solid-js';
import { ResultBlocks } from '@/components/result-blocks';
import type { ResultBlock } from '@/lib/actions/types';
import type { TestDef } from './runner';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mount(blocks: ResultBlock[]): { host: HTMLElement; dispose: () => void } {
    const host = document.createElement('div');
    host.style.width = '900px';
    host.style.height = '700px';
    document.body.appendChild(host);
    const dispose = render(() => createComponent(ResultBlocks, { blocks }), host);
    return { host, dispose };
}

export const RESULT_BLOCKS_TESTS: TestDef[] = [
    {
        id: 'result-blocks-large-table-virtualizes',
        name: 'ResultBlocks renders a 5000-row table in AG-Grid with virtualization',
        timeoutMs: 15_000,
        fn: async (ctx) => {
            const rows = Array.from({ length: 5000 }, (_, i) => ({
                id: i,
                name: `row-${i}`,
                value: i * 2,
            }));
            const blocks: ResultBlock[] = [
                { kind: 'markdown', text: '## Report' },
                { kind: 'table', columns: ['id', 'name', 'value'], rows, title: 'Big table' },
            ];
            const { host, dispose } = mount(blocks);
            try {
                // Let AG-Grid mount, lay out, and render its first row block.
                await wait(800);
                const gridRoot = host.querySelector('.ag-root');
                ctx.expect.truthy(gridRoot, 'AG-Grid root present for a >5-row table');
                const agRows = host.querySelectorAll('.ag-row');
                ctx.log('rendered .ag-row count:', agRows.length, 'of 5000 source rows');
                ctx.expect.truthy(agRows.length > 0, 'at least some rows rendered');
                ctx.expect.truthy(
                    agRows.length < 500,
                    `virtualized: DOM rows (${agRows.length}) far below 5000`,
                );
                const box = host.querySelector('.ag-root-wrapper') ?? gridRoot;
                const h = (box as HTMLElement).getBoundingClientRect().height;
                ctx.log('grid box height px:', h);
                ctx.expect.truthy(h > 50, 'bounded grid box has non-zero height');
                // The markdown block rendered alongside the grid.
                ctx.expect.truthy(host.textContent?.includes('Report'), 'markdown block present');
            } finally {
                dispose();
                host.remove();
            }
        },
    },
    {
        id: 'result-blocks-small-table-autoheight',
        name: 'ResultBlocks renders a small table in AG-Grid (autoHeight, hugs content)',
        fn: async (ctx) => {
            const blocks: ResultBlock[] = [
                {
                    kind: 'table',
                    columns: ['a', 'b'],
                    rows: [
                        { a: 1, b: 2 },
                        { a: 3, b: 4 },
                    ],
                },
            ];
            const { host, dispose } = mount(blocks);
            try {
                await wait(300);
                // Every table goes to AG-Grid now — no static <table> fallback.
                ctx.expect.truthy(
                    host.querySelector('.ag-root'),
                    'AG-Grid mounted for a small table',
                );
                ctx.expect.equal(
                    host.querySelector('table'),
                    null,
                    'no static <table> — the inline/markdown table path is gone',
                );
                const agRows = host.querySelectorAll('.ag-row');
                ctx.expect.equal(
                    agRows.length,
                    2,
                    'both rows rendered (autoHeight, no virtualization)',
                );
                // autoHeight: the grid wrapper hugs content rather than a tall
                // fixed box — its height should be well under the 640px cap.
                const wrapper = host.querySelector('.ag-root-wrapper') as HTMLElement | null;
                const h = wrapper?.getBoundingClientRect().height ?? 0;
                ctx.log('small-table grid height px:', h);
                ctx.expect.truthy(h > 0 && h < 300, `autoHeight grid hugs content (${h}px)`);
            } finally {
                dispose();
                host.remove();
            }
        },
    },
];
