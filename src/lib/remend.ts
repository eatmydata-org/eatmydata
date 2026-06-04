/**
 * Pre-process a partial markdown buffer so it parses cleanly mid-stream.
 * Speculatively closes unmatched code fences, inline code, bold, italic,
 * and link/image brackets. When the real close arrives in the next chunk,
 * the synthetic close is naturally replaced.
 *
 * Inspired by Vercel's parse-incomplete-markdown / Streamdown's `remend`.
 */
export function parseIncompleteMarkdown(input: string): string {
    let text = input;

    // 1. Unclosed triple-backtick fences. Count line-start ``` (allow optional lang).
    const fenceMatches = text.match(/^```[^\n]*$/gm);
    if (fenceMatches && fenceMatches.length % 2 === 1) {
        text += text.endsWith('\n') ? '```' : '\n```';
    }

    // After this point, treat the buffer as having balanced fences.
    // Strip fenced regions before counting inline markers so we don't
    // mis-count backticks inside code.
    const strippedForCounting = stripFences(text);

    // 2. Unclosed inline backtick. Count single backticks not part of triples.
    const inlineTicks = (strippedForCounting.match(/(?<!`)`(?!`)/g) ?? []).length;
    if (inlineTicks % 2 === 1) text += '`';

    // 3. Unclosed bold (**). Pair them up greedily.
    const bold = (strippedForCounting.match(/\*\*/g) ?? []).length;
    if (bold % 2 === 1) text += '**';

    // 4. Unclosed italic (single *). Count single * that aren't part of **.
    const ital = (strippedForCounting.replace(/\*\*/g, '').match(/\*/g) ?? []).length;
    if (ital % 2 === 1) text += '*';

    // 5. Unclosed link/image — if buffer ends with `[…` or `[…](…` (no closing
    // bracket/paren), strip back to the opening `[` (or `![`) to avoid showing
    // raw brackets. The next chunk will rebuild it.
    const lastOpenBracket = text.lastIndexOf('[');
    if (lastOpenBracket !== -1) {
        const tail = text.slice(lastOpenBracket);
        // Has matching `]`?
        const closeBracket = tail.indexOf(']');
        if (closeBracket === -1) {
            // open `[` with no `]` yet — strip back, including a leading `!` for images
            const start =
                lastOpenBracket > 0 && text[lastOpenBracket - 1] === '!'
                    ? lastOpenBracket - 1
                    : lastOpenBracket;
            text = text.slice(0, start);
        } else {
            // has `]` — check for incomplete `](` part
            const afterClose = tail.slice(closeBracket + 1);
            if (afterClose.startsWith('(') && !afterClose.includes(')')) {
                const start =
                    lastOpenBracket > 0 && text[lastOpenBracket - 1] === '!'
                        ? lastOpenBracket - 1
                        : lastOpenBracket;
                text = text.slice(0, start);
            }
        }
    }

    return text;
}

function stripFences(text: string): string {
    // Remove ```…``` blocks (greedy on closing fence).
    return text.replace(/```[\s\S]*?```/g, '');
}
