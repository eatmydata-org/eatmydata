import { MAX_DOM_TABLE_ROWS } from '@/lib/actions/render-limits';

const isTableRow = (line: string): boolean => {
    const t = line.trim();
    return t.length > 0 && t.includes('|');
};

/** A GFM header/body separator row, e.g. `| --- | :--: |`. */
const isSeparatorRow = (line: string): boolean => {
    const t = line.trim();
    // Linear regex (single quantifier over one char class, no ambiguous
    // overlap): the row is made only of spaces/colons/pipes/dashes. The
    // `t.includes('-')` keeps the "at least one dash" requirement, so the
    // matched set is identical to the prior `^\|?[\s:|-]*-[\s:|-]*\|?$`.
    return /^[\s:|-]*$/.test(t) && t.includes('-');
};

/**
 * Anti-stall backstop: truncate any GFM table whose body exceeds `maxRows`
 * BEFORE the markdown is parsed, so the parser never builds thousands of
 * `<tr>` nodes (the DOM-creation cost is what freezes the tab — slicing
 * already-rendered children would be too late). The reliable path keeps large
 * tables out of markdown entirely (they go through the AG-Grid block); this
 * only catches non-compliant output.
 */
export function capMarkdownTables(src: string, maxRows = MAX_DOM_TABLE_ROWS): string {
    if (!src.includes('|')) return src; // fast path: no tables
    const lines = src.split('\n');
    const out: string[] = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i] ?? '';
        const next = lines[i + 1];
        if (isTableRow(line) && next !== undefined && isSeparatorRow(next)) {
            out.push(line, next); // header + separator
            i += 2;
            const body: string[] = [];
            let bodyLine = lines[i];
            while (bodyLine !== undefined && isTableRow(bodyLine)) {
                body.push(bodyLine);
                i++;
                bodyLine = lines[i];
            }
            for (const row of body.slice(0, maxRows)) out.push(row);
            if (body.length > maxRows) {
                out.push('');
                out.push(
                    `_Showing first ${maxRows.toLocaleString()} of ${body.length.toLocaleString()} rows. Ask for a downloadable table to see all rows._`,
                );
            }
            continue;
        }
        out.push(line);
        i++;
    }
    return out.join('\n');
}
