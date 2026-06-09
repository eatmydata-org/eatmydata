import { createSignal, createMemo, Index, onMount, Show, For, type Component } from 'solid-js';
import { Button } from '@/registry/ui/button';
import { TopBar } from '@/components/top-bar';
import { PaneHeader, PaneHeaderTitle } from '@/components/pane-header';
import {
    warmupBgeEmbed,
    embedTextsSync,
    bgeDim,
    benchBgeEmbed,
    type BgeBenchResult,
} from '@/lib/bge-embed/runtime';

// Texts chosen so two pairs are near-synonyms (high cosine) and the pairs
// are unrelated to each other (low cross-pair cosine).
const SAMPLES = [
    'The cat sat quietly on the warm windowsill.',
    'A feline rested calmly by the sunny window.',
    'Quarterly revenue grew 12% year over year.',
    'Our Q3 sales rose compared with the prior year.',
];

/** Cosine similarity. Vectors come back L2-normalized, so this is just the
 *  dot product — but normalize defensively in case that ever changes. */
function cosine(a: number[], b: number[]): number {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i]! * b[i]!;
        na += a[i]! * a[i]!;
        nb += b[i]! * b[i]!;
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    return denom === 0 ? 0 : dot / denom;
}

// Green for similar, neutral for dissimilar — eyeballable heatmap.
function simBg(v: number): string {
    const clamped = Math.max(0, Math.min(1, v));
    return `rgba(16, 185, 129, ${(clamped * 0.6).toFixed(3)})`;
}

// ---- Throughput benchmark ------------------------------------------------

const LOREM =
    'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute irure reprehenderit voluptate velit esse cillum'.split(
        ' ',
    );

const LENGTH_PRESETS = [
    { label: 'short (~5w)', words: 5 },
    { label: 'medium (~30w)', words: 30 },
    { label: 'long (~120w)', words: 120 },
];
const COUNT_PRESETS = [32, 128, 256];

function makeCorpus(count: number, wordsPerPassage: number): string[] {
    const out: string[] = [];
    for (let i = 0; i < count; i++) {
        const words: string[] = [];
        for (let w = 0; w < wordsPerPassage; w++) {
            words.push(LOREM[(i * 7 + w * 13) % LOREM.length]!);
        }
        out.push(words.join(' '));
    }
    return out;
}

const EmbeddingsPage: Component = () => {
    const [texts, setTexts] = createSignal<string[]>([...SAMPLES]);
    const [ready, setReady] = createSignal(false);
    const [bootMs, setBootMs] = createSignal<number | null>(null);
    const [computing, setComputing] = createSignal(false);
    const [embedMs, setEmbedMs] = createSignal<number | null>(null);
    const [dims, setDims] = createSignal<number | null>(null);
    const [error, setError] = createSignal<string | null>(null);
    const [computed, setComputed] = createSignal<{ texts: string[]; vectors: number[][] } | null>(
        null,
    );

    // ---- Benchmark state ----
    const [benchCount, setBenchCount] = createSignal(COUNT_PRESETS[1]!);
    const [benchWords, setBenchWords] = createSignal(LENGTH_PRESETS[1]!.words);
    const [benchRunning, setBenchRunning] = createSignal(false);
    const [benchError, setBenchError] = createSignal<string | null>(null);
    const [bgeResult, setBgeResult] = createSignal<BgeBenchResult | null>(null);
    const [benchStatus, setBenchStatus] = createSignal<string | null>(null);

    const modelLabel = createMemo(() =>
        ready() ? `bge-small-en-v1.5 (q8_0) · ${bgeDim()} dims` : null,
    );

    onMount(() => {
        void (async () => {
            try {
                const t0 = performance.now();
                await warmupBgeEmbed();
                setBootMs(Math.round(performance.now() - t0));
                setReady(true);
            } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
            }
        })();
    });

    const updateText = (i: number, v: string) => {
        setTexts((prev) => prev.map((t, idx) => (idx === i ? v : t)));
    };
    const addRow = () => setTexts((prev) => [...prev, '']);
    const removeRow = (i: number) => setTexts((prev) => prev.filter((_, idx) => idx !== i));

    const compute = async () => {
        const snapshot = texts()
            .map((t) => t.trim())
            .filter((t) => t.length > 0);
        if (snapshot.length < 2) {
            setError('Enter at least two non-empty texts to compare.');
            return;
        }
        setComputing(true);
        setError(null);
        try {
            await warmupBgeEmbed();
            const t0 = performance.now();
            const vectors = embedTextsSync(snapshot);
            setEmbedMs(Math.round(performance.now() - t0));
            setDims(vectors[0]?.length ?? null);
            setComputed({ texts: snapshot, vectors });
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setComputing(false);
        }
    };

    const runBench = async () => {
        setBenchRunning(true);
        setBenchError(null);
        setBgeResult(null);
        setBenchStatus('Warming up bge-embed…');
        try {
            await warmupBgeEmbed();
            const corpus = makeCorpus(benchCount(), benchWords());
            setBenchStatus(`Embedding ${corpus.length} passages…`);
            setBgeResult(benchBgeEmbed(corpus, SAMPLES, { repeats: 3, onLog: () => {} }));
            setBenchStatus(null);
        } catch (e) {
            setBenchError(e instanceof Error ? e.message : String(e));
            setBenchStatus(null);
        } finally {
            setBenchRunning(false);
        }
    };

    return (
        <div class="h-svh flex flex-col bg-background text-foreground">
            <TopBar />

            <PaneHeader>
                <PaneHeaderTitle>Embeddings</PaneHeaderTitle>
            </PaneHeader>

            <div class="border-b bg-card/30 px-4 py-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
                <Show
                    when={ready()}
                    fallback={
                        <span class="whitespace-nowrap text-muted-foreground">
                            {error()
                                ? 'Error loading model'
                                : 'Loading bge-embed… (cached after first load)'}
                        </span>
                    }
                >
                    <span class="flex items-center gap-2 whitespace-nowrap">
                        <span class="text-emerald-600 dark:text-emerald-400">✓ model ready</span>
                        <span class="font-mono text-muted-foreground">{modelLabel()}</span>
                        <Show when={bootMs() !== null}>
                            <span class="text-muted-foreground">boot {bootMs()} ms</span>
                        </Show>
                        <Show when={embedMs() !== null}>
                            <span class="text-muted-foreground">embed {embedMs()} ms</span>
                        </Show>
                        <Show when={dims() !== null}>
                            <span class="text-muted-foreground">{dims()} dims</span>
                        </Show>
                    </span>
                </Show>
            </div>

            <Show when={error()}>
                <div class="border-b border-destructive/50 bg-destructive/10 text-destructive px-4 py-2 text-sm font-mono whitespace-pre-wrap">
                    {error()}
                </div>
            </Show>

            <div class="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-2 gap-4 p-4 overflow-auto">
                <section class="flex flex-col gap-2 min-h-0">
                    <div class="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                        Texts
                    </div>
                    <div class="flex flex-col gap-2">
                        <Index each={texts()}>
                            {(t, i) => (
                                <div class="flex items-center gap-2">
                                    <span class="w-5 text-right text-xs text-muted-foreground">
                                        {i + 1}
                                    </span>
                                    <input
                                        type="text"
                                        class="flex-1 rounded-md border bg-background px-2 py-1 text-sm"
                                        value={t()}
                                        onInput={(e) => updateText(i, e.currentTarget.value)}
                                        placeholder="Enter text to embed…"
                                    />
                                    <button
                                        type="button"
                                        class="px-2 py-0.5 rounded border bg-background hover:bg-muted/60 text-xs"
                                        onClick={() => removeRow(i)}
                                        disabled={texts().length <= 2}
                                        title={
                                            texts().length <= 2
                                                ? 'Need at least two texts'
                                                : 'Remove'
                                        }
                                    >
                                        ✕
                                    </button>
                                </div>
                            )}
                        </Index>
                    </div>
                    <div class="flex items-center gap-2">
                        <Button size="sm" variant="outline" onClick={addRow}>
                            + Add text
                        </Button>
                        <Button size="sm" onClick={compute} disabled={!ready() || computing()}>
                            <Show when={computing()} fallback="Compute embeddings">
                                Computing…
                            </Show>
                        </Button>
                    </div>
                </section>

                <section class="flex flex-col gap-2 min-h-0">
                    <div class="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                        Cosine similarity
                    </div>
                    <Show
                        when={computed()}
                        fallback={
                            <div class="text-sm text-muted-foreground">
                                Compute embeddings to see the pairwise similarity matrix.
                            </div>
                        }
                    >
                        {(c) => (
                            <div class="overflow-auto rounded-md border bg-card/30 p-2">
                                <table class="text-xs border-collapse">
                                    <thead>
                                        <tr>
                                            <th class="p-1" />
                                            <For each={c().texts}>
                                                {(_, j) => (
                                                    <th class="p-1 font-mono text-muted-foreground">
                                                        {j() + 1}
                                                    </th>
                                                )}
                                            </For>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        <For each={c().vectors}>
                                            {(row, i) => (
                                                <tr>
                                                    <th
                                                        class="p-1 font-mono text-right text-muted-foreground max-w-[14rem] truncate"
                                                        title={c().texts[i()]}
                                                    >
                                                        {i() + 1}. {c().texts[i()]}
                                                    </th>
                                                    <For each={c().vectors}>
                                                        {(col) => {
                                                            const v = cosine(row, col);
                                                            return (
                                                                <td
                                                                    class="p-1 text-center font-mono tabular-nums"
                                                                    style={{
                                                                        'background-color':
                                                                            simBg(v),
                                                                    }}
                                                                >
                                                                    {v.toFixed(2)}
                                                                </td>
                                                            );
                                                        }}
                                                    </For>
                                                </tr>
                                            )}
                                        </For>
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </Show>
                </section>

                <section class="md:col-span-2 flex flex-col gap-2 min-h-0">
                    <div class="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                        Throughput benchmark
                    </div>

                    <div class="flex flex-wrap items-center gap-3 text-xs">
                        <label class="flex items-center gap-1.5">
                            <span class="text-muted-foreground">Passages</span>
                            <select
                                class="rounded border bg-background px-2 py-1"
                                value={benchCount()}
                                onChange={(e) => setBenchCount(Number(e.currentTarget.value))}
                            >
                                <For each={COUNT_PRESETS}>
                                    {(c) => <option value={c}>{c}</option>}
                                </For>
                            </select>
                        </label>
                        <label class="flex items-center gap-1.5">
                            <span class="text-muted-foreground">Length</span>
                            <select
                                class="rounded border bg-background px-2 py-1"
                                value={benchWords()}
                                onChange={(e) => setBenchWords(Number(e.currentTarget.value))}
                            >
                                <For each={LENGTH_PRESETS}>
                                    {(p) => <option value={p.words}>{p.label}</option>}
                                </For>
                            </select>
                        </label>
                        <Button size="sm" onClick={runBench} disabled={!ready() || benchRunning()}>
                            <Show when={benchRunning()} fallback="Run benchmark">
                                Running…
                            </Show>
                        </Button>
                        <Show when={benchStatus()}>
                            <span class="flex items-center gap-1.5 text-muted-foreground">
                                <span class="inline-block size-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
                                {benchStatus()}
                            </span>
                        </Show>
                    </div>

                    <Show when={benchError()}>
                        <div class="text-destructive text-xs font-mono whitespace-pre-wrap">
                            {benchError()}
                        </div>
                    </Show>

                    <Show when={bgeResult()}>
                        {(b) => (
                            <div class="rounded-md border bg-card/30 p-2 text-xs">
                                <span class="font-mono text-foreground">
                                    bge-embed (C/wasm, q8_0)
                                </span>{' '}
                                <span class="text-muted-foreground">
                                    — {b().passages} passages, 3 repeats:
                                </span>{' '}
                                <span class="tabular-nums font-medium">
                                    {Math.round(b().passagesPerSec)}
                                </span>{' '}
                                passages/s ·{' '}
                                <span class="tabular-nums">{b().msPerPassage.toFixed(2)}</span>{' '}
                                ms/passage · warmup{' '}
                                <span class="tabular-nums">{Math.round(b().warmupMs)}</span> ms
                            </div>
                        )}
                    </Show>
                </section>
            </div>
        </div>
    );
};

export default EmbeddingsPage;
