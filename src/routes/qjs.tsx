import { createResource, createSignal, Show, type Component } from 'solid-js';
import { Button } from '@/registry/ui/button';
import { TopBar } from '@/components/top-bar';
import { evalJS, initQJS } from '@/lib/qjs';
import { randomInt } from '@/lib/random';

const SNIPPETS = [
    '1 + 2 * 3',
    '[1,2,3,4,5].reduce((a,b)=>a+b, 0)',
    'Math.PI.toFixed(6)',
    '"hello, " + ["wasm","quickjs"].join(" + ")',
    '(()=>{const f=n=>n<2?n:f(n-1)+f(n-2); return f(15)})()',
    'JSON.stringify({a:1,b:[true,null,"x"]})',
    '[...Array(5).keys()].map(i=>i*i)',
];

function randomSnippet() {
    return SNIPPETS[randomInt(SNIPPETS.length)]!;
}

function msSince(startMs: number): number {
    return performance.now() - startMs;
}

function formatMs(ms: number): string {
    return `${ms.toFixed(3)} ms`;
}

const QjsPage: Component = () => {
    const [ready] = createResource(async () => {
        const t0 = performance.now();
        await initQJS();
        return msSince(t0);
    });
    const [code, setCode] = createSignal(randomSnippet());
    const [result, setResult] = createSignal<string>('');
    const [execMs, setExecMs] = createSignal<number | null>(null);

    const run = () => {
        try {
            const t0 = performance.now();
            const out = evalJS(code());
            setExecMs(msSince(t0));
            setResult(out);
        } catch (e) {
            setExecMs(null);
            setResult(String(e));
        }
    };

    const shuffle = () => {
        setCode(randomSnippet());
        run();
    };

    return (
        <main class="h-svh flex flex-col bg-background text-foreground">
            <TopBar />
            <header class="border-b bg-card/30 px-4 py-2 flex items-baseline gap-3 flex-none">
                <h1 class="text-base font-semibold">QuickJS in WebAssembly</h1>
                <span class="ml-auto text-xs text-muted-foreground font-mono">
                    init: {ready.loading ? '…' : ready.error ? 'failed' : formatMs(ready()!)}
                </span>
            </header>

            <Show
                when={!ready.loading && !ready.error}
                fallback={
                    <div class="flex-1 flex items-center justify-center">
                        <p class="text-muted-foreground">
                            {ready.error
                                ? `Failed to load qjs.wasm: ${ready.error}`
                                : 'Loading qjs.wasm…'}
                        </p>
                    </div>
                }
            >
                <div class="flex-1 min-h-0 grid grid-cols-2 divide-x divide-border">
                    <section class="flex flex-col min-h-0">
                        <div class="border-b px-4 py-2 flex items-center gap-2">
                            <span class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                Input
                            </span>
                            <div class="ml-auto flex gap-2">
                                <Button variant="secondary" size="sm" onClick={shuffle}>
                                    Random
                                </Button>
                                <Button size="sm" onClick={run}>
                                    Eval
                                </Button>
                            </div>
                        </div>
                        <textarea
                            class="flex-1 min-h-0 w-full resize-none bg-card text-card-foreground px-4 py-3 font-mono text-sm outline-none"
                            value={code()}
                            onInput={(e) => setCode(e.currentTarget.value)}
                            spellcheck={false}
                        />
                    </section>
                    <section class="flex flex-col min-h-0">
                        <div class="border-b px-4 py-2 flex items-center gap-2">
                            <span class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                Output
                            </span>
                            <span class="ml-auto text-xs text-muted-foreground font-mono">
                                exec: {execMs() === null ? '—' : formatMs(execMs()!)}
                            </span>
                        </div>
                        <pre class="flex-1 min-h-0 overflow-auto bg-card text-card-foreground px-4 py-3 font-mono text-sm whitespace-pre-wrap">
                            {result() || <span class="text-muted-foreground">— press Eval —</span>}
                        </pre>
                    </section>
                </div>
            </Show>
        </main>
    );
};

export default QjsPage;
