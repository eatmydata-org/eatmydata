import { SolidMarkdown } from 'solid-markdown';
import remarkGfm from 'remark-gfm';
import { For, Show, createMemo, type Component } from 'solid-js';
import { parseIncompleteMarkdown } from '@/lib/remend';
import { capMarkdownTables } from '@/lib/markdown/cap-tables';

type StreamedMarkdownProps = {
    content: string;
    streaming: boolean;
    isThinking?: boolean;
};

const splitWords = (s: string): string[] => {
    if (!s) return [];
    const tokens = s.split(/(\s+)/);
    const result: string[] = [];
    for (let i = 0; i < tokens.length; i += 2) {
        const word = tokens[i] ?? '';
        const ws = tokens[i + 1] ?? '';
        if (!word && !ws) continue;
        result.push(word + ws);
    }
    return result;
};

const TextNode: Component<{ node: { value: string } }> = (props) => {
    const words = createMemo(() => splitWords(props.node.value));
    return <For each={words()}>{(w) => <span class="sd-word">{w}</span>}</For>;
};

export function StreamedMarkdown(props: StreamedMarkdownProps) {
    const prepared = createMemo(() => {
        const capped = capMarkdownTables(props.content);
        return props.streaming ? parseIncompleteMarkdown(capped) : capped;
    });

    return (
        <div class="sd-bubble" data-streaming={props.streaming ? 'true' : undefined}>
            <Show when={props.isThinking}>
                <div class="h-4"></div>
            </Show>
            <SolidMarkdown
                renderingStrategy="reconcile"
                remarkPlugins={[remarkGfm]}
                components={{ text: TextNode }}
            >
                {prepared()}
            </SolidMarkdown>
        </div>
    );
}
