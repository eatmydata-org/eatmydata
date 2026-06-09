import { describe, expect, it } from 'vitest';
import { capMarkdownTables } from './cap-tables';

const tableOf = (n: number): string => {
    const lines = ['| id | name |', '| --- | --- |'];
    for (let i = 0; i < n; i++) lines.push(`| ${i} | row-${i} |`);
    return lines.join('\n');
};

describe('capMarkdownTables', () => {
    it('leaves a small table untouched', () => {
        const src = tableOf(3);
        expect(capMarkdownTables(src, 5)).toBe(src);
    });

    it('caps an oversized table body to maxRows and appends a notice', () => {
        const out = capMarkdownTables(tableOf(100), 5);
        const lines = out.split('\n');
        // header + separator + 5 body rows = 7, then blank + notice = 9
        const bodyRows = lines.filter((l) => /^\| \d+ \| row-/.test(l));
        expect(bodyRows.length).toBe(5);
        expect(out).toMatch(/Showing first 5 of 100 rows/);
        // The 6th data row must NOT be present.
        expect(out).not.toContain('| 5 | row-5 |');
    });

    it('preserves surrounding prose and only caps the table block', () => {
        const src = `# Heading\n\nIntro paragraph.\n\n${tableOf(50)}\n\nClosing note.`;
        const out = capMarkdownTables(src, 10);
        expect(out).toContain('# Heading');
        expect(out).toContain('Intro paragraph.');
        expect(out).toContain('Closing note.');
        expect(out).toMatch(/Showing first 10 of 50 rows/);
    });

    it('fast-paths content with no tables (returns input unchanged)', () => {
        const src = '# Just prose\n\nNo pipes here.';
        expect(capMarkdownTables(src, 5)).toBe(src);
    });

    it('handles multiple tables independently', () => {
        const src = `${tableOf(20)}\n\nbetween\n\n${tableOf(2)}`;
        const out = capMarkdownTables(src, 5);
        expect(out).toMatch(/Showing first 5 of 20 rows/);
        // The small second table is untouched (no second notice).
        expect(out.match(/Showing first/g)?.length).toBe(1);
        expect(out).toContain('between');
    });
});
