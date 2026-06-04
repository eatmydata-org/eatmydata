import {
    For,
    Show,
    createMemo,
    createSignal,
    type Component,
} from 'solid-js';
import { debugLog, PREVIEW_CHARS, type DebugBlock } from '@/lib/debug-log';
import { useStickToBottom } from '@/lib/stick-to-bottom';
import { Button } from '@/registry/ui/button';

type Props = {
    onClose: () => void;
    /** Used by the per-block sync button to scroll the main chat. */
    onSyncToStep: (stepId: string) => void;
};

export const DebugLogView: Component<Props> = (props) => {
    const [scrollEl, setScrollEl] = createSignal<HTMLDivElement | undefined>();
    const { stuck, scrollToBottom } = useStickToBottom(scrollEl);

    const blocks = () => debugLog.blocks;
    const anyStreaming = createMemo(() => blocks().some((b) => !b.done));

    const allExpanded = createMemo(() => {
        const list = blocks();
        return list.length > 0 && list.every((b) => b.expanded);
    });

    return (
        <div class="h-full flex flex-col bg-black text-zinc-200 border-l border-zinc-800">
            <header class="border-b border-zinc-800 px-3 py-2 flex items-center gap-2 text-xs flex-none">
                <span class="font-semibold tracking-wide text-zinc-100">
                    Chat debug
                </span>
                <span class="text-zinc-500">
                    {blocks().length} block{blocks().length === 1 ? '' : 's'}
                </span>
                <Show when={anyStreaming()}>
                    <span class="inline-flex items-center gap-1 text-emerald-400">
                        <span class="size-1.5 rounded-full bg-emerald-400 animate-pulse" />
                        streaming
                    </span>
                </Show>
                <div class="ml-auto flex items-center gap-1">
                    <button
                        type="button"
                        class="px-2 py-1 rounded text-[11px] text-zinc-300 hover:bg-zinc-800"
                        onClick={() =>
                            allExpanded()
                                ? debugLog.collapseAll()
                                : debugLog.expandAll()
                        }
                    >
                        {allExpanded() ? 'Collapse all' : 'Expand all'}
                    </button>
                    <button
                        type="button"
                        class="px-2 py-1 rounded text-[11px] text-zinc-300 hover:bg-zinc-800"
                        onClick={() => debugLog.clear()}
                    >
                        Clear
                    </button>
                    <button
                        type="button"
                        class="px-2 py-1 rounded text-[11px] text-zinc-300 hover:bg-zinc-800"
                        onClick={props.onClose}
                        aria-label="Close debug pane"
                    >
                        ✕
                    </button>
                </div>
            </header>

            <div
                ref={setScrollEl}
                class="flex-1 overflow-y-auto overscroll-contain"
            >
                <div class="flex flex-col gap-2 px-3 py-3">
                    <Show
                        when={blocks().length > 0}
                        fallback={
                            <div class="text-zinc-500 text-xs italic px-1 py-8">
                                No traffic yet. Send a chat message — requests
                                and responses will appear here as they stream.
                            </div>
                        }
                    >
                        <For each={blocks()}>
                            {(block, idx) => (
                                <BlockCard
                                    block={block}
                                    streaming={
                                        !block.done &&
                                        idx() === blocks().length - 1
                                    }
                                    onSync={() =>
                                        props.onSyncToStep(block.stepId)
                                    }
                                />
                            )}
                        </For>
                    </Show>
                </div>
            </div>

            <Show when={!stuck() && blocks().length > 0}>
                <div class="flex-none border-t border-zinc-800 px-3 py-1.5 flex justify-center">
                    <Button
                        size="sm"
                        variant="secondary"
                        class="bg-zinc-800 text-zinc-100 hover:bg-zinc-700 h-7 text-[11px]"
                        onClick={scrollToBottom}
                    >
                        Jump to latest ↓
                    </Button>
                </div>
            </Show>
        </div>
    );
};

const BlockCard: Component<{
    block: DebugBlock;
    streaming: boolean;
    onSync: () => void;
}> = (props) => {
    const kind = () => props.block.kind;
    const length = () => props.block.text.length;
    const overflow = () => length() > PREVIEW_CHARS;
    const showFull = () => props.block.expanded || !overflow();
    const visibleText = () =>
        showFull()
            ? props.block.text
            : props.block.text.slice(0, PREVIEW_CHARS);

    const headerClass = () => {
        switch (kind()) {
            case 'request':
                return 'bg-sky-950/60 text-sky-300 border-b border-sky-900/60';
            case 'response':
                return 'bg-emerald-950/60 text-emerald-300 border-b border-emerald-900/60';
            case 'system':
                return 'bg-amber-950/60 text-amber-300 border-b border-amber-900/60';
        }
    };
    const headerLabel = () => {
        switch (kind()) {
            case 'request':
                return '→ Request';
            case 'response':
                return '← Response';
            case 'system':
                return `⚙ ${props.block.label ?? 'System'}`;
        }
    };

    return (
        <div
            class="rounded border border-zinc-800 bg-zinc-950 overflow-hidden"
            // Skip layout/paint for off-screen blocks. Tells the browser the
            // intrinsic size to reserve so scrollbars don't jump while
            // off-screen blocks remain unrendered.
            style={{
                'content-visibility': 'auto',
                'contain-intrinsic-size': '200px 600px',
            }}
        >
            <div
                class={
                    'flex items-center gap-2 px-2 py-1 text-[10px] uppercase tracking-wider font-semibold ' +
                    headerClass()
                }
            >
                <span>{headerLabel()}</span>
                <span class="text-zinc-500 normal-case font-normal tracking-normal">
                    {length().toLocaleString()} chars
                </span>
                <Show when={props.streaming}>
                    <span class="text-zinc-400 normal-case font-normal tracking-normal">
                        …streaming
                    </span>
                </Show>
                <div class="ml-auto flex items-center gap-1 normal-case font-normal tracking-normal">
                    <button
                        type="button"
                        class="px-1.5 py-0.5 rounded text-[10px] text-zinc-300 hover:bg-zinc-800"
                        onClick={props.onSync}
                        title="Scroll main chat to the corresponding message"
                    >
                        ⇆ Sync
                    </button>
                    <Show when={overflow()}>
                        <button
                            type="button"
                            class="px-1.5 py-0.5 rounded text-[10px] text-zinc-300 hover:bg-zinc-800"
                            onClick={() =>
                                debugLog.setExpanded(
                                    props.block.id,
                                    !props.block.expanded,
                                )
                            }
                        >
                            {props.block.expanded
                                ? 'Collapse'
                                : `Expand (+${(length() - PREVIEW_CHARS).toLocaleString()})`}
                        </button>
                    </Show>
                </div>
            </div>
            <pre
                class={
                    'm-0 px-2 py-1.5 text-[12px] leading-[1.45] font-mono ' +
                    'whitespace-pre-wrap break-words overflow-wrap-anywhere ' +
                    'text-zinc-200'
                }
                style={{
                    'tab-size': '4',
                    'overflow-wrap': 'anywhere',
                }}
            >
                {visibleText()}
                <Show when={!showFull()}>
                    <span class="text-zinc-500">… </span>
                    <button
                        type="button"
                        class="text-sky-400 hover:underline text-[11px]"
                        onClick={() =>
                            debugLog.setExpanded(props.block.id, true)
                        }
                    >
                        show {(length() - PREVIEW_CHARS).toLocaleString()} more
                    </button>
                </Show>
            </pre>
        </div>
    );
};
