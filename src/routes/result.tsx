import { Match, Show, Switch, type Component } from 'solid-js';
import { useParams } from '@solidjs/router';
import { getResult, isResultLoading } from '@/lib/runtime/client';
import { ActionResultView } from '@/components/action-result-view';

const ResultPage: Component = () => {
    const params = useParams<{ id: string }>();
    const result = () => getResult(params.id);
    const loading = () => isResultLoading(params.id);
    return (
        <div class="h-svh flex flex-col bg-background text-foreground px-4">
            <Switch>
                <Match when={result()}>
                    <main class="flex-1 min-h-0 overflow-y-auto">
                        <div class="max-w-4xl w-full mx-auto py-4">
                            <h1 class="text-xl font-semibold">{result()!.actionName}</h1>
                            <p class="text-xs text-muted-foreground my-2">
                                Generated {formatGeneratedAt(result()!.finishedAt)}
                            </p>
                            <ActionResultView result={result()!} />
                        </div>
                    </main>
                </Match>
                <Match when={loading()}>
                    <LoadingIndicator />
                </Match>
                <Match when={!result() && !loading()}>
                    <div class="flex-1 flex items-center justify-center text-sm text-muted-foreground italic px-6 text-center">
                        Result not found.
                    </div>
                </Match>
            </Switch>
        </div>
    );
};

const LoadingIndicator: Component = () => (
    <div class="flex-1 flex flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        <svg
            class="animate-spin size-5 text-primary"
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
        >
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
        </svg>
        <span>Loading result…</span>
    </div>
);

function formatGeneratedAt(ts: number): string {
    return new Date(ts).toLocaleString();
}

function durationMs(ms: number): string {
    if (ms < 1000) return `${ms} ms`;
    return `${(ms / 1000).toFixed(2)} s`;
}

export default ResultPage;
