import { Show, createMemo, createSignal, type Component } from 'solid-js';

type Props = {
    code: string;
    previewChars?: number;
    tone?: 'muted' | 'destructive';
};

export const CollapsibleCode: Component<Props> = (props) => {
    const previewLen = () => props.previewChars ?? 20;
    const oneLine = createMemo(() => (props.code ?? '').replace(/\s+/g, ' ').trim());
    const isLong = () => oneLine().length > previewLen();
    const [open, setOpen] = createSignal(false);
    const tone = () => props.tone ?? 'muted';

    const previewText = () => (isLong() ? `${oneLine().slice(0, previewLen())}…` : oneLine());

    return (
        <Show
            when={open() || !isLong()}
            fallback={
                <button
                    type="button"
                    onClick={() => setOpen(true)}
                    class={
                        'inline-flex max-w-full items-baseline gap-2 rounded text-left font-mono text-xs ' +
                        (tone() === 'destructive'
                            ? 'text-destructive hover:opacity-80'
                            : 'text-foreground/80 hover:text-foreground')
                    }
                >
                    <code class="truncate">{previewText()}</code>
                    <span class="text-[10px] uppercase tracking-wide text-muted-foreground shrink-0">
                        show
                    </span>
                </button>
            }
        >
            <div class="relative">
                <pre
                    class={
                        'rounded text-xs font-mono whitespace-pre-wrap break-words overflow-auto max-h-96 px-2 py-1.5 ' +
                        (tone() === 'destructive'
                            ? 'bg-destructive/10 text-destructive'
                            : 'bg-muted')
                    }
                >
                    {props.code}
                </pre>
                <Show when={isLong()}>
                    <button
                        type="button"
                        onClick={() => setOpen(false)}
                        class="absolute top-1 right-2 text-[10px] uppercase tracking-wide text-muted-foreground hover:text-foreground"
                    >
                        hide
                    </button>
                </Show>
            </div>
        </Show>
    );
};
