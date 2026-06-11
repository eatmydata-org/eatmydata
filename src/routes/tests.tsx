import { createSignal, For, Show, type Component } from 'solid-js';
import { Button } from '@/registry/ui/button';
import { TopBar } from '@/components/top-bar';
import {
    runAll,
    formatReport,
    type TestDef,
    type TestResult,
    type RunSummary,
} from '@/lib/test-runner/runner';
import { VECTOR_SEARCH_TESTS } from '@/lib/test-runner/tests-vector-search';
import { BGE_EMBED_TESTS } from '@/lib/test-runner/tests-bge-embed';
import { BERT_NER_TESTS } from '@/lib/test-runner/tests-bert-ner';
import { WA_SQLITE_TESTS } from '../lib/test-runner/tests-wa-sqlite';
import { RESULT_BLOCKS_TESTS } from '../lib/test-runner/tests-result-blocks';

const ALL_TESTS: TestDef[] = [
    ...WA_SQLITE_TESTS,
    ...RESULT_BLOCKS_TESTS,
    ...VECTOR_SEARCH_TESTS,
    ...BGE_EMBED_TESTS,
    ...BERT_NER_TESTS,
];

const TestsPage: Component = () => {
    const initialResults: Record<string, Partial<TestResult>> = Object.fromEntries(
        ALL_TESTS.map((t) => [
            t.id,
            {
                id: t.id,
                name: t.name,
                status: 'pending',
                capturedErrors: [],
                logs: [],
                durationMs: 0,
            },
        ]),
    );
    const [results, setResults] = createSignal<Record<string, Partial<TestResult>>>(initialResults);
    const [running, setRunning] = createSignal(false);
    const [summary, setSummary] = createSignal<RunSummary | null>(null);
    const [report, setReport] = createSignal<string>('');
    const [copyStatus, setCopyStatus] = createSignal<string | null>(null);

    const run = async () => {
        if (running()) return;
        setRunning(true);
        setSummary(null);
        setReport('');
        setResults(initialResults);
        try {
            const { results: final, summary: sum } = await runAll(ALL_TESTS, (id, partial) => {
                setResults((prev) => ({
                    ...prev,
                    [id]: { ...prev[id], ...partial },
                }));
            });
            setSummary(sum);
            const reportText = formatReport(final, sum, {
                userAgent: navigator.userAgent,
                href: window.location.href,
                runAt: new Date(),
            });
            setReport(reportText);
        } finally {
            setRunning(false);
        }
    };

    const copyReport = async () => {
        try {
            await navigator.clipboard.writeText(report());
            setCopyStatus('Copied!');
        } catch {
            setCopyStatus('Copy failed — select & ⌘C the box below.');
        }
        setTimeout(() => setCopyStatus(null), 2000);
    };

    const statusIcon = (status: TestResult['status'] | undefined) => {
        switch (status) {
            case 'passed':
                return { glyph: '✓', cls: 'text-green-600' };
            case 'failed':
                return { glyph: '✗', cls: 'text-destructive' };
            case 'running':
                return { glyph: '…', cls: 'text-blue-600' };
            case 'skipped':
                return { glyph: '-', cls: 'text-muted-foreground' };
            default:
                return { glyph: '·', cls: 'text-muted-foreground' };
        }
    };

    return (
        <div class="h-svh flex flex-col bg-background text-foreground">
            <TopBar />
            <header class="border-b bg-card/30 px-4 py-2 flex items-center gap-3 flex-none">
                <h1 class="text-base font-semibold">Browser tests</h1>
                <span class="text-xs text-muted-foreground">
                    DOM / worker / multi-tab scenarios that vitest can't reach
                    <span class="ml-2 opacity-80">
                        · ONNX-comparison cases (NER vs ONNX) need the comparison assets — build
                        with <code class="font-mono">make onnx-models</code>
                    </span>
                </span>
                <div class="ml-auto flex items-center gap-2">
                    <Show when={summary()}>
                        {(s) => (
                            <span class="text-xs font-mono">
                                <span class="text-green-600">{s().passed} pass</span>
                                {' / '}
                                <span class="text-destructive">{s().failed} fail</span>
                                {' · '}
                                {s().durationMs.toFixed(0)}ms
                            </span>
                        )}
                    </Show>
                    <Button onClick={run} disabled={running()} size="sm">
                        {running() ? 'Running…' : 'Run all tests'}
                    </Button>
                </div>
            </header>

            <div class="flex-1 min-h-0 flex">
                <main class="flex-1 min-w-0 overflow-y-auto p-4">
                    <ul class="space-y-1">
                        <For each={ALL_TESTS}>
                            {(def) => {
                                const r = () => results()[def.id];
                                const icon = () => statusIcon(r()?.status);
                                return (
                                    <li class="border rounded-md px-3 py-2 bg-card">
                                        <div class="flex items-center gap-2">
                                            <span class={`font-mono w-4 text-center ${icon().cls}`}>
                                                {icon().glyph}
                                            </span>
                                            <span class="font-mono text-xs text-muted-foreground">
                                                {def.id}
                                            </span>
                                            <span class="text-sm">{def.name}</span>
                                            <Show
                                                when={
                                                    r()?.status === 'passed' ||
                                                    r()?.status === 'failed'
                                                }
                                            >
                                                <span class="ml-auto text-xs font-mono text-muted-foreground">
                                                    {r()!.durationMs!.toFixed(0)}
                                                    ms
                                                </span>
                                            </Show>
                                        </div>
                                        <Show when={r()?.error}>
                                            {(err) => (
                                                <pre class="mt-2 text-xs font-mono whitespace-pre-wrap text-destructive bg-destructive/5 rounded px-2 py-1">
                                                    {err().message}
                                                </pre>
                                            )}
                                        </Show>
                                        <Show when={(r()?.capturedErrors ?? []).length > 0}>
                                            <div class="mt-2 space-y-1">
                                                <For each={r()!.capturedErrors!}>
                                                    {(c) => (
                                                        <div class="text-xs font-mono whitespace-pre-wrap bg-amber-500/10 text-amber-700 dark:text-amber-300 rounded px-2 py-1">
                                                            <span class="opacity-70">
                                                                [{c.source}]
                                                            </span>{' '}
                                                            {c.message}
                                                        </div>
                                                    )}
                                                </For>
                                            </div>
                                        </Show>
                                    </li>
                                );
                            }}
                        </For>
                    </ul>
                </main>
                <aside class="w-[480px] shrink-0 border-l flex flex-col bg-card/30">
                    <div class="px-3 py-2 border-b flex items-center gap-2">
                        <span class="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                            Report (copy-paste)
                        </span>
                        <div class="ml-auto flex items-center gap-2">
                            <Show when={copyStatus()}>
                                <span class="text-xs text-muted-foreground">{copyStatus()}</span>
                            </Show>
                            <Button size="sm" onClick={copyReport} disabled={!report()}>
                                Copy
                            </Button>
                        </div>
                    </div>
                    <textarea
                        readonly
                        class="flex-1 min-h-0 resize-none p-3 text-xs font-mono whitespace-pre bg-background outline-none"
                        value={report()}
                        placeholder="Run the tests, then this panel fills with a single text report you can paste into a bug report or chat."
                    />
                </aside>
            </div>
        </div>
    );
};

export default TestsPage;
