import { type Component, createEffect, createMemo, createSignal, For } from 'solid-js';
import { paletteFor } from './entity-badge';
import type { PiiEntity } from '@/lib/transformers/client';

// Highlights are character-attached: each detector run is treated as a
// rich-text "mark" set whose offsets travel with edits until the next
// run replaces them. Between runs we diff resultsFor (the snapshot the
// detector saw) against the current value with a single-edit
// common-prefix/common-suffix diff, then map each highlight's
// endpoints through that edit so partial deletions shrink, surrounding
// inserts shift, and inserts inside a run extend it.
//
// Inline rendering is the same two-layer overlay: a positioned <pre>
// underneath with colored <mark> spans, and a transparent textarea on
// top sharing font/padding/scroll so character cells line up.

interface AnchoredHighlight {
    start: number;
    end: number;
    type: string;
    score: number;
}

export function singleEditDiff(
    oldS: string,
    newS: string,
): {
    start: number;
    removed: number;
    inserted: number;
} {
    if (oldS === newS) return { start: 0, removed: 0, inserted: 0 };
    const minLen = Math.min(oldS.length, newS.length);
    let p = 0;
    while (p < minLen && oldS[p] === newS[p]) p++;
    let oe = oldS.length;
    let ne = newS.length;
    while (oe > p && ne > p && oldS[oe - 1] === newS[ne - 1]) {
        oe--;
        ne--;
    }
    return { start: p, removed: oe - p, inserted: ne - p };
}

function transformHighlights(
    results: PiiEntity[],
    fromText: string,
    toText: string,
): AnchoredHighlight[] {
    if (!results.length) return [];
    if (fromText === toText) {
        return results.map((r) => ({
            start: r.start,
            end: r.end,
            type: r.entity_type,
            score: r.score,
        }));
    }
    const { start: s, removed: r, inserted: i } = singleEditDiff(fromText, toText);
    const delta = i - r;
    const out: AnchoredHighlight[] = [];
    for (const h of results) {
        let ns: number;
        if (h.start < s) ns = h.start;
        // Pure insertion at the start of a run: don't extend backward,
        // shift the run past the inserted chars.
        else if (h.start === s && r === 0) ns = s + i;
        // Start in deleted range: snap to edit point so remaining
        // letters keep their style.
        else if (h.start < s + r) ns = s;
        else ns = h.start + delta;

        let ne: number;
        if (h.end <= s) ne = h.end;
        // End in deleted range: snap to edit point.
        else if (h.end <= s + r) ne = s;
        else ne = h.end + delta;

        if (ne > ns) {
            out.push({ start: ns, end: ne, type: h.entity_type, score: h.score });
        }
    }
    return out;
}

function buildSegments(
    text: string,
    highlights: AnchoredHighlight[],
): Array<{ kind: 'plain'; text: string } | { kind: 'mark'; text: string; type: string }> {
    if (!highlights.length) return [{ kind: 'plain', text }];
    // Resolve overlaps: prefer the higher score, then earlier start.
    const sorted = [...highlights].sort((a, b) => {
        if (a.start !== b.start) return a.start - b.start;
        return b.score - a.score;
    });
    const accepted: AnchoredHighlight[] = [];
    for (const h of sorted) {
        if (accepted.some((a) => h.start < a.end && h.end > a.start)) continue;
        accepted.push(h);
    }
    accepted.sort((a, b) => a.start - b.start);
    const out: Array<
        { kind: 'plain'; text: string } | { kind: 'mark'; text: string; type: string }
    > = [];
    let cursor = 0;
    for (const h of accepted) {
        if (h.start > cursor) {
            out.push({ kind: 'plain', text: text.slice(cursor, h.start) });
        }
        out.push({
            kind: 'mark',
            text: text.slice(h.start, h.end),
            type: h.type,
        });
        cursor = h.end;
    }
    if (cursor < text.length) {
        out.push({ kind: 'plain', text: text.slice(cursor) });
    }
    return out;
}

export interface HighlightedTextareaApi {
    submit: () => void;
    settled: () => boolean;
    awaitingAnalysis: () => boolean;
}

export const HighlightedTextarea: Component<{
    value: string;
    results: PiiEntity[];
    // The text snapshot `results` was computed for. Highlights are
    // re-anchored from this snapshot to `value` on every render, so
    // they travel with edits while the detector is still catching up.
    resultsFor: string;
    placeholder?: string;
    disabled?: boolean;
    onInput: (text: string) => void;
    // Fires once submit intent is paired with settled analysis. The
    // text passed is the settled value at the moment of firing.
    onSubmit?: (text: string) => void;
    // Fires when a submit was requested but analysis hasn't settled
    // yet, so the submit is parked in `pendingSubmit`. Lets the host
    // expedite its debounced analysis (run it now) instead of making
    // the user wait out the debounce before the queued submit flushes.
    onSubmitPending?: () => void;
    // Optional keyboard binding for triggering submit from inside the
    // textarea. 'enter' = Enter submits, Shift+Enter inserts newline.
    submitOn?: 'enter' | 'cmd-enter';
    // 'background' (default) = today's bg fill. 'underline' = wavy
    // worm underline; bg fill kicks in only for marks whose type
    // matches focusedType (used to spotlight on pill hover).
    variant?: 'underline' | 'background';
    focusedType?: string | null;
    // 'default' (default) = textarea draws its own border + focus
    // ring. 'bare' = no border/ring on the textarea, so a parent can
    // wrap it in a card and own the chrome (used by the composer's
    // floating card with the send button overlaid).
    chrome?: 'default' | 'bare';
    // Extra classes for the outer wrapper — lets the host size the
    // component to its container (the testbed wants min-h-48, the
    // chat composer wants min-h-[44px] max-h-40 to match shadcn).
    class?: string;
    // Extra classes for the textarea/overlay layers — host can
    // override font/leading. Defaults to font-mono so the testbed
    // looks consistent with code; the composer overrides to sans.
    textClass?: string;
    // Imperative handle for external triggers (e.g. a Send button).
    ref?: (api: HighlightedTextareaApi) => void;
}> = (props) => {
    let textareaRef: HTMLTextAreaElement | undefined;
    let overlayRef: HTMLDivElement | undefined;

    const highlights = createMemo(() =>
        transformHighlights(props.results, props.resultsFor, props.value),
    );
    const segments = createMemo(() => buildSegments(props.value, highlights()));

    const settled = () => props.resultsFor === props.value;
    const [pendingSubmit, setPendingSubmit] = createSignal(false);
    const awaitingAnalysis = () => pendingSubmit() && !settled();

    const submit = () => {
        if (settled()) {
            props.onSubmit?.(props.value);
            return;
        }
        setPendingSubmit(true);
        props.onSubmitPending?.();
    };

    // Flush queued submit once the detector catches up. Guard re-runs
    // after we clear pendingSubmit so we don't fire twice.
    createEffect(() => {
        if (pendingSubmit() && settled()) {
            const text = props.value;
            setPendingSubmit(false);
            props.onSubmit?.(text);
        }
    });

    props.ref?.({ submit, settled, awaitingAnalysis });

    const syncScroll = () => {
        if (textareaRef && overlayRef) {
            overlayRef.scrollTop = textareaRef.scrollTop;
            overlayRef.scrollLeft = textareaRef.scrollLeft;
        }
    };

    const markClass = (type: string) => {
        const palette = paletteFor(type);
        const variant = props.variant ?? 'background';
        const focused = props.focusedType === type;
        // Only one bg-* class is in the string at a time — if both
        // `bg-transparent` and `palette.highlight` were emitted, the
        // cascade order between them depends on Tailwind's source
        // ordering, which made the hover spotlight flaky.
        // bg-transparent vs <mark>'s default yellow: browsers paint
        // <mark> yellow by default and preflight does not strip it.
        // clip-path clips the leftmost 1px of each mark so adjacent
        // entities have a visible gap between their underlines.
        if (variant === 'underline') {
            const bg = focused ? palette.highlight : 'bg-transparent';
            return `rounded-sm underline underline-offset-2 [text-decoration-thickness:2px] ${palette.decoration} text-transparent ${bg} [clip-path:inset(0px_0px_-2px_1px)]`;
        }
        return `rounded-sm ${palette.highlight} text-transparent`;
    };

    // A normal-flow "sizer" mirror sets the wrapper's intrinsic height
    // by replaying the current value with identical font/padding/wrap
    // rules. The overlay and textarea are absolute on top of it. This
    // gives chat-style autosize behavior bounded by min-h / max-h
    // classes passed via `class` — no JS resize observer needed.
    // textClass must include padding (the host may need extra right
    // padding to make room for an overlaid send button, etc.).
    const layerTypography = () =>
        `box-border text-sm leading-6 whitespace-pre-wrap break-words ${
            props.textClass ?? 'font-mono px-3 py-2'
        }`;
    const absoluteLayerClass = () => `absolute inset-0 m-0 ${layerTypography()} overflow-auto`;

    return (
        <div class={`relative w-full ${props.class ?? 'min-h-48 h-full'}`}>
            <div
                aria-hidden="true"
                class={`${layerTypography()} invisible ${
                    props.chrome === 'bare' ? '' : 'border border-transparent'
                }`}
            >
                {props.value}
                {'​'}
            </div>
            <div
                ref={overlayRef}
                aria-hidden="true"
                class={`${absoluteLayerClass()} pointer-events-none text-transparent ${
                    props.chrome === 'bare' ? '' : 'border border-transparent rounded-md'
                }`}
            >
                <For each={segments()}>
                    {(seg) =>
                        seg.kind === 'plain' ? (
                            <span>{seg.text}</span>
                        ) : (
                            <mark data-pii-type={seg.type} class={markClass(seg.type)}>
                                {seg.text}
                            </mark>
                        )
                    }
                </For>
                {'​'}
            </div>
            <textarea
                ref={textareaRef}
                class={`${absoluteLayerClass()} bg-transparent caret-foreground text-foreground resize-none focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 ${
                    props.chrome === 'bare'
                        ? 'focus-visible:shadow-none'
                        : 'border rounded-md focus:ring-2 focus:ring-ring'
                }`}
                spellcheck={false}
                placeholder={props.placeholder}
                disabled={props.disabled}
                value={props.value}
                onInput={(e) => {
                    if (pendingSubmit()) setPendingSubmit(false);
                    props.onInput(e.currentTarget.value);
                    syncScroll();
                }}
                onScroll={syncScroll}
                onKeyDown={(e) => {
                    if (!props.submitOn) return;
                    if (e.key !== 'Enter') return;
                    if (e.isComposing) return;
                    const enterSubmit = props.submitOn === 'enter' && !e.shiftKey;
                    const cmdEnterSubmit =
                        props.submitOn === 'cmd-enter' && (e.metaKey || e.ctrlKey);
                    if (enterSubmit || cmdEnterSubmit) {
                        e.preventDefault();
                        submit();
                    }
                }}
            />
        </div>
    );
};
