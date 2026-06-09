import { Show, type Component } from 'solid-js';
import type { ActionExecution } from '@/lib/actions/executor';
import { toBlocks } from '@/lib/actions/executor';
import type { ActionOutputFormat } from '@/lib/actions/types';
import { MAX_HTML_CHARS, MAX_JSON_PRE_CHARS } from '@/lib/actions/render-limits';
import { StreamedMarkdown } from './streamed-markdown';
import { sanitizeHtml } from '@/lib/sanitize-html';
import { EChartsDashboard } from './echarts-dashboard';
import { ResultBlocks } from './result-blocks';

type Props = {
    result: ActionExecution;
};

/**
 * Shared renderer for an action execution result — the result *body*
 * (error, data sources, output, stdout). Callers supply their own chrome:
 * the in-chat side panel wraps it with a re-run / open-in-new-window
 * toolbar; the standalone `/result/:id` route prefixes a name + timestamp.
 */
export const ActionResultView: Component<Props> = (props) => {
    const r = () => props.result;

    return (
        <div class="flex flex-col gap-4 text-sm">
            <Show when={r().error}>
                <section class="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2">
                    <div class="text-destructive text-xs uppercase tracking-wider font-semibold mb-1">
                        error
                    </div>
                    <pre class="text-xs font-mono whitespace-pre-wrap break-words">{r().error}</pre>
                </section>
            </Show>

            <Show when={r().output !== undefined && !r().error}>
                <OutputRenderer output={r().output} format={r().outputFormat} />
            </Show>
        </div>
    );
};

const OutputRenderer: Component<{
    output: unknown;
    format: ActionOutputFormat;
}> = (props) => {
    return (
        <div>
            <Show when={props.format === 'blocks'}>
                <BlocksOrJson output={props.output} />
            </Show>
            <Show when={props.format === 'markdown'}>
                <div class="rounded-lg border bg-card px-4 py-3 text-sm">
                    <StreamedMarkdown content={String(props.output ?? '')} streaming={false} />
                </div>
            </Show>
            <Show when={props.format === 'html'}>
                <HtmlOutput output={props.output} />
            </Show>
            <Show when={props.format === 'json'}>
                <pre class="rounded-lg border bg-card px-3 py-2 text-xs font-mono whitespace-pre-wrap break-words overflow-auto">
                    {formatJson(props.output)}
                </pre>
            </Show>
            <Show when={props.format === 'echarts'}>
                <EChartsDashboard output={props.output} />
            </Show>
        </div>
    );
};

/** Normalize the composable block output; fall back to the JSON `<pre>` if the
 *  shape didn't survive normalization (defensive — should not happen). */
const BlocksOrJson: Component<{ output: unknown }> = (props) => {
    const blocks = () => toBlocks(props.output);
    return (
        <Show
            when={blocks().length > 0}
            fallback={
                <pre class="rounded-lg border bg-card px-3 py-2 text-xs font-mono whitespace-pre-wrap break-words overflow-auto">
                    {formatJson(props.output)}
                </pre>
            }
        >
            <ResultBlocks blocks={blocks()} />
        </Show>
    );
};

/** LLM-authored sandbox HTML (untrusted). `sanitizeHtml()` strips
 *  scripts/handlers/javascript: URLs; we also refuse anything past a size cap
 *  so a giant string can't stall the DOM. */
const HtmlOutput: Component<{ output: unknown }> = (props) => {
    const html = () => String(props.output ?? '');
    return (
        <Show
            when={html().length <= MAX_HTML_CHARS}
            fallback={
                <div class="rounded-lg border bg-card px-4 py-3 text-xs text-muted-foreground">
                    Output too large to render as HTML ({html().length.toLocaleString()} chars). Ask
                    for a downloadable table or a summary.
                </div>
            }
        >
            <div
                class="rounded-lg border bg-card px-4 py-3 prose prose-sm max-w-none"
                // eslint-disable-next-line solid/no-innerhtml -- sanitized above
                innerHTML={sanitizeHtml(html())}
            />
        </Show>
    );
};

function formatJson(x: unknown): string {
    try {
        const s = JSON.stringify(x, null, 2);
        if (s.length > MAX_JSON_PRE_CHARS) {
            return (
                s.slice(0, MAX_JSON_PRE_CHARS) +
                `\n… [truncated ${(s.length - MAX_JSON_PRE_CHARS).toLocaleString()} chars]`
            );
        }
        return s;
    } catch {
        return String(x);
    }
}
