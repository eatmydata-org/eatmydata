import { batch, createSignal, onCleanup, onMount, Show, type Component } from 'solid-js';
import { Button } from '@/registry/ui/button';
import { TopBar } from '@/components/top-bar';
import { PaneHeader, PaneHeaderTitle } from '@/components/pane-header';
import { getPiiAccessor, PII_REGEX_ONLY, type PiiEntity, type PiiManifest } from '@/lib/pii/client';
import {
    HighlightedTextarea,
    type HighlightedTextareaApi,
} from '@/components/pii/highlighted-textarea';
import { EntityList } from '@/components/pii/entity-list';

// Sample texts chosen to exercise the broader label set of used PII detector:
// names, addresses, phones, emails, government IDs, financial identifiers,
// DOBs, network identifiers, credentials, and the medical / employment fields.
const SAMPLES = [
    {
        label: 'Customer service ticket',
        text:
            'Hi, my name is Alice Smith and I live at 742 Evergreen Terrace, ' +
            'Springfield, OR 62704, USA. You can reach me on +1 (415) 555-0132 ' +
            'or at alice.smith@example.com. My account number is 8810-447-2219.',
    },
    {
        label: 'KYC-style intake',
        text:
            'Applicant: John Doe, DOB 1987-03-14, age 38. ' +
            'SSN 123-45-6789, driver license D1234567 (CA), passport AB1234567. ' +
            'Card on file: 4012 8888 8888 1881, CVV 321, exp 04/27. ' +
            'Routing 021000021, SWIFT CHASUS33.',
    },
    {
        label: 'Account creation + network',
        text:
            "New user 'maria_h' registered with password Hunter2! and email " +
            'maria.hernandez@example.org. Phone +44 20 7946 0958, address ' +
            '10 Downing Street, London, SW1A 2AA. Logged in from 192.168.1.42 ' +
            'and 2001:db8::1; MAC 3c:22:fb:91:0a:7e; API key sk_live_a1b2c3d4e5f6.',
    },
    {
        label: 'Clinical + employment record',
        text:
            'Patient Sarah Chen, female, blood type O+, MRN 778-3321, ' +
            'health plan 8810-447. Works as a Software Engineer at Acme Corp ' +
            '(employee ID E-44219), currently employed. Native language English, ' +
            'lives in Toronto, Ontario, Canada. Visit on 2025-04-12 at 14:30.',
    },
];

const DEBOUNCE_MS = 400;

const PiiPage: Component = () => {
    const [text, setText] = createSignal(SAMPLES[0]!.text);
    const [results, setResults] = createSignal<PiiEntity[]>([]);
    // The text snapshot `results` corresponds to. Starts empty so the
    // textarea treats the initial sample as "not yet analyzed."
    const [resultsFor, setResultsFor] = createSignal('');
    const [analyzing, setAnalyzing] = createSignal(false);
    const [ready, setReady] = createSignal(false);
    const [bootMs, setBootMs] = createSignal<number | null>(null);
    const [inferMs, setInferMs] = createSignal<number | null>(null);
    const [regexMs, setRegexMs] = createSignal<number | null>(null);
    const [error, setError] = createSignal<string | null>(null);
    const [manifest, setManifest] = createSignal<PiiManifest | null>(null);
    const [api, setApi] = createSignal<HighlightedTextareaApi | null>(null);
    const [lastSubmit, setLastSubmit] = createSignal<{
        text: string;
        entities: PiiEntity[];
    } | null>(null);

    let debounceTimer: number | undefined;
    let runToken = 0;

    const accessor = getPiiAccessor();

    onMount(() => {
        if (PII_REGEX_ONLY) {
            // Regex fallback needs no model boot and no manifest.
            setReady(true);
            scheduleAnalyze();
            return;
        }
        // Manifest is a tiny JSON next to the model in the deploy tree;
        // fetch it first so the header can render model_id + dtype while
        // the heavy ONNX still downloads.
        void (async () => {
            try {
                setManifest(await accessor.getManifest());
            } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
            }
        })();
        void (async () => {
            try {
                await accessor.warmup();
                const ms = await accessor.bootElapsedMs();
                setBootMs(ms);
                setReady(true);
                scheduleAnalyze();
            } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
            }
        })();
    });

    const analyze = async () => {
        const token = ++runToken;
        const t = text();
        if (!t.trim()) {
            batch(() => {
                setResults([]);
                setResultsFor(t);
                setInferMs(null);
                setRegexMs(null);
                setError(null);
            });
            return;
        }
        setAnalyzing(true);
        setError(null);
        try {
            const { entities, stats } = PII_REGEX_ONLY
                ? await accessor.analyzeRegex(t, { withSources: true })
                : await accessor.analyze(t, { withSources: true });
            if (token === runToken) {
                // Batch so the textarea memo sees (results, resultsFor)
                // update atomically — otherwise it'd briefly transform
                // new results from the previous snapshot.
                batch(() => {
                    setResults(entities);
                    setResultsFor(t);
                    setInferMs(Math.round(stats.inferMs));
                    setRegexMs(stats.regexMs !== undefined ? Math.round(stats.regexMs) : null);
                });
            }
        } catch (e) {
            if (token === runToken) {
                setError(e instanceof Error ? e.message : String(e));
            }
        } finally {
            if (token === runToken) setAnalyzing(false);
        }
    };

    const handleSubmit = (submittedText: string) => {
        setLastSubmit({ text: submittedText, entities: results() });
    };

    const scheduleAnalyze = () => {
        if (debounceTimer !== undefined) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            debounceTimer = undefined;
            void analyze();
        }, DEBOUNCE_MS) as unknown as number;
    };

    onCleanup(() => {
        if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    });

    const onInput = (next: string) => {
        setText(next);
        scheduleAnalyze();
    };

    const loadSample = (sampleText: string) => {
        setText(sampleText);
        scheduleAnalyze();
    };

    return (
        <div class="h-svh flex flex-col bg-background text-foreground">
            <TopBar />

            <PaneHeader>
                <PaneHeaderTitle>PII</PaneHeaderTitle>
            </PaneHeader>

            <div class="border-b bg-card/30 px-4 py-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
                <span class="flex items-center gap-1.5 whitespace-nowrap text-muted-foreground">
                    <Show
                        when={!PII_REGEX_ONLY}
                        fallback={
                            <>
                                <span>regex fallback</span>
                                <span
                                    class="font-mono rounded border px-1 py-0.5 text-[10px] uppercase bg-muted/60"
                                    title="No model download — Presidio-style regex recognizers only"
                                >
                                    regex
                                </span>
                            </>
                        }
                    >
                        <span>transformers.js</span>
                        <Show
                            when={manifest()}
                            fallback={<span class="italic">loading manifest…</span>}
                        >
                            {(m) => (
                                <>
                                    <a
                                        href={m().source_url}
                                        target="_blank"
                                        rel="noopener"
                                        class="font-mono text-foreground hover:underline"
                                    >
                                        {m().model_id}
                                    </a>
                                    <span
                                        class="font-mono rounded border px-1 py-0.5 text-[10px] uppercase bg-muted/60"
                                        title={`source ${m().source_dtype} → export ${m().dtype} (never upscales)`}
                                    >
                                        {m().source_dtype} → {m().dtype}
                                    </span>
                                </>
                            )}
                        </Show>
                    </Show>
                </span>
                <Show
                    when={ready()}
                    fallback={
                        <span class="whitespace-nowrap text-muted-foreground">
                            Loading model… (cached after first load)
                        </span>
                    }
                >
                    <span class="flex items-center gap-2 whitespace-nowrap">
                        <span class="text-emerald-600 dark:text-emerald-400">
                            ✓ {PII_REGEX_ONLY ? 'regex ready' : 'model ready'}
                        </span>
                        <Show when={bootMs() !== null}>
                            <span class="text-muted-foreground">boot {bootMs()} ms</span>
                        </Show>
                        <Show when={inferMs() !== null && !PII_REGEX_ONLY}>
                            <span class="text-muted-foreground">ner {inferMs()} ms</span>
                        </Show>
                        <Show when={regexMs() !== null}>
                            <span class="text-muted-foreground">regex {regexMs()} ms</span>
                        </Show>
                        <Show when={analyzing()}>
                            <span class="text-muted-foreground">analyzing…</span>
                        </Show>
                    </span>
                </Show>
                <div class="ml-auto flex flex-wrap items-center justify-end gap-1.5">
                    <span class="text-muted-foreground">samples:</span>
                    {SAMPLES.map((s) => (
                        <button
                            type="button"
                            class="px-2 py-0.5 rounded border bg-background hover:bg-muted/60 transition-colors whitespace-nowrap"
                            onClick={() => loadSample(s.text)}
                        >
                            {s.label}
                        </button>
                    ))}
                </div>
            </div>

            <Show when={error()}>
                <div class="border-b border-destructive/50 bg-destructive/10 text-destructive px-4 py-2 text-sm font-mono whitespace-pre-wrap">
                    {error()}
                </div>
            </Show>

            <div class="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-2 gap-4 p-4">
                <section class="flex flex-col gap-2 min-h-0">
                    <div class="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                        Input
                    </div>
                    <div class="flex-1 min-h-0 relative">
                        <HighlightedTextarea
                            value={text()}
                            results={results()}
                            resultsFor={resultsFor()}
                            onInput={onInput}
                            onSubmit={handleSubmit}
                            submitOn="enter"
                            ref={setApi}
                            placeholder="Paste text to analyze, press Enter to submit (Shift+Enter for newline)…"
                        />
                    </div>
                    <div class="flex items-center gap-2 text-xs">
                        <Button
                            size="sm"
                            onClick={() => api()?.submit()}
                            disabled={!text().trim() || (api()?.awaitingAnalysis() ?? false)}
                        >
                            <Show when={api()?.awaitingAnalysis()} fallback="Send">
                                Analyzing…
                            </Show>
                        </Button>
                        <Show when={lastSubmit()}>
                            {(s) => (
                                <span class="text-muted-foreground">
                                    Submitted: {s().entities.length} entities
                                    <Show when={s().entities.length > 0}>
                                        {' '}
                                        (
                                        {Array.from(new Set(s().entities.map((e) => e.entity_type)))
                                            .slice(0, 4)
                                            .join(', ')}
                                        {s().entities.length > 0 &&
                                        new Set(s().entities.map((e) => e.entity_type)).size > 4
                                            ? ', …'
                                            : ''}
                                        )
                                    </Show>
                                </span>
                            )}
                        </Show>
                    </div>
                </section>
                <section class="flex flex-col gap-2 min-h-0">
                    <div class="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-2">
                        Detected entities
                        <span class="text-foreground font-mono">({results().length})</span>
                    </div>
                    <div class="flex-1 min-h-0 overflow-auto rounded-md border p-2 bg-card/30">
                        <EntityList text={text()} results={results()} />
                    </div>
                </section>
            </div>
        </div>
    );
};

export default PiiPage;
