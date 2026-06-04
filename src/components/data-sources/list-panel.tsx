import {
    For,
    Show,
    createEffect,
    createSignal,
    onCleanup,
    onMount,
    type Component,
} from 'solid-js';
import type { DataSource } from '@/lib/data-sources/types';
import { Badge } from '@/registry/ui/badge';
import { Button } from '@/registry/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/registry/ui/tooltip';
import { formatAgo } from '@/lib/format-time';
import { PaneHeader, PaneHeaderTitle } from '@/components/pane-header';

type Props = {
    sources: DataSource[];
    selectedId?: string;
    onSelect(id: string): void;
    onCreateImported(): void;
    onCreateDemo(): void;
    onSetDefault(id: string): void;
    /** Dev-only — wired by the route under `import.meta.env.DEV`. */
    onDeleteEverything?(): void;
};

export const SourcesListPanel: Component<Props> = (props) => (
    <aside class="h-full border-r bg-card/30 flex flex-col overflow-hidden">
        <PaneHeader class="px-2">
            <PaneHeaderTitle class="pl-1">Sources</PaneHeaderTitle>
            <span class="text-xs tabular-nums text-muted-foreground/80">
                {props.sources.length}
            </span>
        </PaneHeader>
        <div class="flex-1 min-h-0 overflow-y-auto">
            <Show
                when={props.sources.length > 0}
                fallback={
                    <p class="px-3 py-6 text-xs text-muted-foreground italic">
                        No data sources yet. Import a file or use demo data.
                    </p>
                }
            >
                <ul class="flex flex-col gap-1 px-2 py-2">
                    <For each={props.sources}>
                        {(s) => (
                            <li>
                                <SourceRow
                                    source={s}
                                    selected={props.selectedId === s.id}
                                    onSelect={() => props.onSelect(s.id)}
                                    onSetDefault={() => props.onSetDefault(s.id)}
                                />
                            </li>
                        )}
                    </For>
                </ul>
            </Show>
        </div>
        <div class="border-t p-2 flex flex-col gap-1 flex-none">
            <Button size="sm" variant="default" onClick={props.onCreateImported}>
                + Import file…
            </Button>
            <Button size="sm" variant="ghost" onClick={props.onCreateDemo}>
                + Demo data…
            </Button>
            <Show when={props.onDeleteEverything}>
                <Button
                    size="sm"
                    variant="ghost"
                    class="text-destructive hover:text-destructive hover:bg-destructive/10 mt-1"
                    onClick={props.onDeleteEverything}
                    title="Dev only — delete every data source, table, action, and execution."
                >
                    Delete everything (dev)
                </Button>
            </Show>
        </div>
    </aside>
);

const SourceRow: Component<{
    source: DataSource;
    selected: boolean;
    onSelect(): void;
    onSetDefault(): void;
}> = (props) => {
    const persistenceBadge = () => {
        switch (props.source.persistence) {
            case 'memory':
                return 'mem';
            case 'temp':
                return 'tmp';
            case 'persistent':
                return 'disk';
        }
    };
    return (
        <div
            class={
                'rounded-md border text-sm transition-colors px-2 py-2 cursor-pointer ' +
                (props.selected
                    ? 'bg-primary/5 border-primary/40'
                    : 'bg-card border-border hover:bg-muted/40')
            }
            onClick={props.onSelect}
        >
            <div class="flex items-center gap-1.5">
                <button
                    type="button"
                    class={
                        'shrink-0 size-4 leading-none ' +
                        (props.source.isDefault
                            ? 'text-blue-500'
                            : 'text-muted-foreground/50 hover:text-blue-500')
                    }
                    title={
                        props.source.isDefault
                            ? 'Default for new chats'
                            : 'Make default for new chats'
                    }
                    aria-label="Toggle default"
                    onClick={(e) => {
                        e.stopPropagation();
                        props.onSetDefault();
                    }}
                >
                    {props.source.isDefault ? '★' : '☆'}
                </button>
                <TruncatableText text={props.source.name} class="font-semibold flex-1 min-w-0" />
                <Badge variant="outline" class="font-mono text-[9px] px-1 py-0">
                    {persistenceBadge()}
                </Badge>
                <Show when={props.source.kind === 'demo'}>
                    <Badge variant="secondary" class="font-mono text-[9px] px-1 py-0">
                        demo
                    </Badge>
                </Show>
            </div>
            <div class="text-[10px] text-muted-foreground/80 mt-0.5">
                Created {formatAgo(props.source.createdAt)}
            </div>
        </div>
    );
};

/**
 * Span that truncates with ellipsis and shows a shadcn Tooltip with the full
 * text only when the rendered content actually overflows. The Tooltip is
 * always mounted; we gate it via `disabled` so the trigger DOM never moves
 * (which would otherwise invalidate our ResizeObserver target). Re-measured
 * on resize so the panel splitter updates the tooltip state without remounts.
 */
const TruncatableText: Component<{
    text: string;
    class?: string;
}> = (props) => {
    const [truncated, setTruncated] = createSignal(false);
    let ref: HTMLSpanElement | undefined;

    const measure = () => {
        if (!ref) return;
        setTruncated(ref.scrollWidth > ref.clientWidth + 1);
    };

    onMount(() => {
        measure();
        if (!ref || typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(measure);
        ro.observe(ref);
        onCleanup(() => ro.disconnect());
    });

    createEffect(() => {
        // Re-measure when the text itself changes.
        props.text;
        queueMicrotask(measure);
    });

    return (
        <Tooltip disabled={!truncated()}>
            <TooltipTrigger as="span" class={'truncate block ' + (props.class ?? '')} ref={ref}>
                {props.text}
            </TooltipTrigger>
            <TooltipContent>{props.text}</TooltipContent>
        </Tooltip>
    );
};
