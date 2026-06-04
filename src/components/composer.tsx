import {
    batch,
    createEffect,
    createMemo,
    createSignal,
    For,
    on,
    onCleanup,
    onMount,
    Show,
    type Component,
    type JSX,
} from 'solid-js';
import { getPiiAccessor, type PiiEntity } from '@/lib/pii/client';
import { HighlightedTextarea, singleEditDiff } from '@/components/pii/highlighted-textarea';
import { formatLabel, paletteFor } from '@/components/pii/entity-badge';
import { Button } from '@/registry/ui/button';

// Dismissed entities are tracked as anchored intervals in resultsFor
// coordinates. The interval store gives us two operations:
//   * reanchor(diff): apply a single-edit diff; drop any interval the
//     edit touched (interior char changed → user revoked the dismissal
//     by editing it).
//   * reconcile(entities): given fresh detection results, keep only
//     intervals that have an exact (type, range, text) match in the
//     new entities. An intersection without exact match means the
//     entity changed → drop. No match at all means the detector no
//     longer flags it → drop.
type DismissalInterval = {
    type: string;
    start: number;
    end: number;
    text: string;
};

function intervalsIntersect(
    a: { start: number; end: number },
    b: { start: number; end: number },
): boolean {
    return a.start < b.end && a.end > b.start;
}

function entityMatchesInterval(e: PiiEntity, d: DismissalInterval): boolean {
    return e.entity_type === d.type && e.start === d.start && e.end === d.end && e.text === d.text;
}

function reanchorIntervals(
    intervals: DismissalInterval[],
    s: number,
    r: number,
    i: number,
): DismissalInterval[] {
    if (r === 0 && i === 0) return intervals;
    const editEnd = s + r;
    const delta = i - r;
    const out: DismissalInterval[] = [];
    for (const d of intervals) {
        if (r === 0 ? s <= d.start : editEnd <= d.start) {
            out.push({ ...d, start: d.start + delta, end: d.end + delta });
            continue;
        }
        if (s >= d.end) {
            out.push(d);
            continue;
        }
        // Edit overlaps the interval interior → drop.
    }
    return out;
}

// TODO: replace with a real user setting once settings management lands.
// When false the composer skips PII detection entirely; the visual
// layout (floating card, arrow-up button) stays the same.
const PII_GUARD_ENABLED = true;

const PII_DEBOUNCE_MS = 350;

type Props = {
    onSubmit: (text: string) => void;
    onStop: () => void;
    streaming: boolean;
    disabled: boolean;
    disabledReason?: string;
    /** Overrides the textarea placeholder when not disabled (e.g. to prompt
     * the user to answer a pending question). Defaults to "Ask anything…". */
    placeholder?: string;
    /** Optional control rendered on the same row as the hint, right-aligned. */
    trailing?: JSX.Element;
};

export const Composer: Component<Props> = (props) => (
    <div class="relative bg-background">
        {/*
          Soft fade so scrolled message text doesn't slam into the
          composer's solid background. The strip sits above the
          composer in negative space, overlapping the bottom of the
          message list; pointer-events-none lets clicks/scroll pass
          through to the messages underneath.
        */}
        <div
            aria-hidden="true"
            class="pointer-events-none absolute inset-x-0 -top-8 h-8 bg-gradient-to-b from-transparent to-background"
        />
        <div class="mx-auto max-w-3xl px-4 pb-1 pt-5">
            <Show when={PII_GUARD_ENABLED} fallback={<PlainComposer {...props} />}>
                <GuardedComposer {...props} />
            </Show>
        </div>
    </div>
);

const PlainComposer: Component<Props> = (props) => {
    const [text, setText] = createSignal('');

    const submit = () => {
        const v = text().trim();
        if (!v || props.streaming || props.disabled) return;
        props.onSubmit(v);
        setText('');
    };

    return (
        <>
            <ComposerCard
                streaming={props.streaming}
                sendDisabled={props.disabled || text().trim().length === 0}
                onSend={submit}
                onStop={props.onStop}
            >
                <textarea
                    class="block w-full resize-none bg-transparent text-sm leading-6 px-3 py-1.5 outline-none disabled:cursor-not-allowed disabled:opacity-50 field-sizing-content max-h-48"
                    rows={1}
                    placeholder={
                        props.disabled
                            ? (props.disabledReason ?? 'Disabled')
                            : (props.placeholder ?? 'Ask anything…')
                    }
                    disabled={props.disabled}
                    value={text()}
                    onInput={(e) => setText(e.currentTarget.value)}
                    onKeyDown={(e: KeyboardEvent) => {
                        if (
                            e.key === 'Enter' &&
                            !e.shiftKey &&
                            !(e as KeyboardEvent & { isComposing?: boolean }).isComposing
                        ) {
                            e.preventDefault();
                            submit();
                        }
                    }}
                />
            </ComposerCard>
            <HintRow
                hint={<HintLine tone="muted">Enter to send · Shift+Enter for newline</HintLine>}
                trailing={props.trailing}
            />
        </>
    );
};

const GuardedComposer: Component<Props> = (props) => {
    const [text, setText] = createSignal('');
    const [results, setResults] = createSignal<PiiEntity[]>([]);
    const [resultsFor, setResultsFor] = createSignal('');
    const [analyzing, setAnalyzing] = createSignal(false);
    // Worker boots in the background. Until it's ready we don't run
    // analysis and we don't block send — once it flips true we
    // backfill analysis for whatever the user typed in the meantime.
    const [piiReady, setPiiReady] = createSignal(false);
    // Dismissals: anchored intervals in resultsFor coordinates.
    // Stays frozen during typing (along with results, which are also
    // in resultsFor coordinates) so direct positional comparison
    // works. Re-anchored only when resultsFor itself changes.
    const [dismissals, setDismissals] = createSignal<DismissalInterval[]>([]);
    const [focusedType, setFocusedType] = createSignal<string | null>(null);

    let debounceTimer: number | undefined;
    let runToken = 0;

    const accessor = getPiiAccessor();

    onMount(() => {
        void accessor
            .warmup()
            .then(() => setPiiReady(true))
            .catch((e: unknown) => {
                console.error('[composer] PII warmup failed:', e);
            });
    });

    const settled = () => resultsFor() === text();

    // While the detector is not ready, keep `resultsFor` synced to
    // `text` so the HighlightedTextarea's own settled-then-submit
    // gate fires immediately. Without this, pressing Enter would
    // park in pendingSubmit and never flush.
    createEffect(() => {
        if (!piiReady()) setResultsFor(text());
    });

    // Backfill analysis the moment the worker becomes ready.
    createEffect(
        on(piiReady, (ready) => {
            if (ready && text().trim()) void analyze();
        }),
    );

    // Exact-match (type + range + text) against the current
    // dismissal intervals.
    const isDismissed = (e: PiiEntity, ds: DismissalInterval[]) => {
        for (const d of ds) if (entityMatchesInterval(e, d)) return true;
        return false;
    };

    const overlayEntities = createMemo(() => {
        const ds = dismissals();
        if (ds.length === 0) return results();
        return results().filter((e) => !isDismissed(e, ds));
    });

    const visibleEntities = createMemo(() => {
        if (!settled()) return [] as PiiEntity[];
        return overlayEntities();
    });

    const groupedByType = createMemo(() => {
        const groups = new Map<string, { count: number; firstStart: number }>();
        for (const e of visibleEntities()) {
            const g = groups.get(e.entity_type);
            if (g) {
                g.count += 1;
                if (e.start < g.firstStart) g.firstStart = e.start;
            } else {
                groups.set(e.entity_type, { count: 1, firstStart: e.start });
            }
        }
        return Array.from(groups.entries())
            .map(([type, { count, firstStart }]) => ({ type, count, firstStart }))
            .sort((a, b) => a.firstStart - b.firstStart);
    });

    const blocked = () => visibleEntities().length > 0;

    // Send is enabled as long as PII isn't actively standing in the
    // way. If the detector hasn't loaded yet we skip the gate — per
    // product decision, don't make users wait on a model warmup.
    const sendDisabled = () =>
        props.disabled || text().trim().length === 0 || (piiReady() && (analyzing() || blocked()));

    const analyze = async () => {
        const token = ++runToken;
        const t = text();
        if (!t.trim()) {
            batch(() => {
                setResults([]);
                setResultsFor(t);
                setAnalyzing(false);
            });
            return;
        }
        setAnalyzing(true);
        try {
            const { entities } = await accessor.analyze(t);
            if (token === runToken) {
                // Clear `analyzing` in the SAME batch that flips
                // `resultsFor` (→ settled). A queued Enter-submit flushes
                // the instant settled turns true; if `analyzing` were
                // still true at that moment (cleared afterwards in a
                // `finally`), the submit guard (`analyzing() || blocked()`)
                // would swallow it and the user would have to press Enter
                // a second time.
                batch(() => {
                    setResults(entities);
                    setResultsFor(t);
                    setAnalyzing(false);
                });
            }
        } catch {
            // Detection is best-effort; on error leave previous
            // results in place rather than yanking the gate open.
            if (token === runToken) setAnalyzing(false);
        }
    };

    const scheduleAnalyze = () => {
        if (!piiReady()) return;
        if (debounceTimer !== undefined) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            debounceTimer = undefined;
            void analyze();
        }, PII_DEBOUNCE_MS) as unknown as number;
    };

    onCleanup(() => {
        if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    });

    const onInput = (next: string) => {
        setText(next);
        scheduleAnalyze();
    };

    // The user pressed Enter before the debounced analysis ran, so the
    // submit is parked waiting for `settled`. Skip the remaining debounce
    // and analyze now so the queued submit flushes as soon as results
    // land, instead of stalling for up to PII_DEBOUNCE_MS.
    const analyzeNow = () => {
        if (debounceTimer !== undefined) {
            clearTimeout(debounceTimer);
            debounceTimer = undefined;
        }
        if (piiReady()) void analyze();
    };

    const ignoreType = (type: string) => {
        // Snapshot every currently-visible entity of this type as a
        // dismissal interval. visibleEntities is gated on settled, so
        // these positions are in the current resultsFor coordinate
        // space — same space dismissals are kept in.
        const additions: DismissalInterval[] = visibleEntities()
            .filter((e) => e.entity_type === type)
            .map((e) => ({
                type: e.entity_type,
                start: e.start,
                end: e.end,
                text: e.text,
            }));
        if (additions.length === 0) return;
        setDismissals((prev) => [...prev, ...additions]);
        if (focusedType() === type) setFocusedType(null);
    };

    const submit = (settledText: string) => {
        const v = settledText.trim();
        if (!v || props.streaming || props.disabled) return;
        if (piiReady() && (analyzing() || blocked())) return;
        props.onSubmit(v);
        batch(() => {
            setText('');
            setResults([]);
            setResultsFor('');
            setDismissals([]);
            setFocusedType(null);
        });
    };

    // When a new analysis snapshot lands, re-anchor dismissals from
    // the previous resultsFor coords to the new ones, dropping any
    // whose interior was touched by the cumulative edit. Then
    // reconcile against the fresh entities: keep only dismissals
    // that have an exact match — an intersection without exact
    // match means the detector now sees something different there,
    // so the dismissal is stale.
    let prevResultsFor = '';
    createEffect(
        on(resultsFor, (nowFor) => {
            const ds = dismissals();
            if (ds.length === 0) {
                prevResultsFor = nowFor;
                return;
            }
            let next = ds;
            if (prevResultsFor !== nowFor) {
                const { start, removed, inserted } = singleEditDiff(prevResultsFor, nowFor);
                next = reanchorIntervals(next, start, removed, inserted);
            }
            const entities = results();
            const matched: DismissalInterval[] = [];
            for (const d of next) {
                let keep = false;
                for (const e of entities) {
                    if (entityMatchesInterval(e, d)) {
                        keep = true;
                        break;
                    }
                    if (
                        e.entity_type === d.type &&
                        intervalsIntersect(d, { start: e.start, end: e.end })
                    ) {
                        // Same type, intersecting, but not equal —
                        // the detector now sees a different value at
                        // this spot. Drop.
                        keep = false;
                        break;
                    }
                }
                if (keep) matched.push(d);
            }
            if (matched.length !== ds.length || matched.some((d, i) => d !== ds[i])) {
                setDismissals(matched);
            }
            prevResultsFor = nowFor;
        }),
    );

    const hintTone = () => (blocked() ? 'destructive' : 'muted');
    const hint = () => {
        if (props.disabled && props.disabledReason) return props.disabledReason;
        if (blocked())
            return 'Send disabled — possible personal data detected. Dismiss each warning or edit the text.';
        if (piiReady() && analyzing()) return 'Analyzing for personal data…';
        return 'Enter to send · Shift+Enter for newline';
    };

    return (
        <>
            <Show when={groupedByType().length > 0}>
                <div class="mb-2 flex flex-wrap items-center gap-1.5">
                    <span class="text-[11px] uppercase tracking-wide text-muted-foreground">
                        Detected:
                    </span>
                    <For each={groupedByType()}>
                        {(g) => (
                            <button
                                type="button"
                                onMouseEnter={() => setFocusedType(g.type)}
                                onMouseLeave={() =>
                                    setFocusedType((cur) => (cur === g.type ? null : cur))
                                }
                                onFocus={() => setFocusedType(g.type)}
                                onBlur={() =>
                                    setFocusedType((cur) => (cur === g.type ? null : cur))
                                }
                                onClick={() => ignoreType(g.type)}
                                title={`Dismiss ${formatLabel(g.type)} warning`}
                                aria-label={`Dismiss ${formatLabel(g.type)} warning`}
                                class={`group inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-mono font-medium leading-none whitespace-nowrap transition-colors hover:brightness-110 ${
                                    paletteFor(g.type).chip
                                }`}
                            >
                                <span>{formatLabel(g.type)}</span>
                                <Show when={g.count > 1}>
                                    <span class="opacity-70">× {g.count}</span>
                                </Show>
                                <span
                                    aria-hidden="true"
                                    class="ml-0.5 text-base leading-none opacity-70 group-hover:opacity-100"
                                >
                                    ×
                                </span>
                            </button>
                        )}
                    </For>
                </div>
            </Show>

            <ComposerCard
                streaming={props.streaming}
                sendDisabled={sendDisabled()}
                onSend={() => submit(text())}
                onStop={props.onStop}
            >
                <HighlightedTextarea
                    value={text()}
                    results={overlayEntities()}
                    resultsFor={resultsFor()}
                    onInput={onInput}
                    onSubmit={submit}
                    onSubmitPending={analyzeNow}
                    submitOn="enter"
                    variant="underline"
                    focusedType={focusedType()}
                    chrome="bare"
                    disabled={props.disabled}
                    placeholder={
                        props.disabled
                            ? (props.disabledReason ?? 'Disabled')
                            : (props.placeholder ?? 'Ask anything…')
                    }
                    class="max-h-48"
                    textClass="font-sans px-2 py-1.5"
                />
            </ComposerCard>

            <HintRow
                hint={<HintLine tone={hintTone()}>{hint()}</HintLine>}
                trailing={props.trailing}
            />

            <Show when={visibleEntities().length > 0}>
                <div class="sr-only" aria-live="polite">
                    Possible personal data detected in your input.
                </div>
            </Show>
        </>
    );
};

const ComposerCard: Component<{
    streaming: boolean;
    sendDisabled: boolean;
    onSend: () => void;
    onStop: () => void;
    children: JSX.Element;
}> = (props) => (
    <div class="relative p-1 rounded-md border bg-background shadow-xs transition-shadow has-[textarea:focus]:ring-ring/50 has-[textarea:focus]:ring-[3px] has-[textarea:focus]:border-ring">
        <div class="min-w-0 pr-10">{props.children}</div>
        <div class="absolute top-1 right-1">
            <Show
                when={props.streaming}
                fallback={
                    <Button
                        type="button"
                        variant="secondary"
                        size="icon"
                        onClick={props.onSend}
                        disabled={props.sendDisabled}
                        aria-label="Send message"
                    >
                        <ArrowUpIcon class="size-4" />
                    </Button>
                }
            >
                <Button
                    type="button"
                    variant="secondary"
                    onClick={props.onStop}
                    aria-label="Stop generating"
                >
                    <StopIcon class="size-3" />
                    Stop
                </Button>
            </Show>
        </div>
    </div>
);

const HintRow: Component<{
    hint: JSX.Element;
    trailing?: JSX.Element;
}> = (props) => (
    <div class="flex items-center gap-2 mt-1">
        <div class="flex-1 min-w-0">{props.hint}</div>
        <Show when={props.trailing}>
            <div class="flex-none">{props.trailing}</div>
        </Show>
    </div>
);

const ArrowUpIcon: Component<{ class?: string }> = (props) => (
    <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
        class={props.class}
    >
        <line x1="12" y1="19" x2="12" y2="5" />
        <polyline points="5 12 12 5 19 12" />
    </svg>
);

const StopIcon: Component<{ class?: string }> = (props) => (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" class={props.class}>
        <rect x="5" y="5" width="14" height="14" rx="2" />
    </svg>
);

const HintLine: Component<{
    tone: 'muted' | 'destructive';
    children: JSX.Element;
}> = (props) => (
    <div
        class={`text-[11px] pl-1 truncate ${
            props.tone === 'destructive' ? 'text-destructive' : 'text-muted-foreground'
        }`}
    >
        {props.children}
    </div>
);
