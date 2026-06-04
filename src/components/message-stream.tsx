import {
    For,
    Match,
    Show,
    Switch,
    createEffect,
    createMemo,
    createSignal,
    type Component,
} from 'solid-js';
import type { Message, MessagePart, SubAgentRun } from '@/lib/types';
import { StreamedMarkdown } from './streamed-markdown';
import { ConfirmationDispatcher, type ConfirmationDecision } from './confirmations';
import { ToolCallCard } from './tool-call-card';
import { SavedQueryCard } from './saved-query-card';
import { SavedDataSourceCard } from './saved-data-source-card';
import { ActionResultLinkCard } from './action-result-link-card';
import { ActionFailedRow } from './action-failed-row';
import { ChevronIcon } from './chevron-icon';
import { Badge } from '@/registry/ui/badge';

/**
 * A sub-agent run whose model emitted prose without committing it as a
 * durable artifact (no tool call, no `result` summary) should not leak that
 * prose into the parent chat. The Coder can return done-with-no-finalResult,
 * and error/cancelled runs trivially shouldn't surface their last assistant
 * scribbles either. Tool-call parts (saved queries, saved data sources,
 * confirmations, action-result links, …) are durable user-visible artifacts
 * and still render — only assistant `text` parts and legacy `content` get
 * hidden.
 */
const shouldHideAssistantText = (run: SubAgentRun): boolean => {
    if (run.status === 'error' || run.status === 'cancelled') return true;
    if (run.status === 'done' && !run.result?.trim()) return true;
    return false;
};

/**
 * Whether to render the "<Agent> done"-style stub row at the end of a
 * sub-agent. The Coder produces its result in the side panel (as a
 * draft under review), so the stub would just be visual noise in the
 * chat rail. Errors / cancellations still render — those carry signal.
 */
const shouldRenderStub = (run: SubAgentRun): boolean => {
    if (run.agentId === 'coder' && run.status === 'done') return false;
    return true;
};

type Props = {
    messages: Message[];
    inflightId: string | null;
    onConfirmDecision?: (toolCallId: string, decision: ConfirmationDecision) => void;
};

/**
 * Chat is rendered as a single flat list of sibling rows. Sub-agents render
 * their messages at the same level, so every action shares one continuous
 * timeline rail. Components render directly from the reactive Message /
 * MessagePart proxies so DOM nodes stay stable across streaming updates —
 * do not flatten into a new array (Solid's <For> keys by reference, and a
 * fresh array on every store mutation would recreate every row).
 */
export const MessageStream: Component<Props> = (props) => {
    const visible = createMemo(() => props.messages.filter((m) => m.role !== 'system'));
    return (
        <For each={visible()}>
            {(msg, i) => {
                const isFirstOfTurn = () => {
                    if (msg.role === 'user') return false;
                    const idx = i();
                    if (idx === 0) return true;
                    return visible()[idx - 1]?.role === 'user';
                };
                return (
                    <MessageRows
                        msg={msg}
                        inflightId={props.inflightId}
                        isFirstOfTurn={isFirstOfTurn()}
                        onConfirmDecision={props.onConfirmDecision}
                    />
                );
            }}
        </For>
    );
};

const MessageRows: Component<{
    msg: Message;
    inflightId: string | null;
    hideAssistantText?: boolean;
    collapseAssistantText?: boolean;
    /**
     * True for the very first assistant message that follows a user bubble
     * (or that starts the chat). Used to render a labelled header dot so the
     * rail emerges from an anchored node instead of dangling. Only ever set
     * on top-level orchestrator messages — sub-agent runs never see it.
     */
    isFirstOfTurn?: boolean;
    onConfirmDecision?: (toolCallId: string, decision: ConfirmationDecision) => void;
}> = (props) => {
    return (
        <Switch>
            <Match when={props.msg.role === 'user'}>
                <UserRow msg={props.msg} />
            </Match>
            <Match when={props.msg.role !== 'user'}>
                <AssistantRows
                    msg={props.msg}
                    inflightId={props.inflightId}
                    hideAssistantText={props.hideAssistantText}
                    collapseAssistantText={props.collapseAssistantText}
                    isFirstOfTurn={props.isFirstOfTurn}
                    onConfirmDecision={props.onConfirmDecision}
                />
            </Match>
        </Switch>
    );
};

const UserRow: Component<{ msg: Message }> = (props) => (
    <div data-message-id={props.msg.id} class="sd-bubble-in flex w-full justify-end sd-row-user">
        <div class="rounded-2xl rounded-br-sm bg-primary text-primary-foreground px-4 py-2.5 text-sm max-w-[85%] sm:max-w-[75%] break-words">
            <StreamedMarkdown content={props.msg.content} streaming={false} />
        </div>
    </div>
);

const AssistantRows: Component<{
    msg: Message;
    inflightId: string | null;
    hideAssistantText?: boolean;
    collapseAssistantText?: boolean;
    isFirstOfTurn?: boolean;
    onConfirmDecision?: (toolCallId: string, decision: ConfirmationDecision) => void;
}> = (props) => {
    const isInflight = () => props.msg.id === props.inflightId;
    const parts = () => props.msg.parts ?? [];
    const hasParts = () => parts().length > 0;
    const isEmpty = () => {
        const ps = parts();
        if (ps.length === 0) return props.msg.content.length === 0;
        for (const p of ps) {
            if (p.kind === 'text' && p.text.length > 0) return false;
            if (p.kind !== 'text') return false;
        }
        return true;
    };
    return (
        <>
            <Show when={props.isFirstOfTurn}>
                <AnalyzeHeaderRow />
            </Show>
            <Show when={!hasParts() && props.msg.content.length > 0 && !props.hideAssistantText}>
                <Show
                    when={props.collapseAssistantText}
                    fallback={
                        <TextRow
                            text={props.msg.content}
                            streaming={isInflight()}
                            msgId={props.msg.id}
                        />
                    }
                >
                    <CollapsibleProseRow
                        text={props.msg.content}
                        streaming={isInflight()}
                        label="Reasoning"
                        isThinking={true}
                    />
                </Show>
            </Show>
            <For each={parts()}>
                {(part, i) => (
                    <PartRow
                        part={part}
                        msgId={props.msg.id}
                        isLastPart={() => i() === parts().length - 1}
                        isInflight={isInflight}
                        hideAssistantText={props.hideAssistantText}
                        collapseAssistantText={props.collapseAssistantText}
                        onConfirmDecision={props.onConfirmDecision}
                    />
                )}
            </For>
            <Show when={isInflight() && isEmpty()}>
                <ThinkingRow />
            </Show>
            <Show when={props.msg.aborted}>
                <AbortedRow />
            </Show>
        </>
    );
};

const PartRow: Component<{
    part: MessagePart;
    msgId: string;
    isLastPart: () => boolean;
    isInflight: () => boolean;
    hideAssistantText?: boolean;
    collapseAssistantText?: boolean;
    onConfirmDecision?: (toolCallId: string, decision: ConfirmationDecision) => void;
}> = (props) => {
    const streaming = () => props.isInflight() && props.isLastPart();
    return (
        <Switch>
            <Match
                when={
                    props.part.kind === 'text'
                        ? (props.part as Extract<MessagePart, { kind: 'text' }>)
                        : null
                }
            >
                {(p) => (
                    <Show when={p().text.length > 0 && !props.hideAssistantText}>
                        <Show
                            when={props.collapseAssistantText}
                            fallback={
                                <TextRow
                                    text={p().text}
                                    streaming={streaming()}
                                    msgId={props.msgId}
                                />
                            }
                        >
                            <CollapsibleProseRow
                                text={p().text}
                                streaming={streaming()}
                                label="Reasoning"
                                isThinking={true}
                            />
                        </Show>
                    </Show>
                )}
            </Match>
            <Match
                when={
                    props.part.kind === 'reasoning'
                        ? (props.part as Extract<MessagePart, { kind: 'reasoning' }>)
                        : null
                }
            >
                {(p) => (
                    <Show when={p().text.length > 0}>
                        <CollapsibleProseRow
                            text={p().text}
                            streaming={streaming()}
                            label="Reasoning"
                            isThinking={true}
                        />
                    </Show>
                )}
            </Match>
            <Match
                when={
                    props.part.kind === 'user-note'
                        ? (props.part as Extract<MessagePart, { kind: 'user-note' }>)
                        : null
                }
            >
                {(p) => (
                    <div class="sd-bubble-in flex w-full justify-end sd-row-user">
                        <div class="rounded-2xl rounded-br-sm bg-primary text-primary-foreground px-4 py-2.5 text-sm max-w-[85%] sm:max-w-[75%] break-words">
                            <StreamedMarkdown content={p().text} streaming={false} />
                        </div>
                    </div>
                )}
            </Match>
            <Match
                when={
                    props.part.kind === 'sub-agent'
                        ? (props.part as Extract<MessagePart, { kind: 'sub-agent' }>)
                        : null
                }
            >
                {(p) => <SubAgentRows run={p().run} onConfirmDecision={props.onConfirmDecision} />}
            </Match>
            <Match
                when={
                    props.part.kind === 'confirmation'
                        ? (props.part as Extract<MessagePart, { kind: 'confirmation' }>)
                        : null
                }
            >
                {(p) => (
                    <div class="sd-rail-row sd-rail-dot">
                        <ConfirmationDispatcher
                            part={p()}
                            onDecide={(id, decision) => props.onConfirmDecision?.(id, decision)}
                        />
                    </div>
                )}
            </Match>
            <Match
                when={
                    props.part.kind === 'tool-call'
                        ? (props.part as Extract<MessagePart, { kind: 'tool-call' }>)
                        : null
                }
            >
                {(p) => (
                    <div class="sd-rail-row sd-rail-dot">
                        <ToolCallCard part={p()} />
                    </div>
                )}
            </Match>
            <Match
                when={
                    props.part.kind === 'saved-query'
                        ? (props.part as Extract<MessagePart, { kind: 'saved-query' }>)
                        : null
                }
            >
                {(p) => (
                    <div class="sd-rail-row sd-rail-dot">
                        <SavedQueryCard part={p()} />
                    </div>
                )}
            </Match>
            <Match
                when={
                    props.part.kind === 'saved-data-source'
                        ? (props.part as Extract<MessagePart, { kind: 'saved-data-source' }>)
                        : null
                }
            >
                {(p) => (
                    <div class="sd-rail-row sd-rail-dot">
                        <SavedDataSourceCard part={p()} />
                    </div>
                )}
            </Match>
            <Match
                when={
                    props.part.kind === 'action-result-link'
                        ? (props.part as Extract<MessagePart, { kind: 'action-result-link' }>)
                        : null
                }
            >
                {(p) => (
                    <div class="sd-rail-row sd-rail-dot">
                        <ActionResultLinkCard part={p()} />
                    </div>
                )}
            </Match>
            <Match
                when={
                    props.part.kind === 'action-failed'
                        ? (props.part as Extract<MessagePart, { kind: 'action-failed' }>)
                        : null
                }
            >
                {(p) => (
                    <div class="sd-rail-row sd-rail-dot">
                        <ActionFailedRow part={p()} />
                    </div>
                )}
            </Match>
        </Switch>
    );
};

const SubAgentRows: Component<{
    run: SubAgentRun;
    onConfirmDecision?: (toolCallId: string, decision: ConfirmationDecision) => void;
}> = (props) => {
    const visible = createMemo(() => props.run.messages.filter((m) => m.role !== 'system'));
    const hideAssistantText = createMemo(() => shouldHideAssistantText(props.run));
    return (
        <>
            <For each={visible()}>
                {(msg) => (
                    <MessageRows
                        msg={msg}
                        inflightId={props.run.inflightId}
                        hideAssistantText={hideAssistantText()}
                        collapseAssistantText={true}
                        onConfirmDecision={props.onConfirmDecision}
                    />
                )}
            </For>
            <Show when={hideAssistantText() && shouldRenderStub(props.run)}>
                <SubAgentStubRow run={props.run} />
            </Show>
            <Show when={!hideAssistantText() && props.run.error}>
                <div class="sd-rail-row text-xs text-destructive font-mono whitespace-pre-wrap">
                    {props.run.error}
                </div>
            </Show>
        </>
    );
};

/**
 * Compact one-line summary shown in place of assistant prose when a sub-agent
 * run was abandoned, errored, or completed without a meaningful result. Tool
 * call cards rendered above this stub remain visible.
 */
const SubAgentStubRow: Component<{ run: SubAgentRun }> = (props) => {
    const variant = (): 'destructive' | 'secondary' | 'outline' => {
        if (props.run.status === 'error') return 'destructive';
        if (props.run.status === 'cancelled') return 'secondary';
        return 'outline';
    };
    const errorLine = () => {
        const raw = props.run.error?.trim();
        if (!raw) return '';
        const firstLine = raw.split(/\r?\n/, 1)[0] ?? '';
        return firstLine.length > 160 ? `${firstLine.slice(0, 160)}…` : firstLine;
    };
    return (
        <div class="sd-rail-row sd-rail-dot">
            <div class="flex items-center gap-2 text-xs text-muted-foreground">
                <span class="font-medium">{props.run.agentName}</span>
                <Badge variant={variant()} class="font-mono text-[10px] px-1.5 py-0">
                    {props.run.status}
                </Badge>
                <Show when={errorLine()}>
                    <span class="truncate font-mono text-destructive" title={props.run.error}>
                        {errorLine()}
                    </span>
                </Show>
            </div>
        </div>
    );
};

const TextRow: Component<{
    text: string;
    streaming: boolean;
    msgId?: string;
}> = (props) => (
    <div class="sd-rail-row text-sm" data-message-id={props.msgId}>
        <StreamedMarkdown content={props.text} streaming={props.streaming} />
    </div>
);

/**
 * Anchor dot rendered at the very top of an assistant turn. The orchestrator's
 * first step typically emits a Reasoning part before any tool call, so without
 * this header the rail would emerge from inside that Reasoning row with no
 * visible dot. This row gives the rail a labelled starting node, matching the
 * dotted pattern used by tool-call rows further down.
 */
const AnalyzeHeaderRow: Component = () => (
    <div class="sd-rail-row sd-rail-dot">
        <div class="text-sm text-muted-foreground">Analyze user request</div>
    </div>
);

/**
 * Collapsible prose row used for two cases that look the same to the user:
 *   1. Real reasoning tokens (`kind: 'reasoning'`) — separated by the
 *      OpenRouter provider from `delta.reasoning` / `reasoning_details`.
 *   2. Sub-agent assistant prose. Coder/Planner outputs are the artifact
 *      (tool calls, saved data sources). Any free-form text the model
 *      emits alongside is noise from the user's POV — collapse it.
 * Closed by default. Auto-opens while streaming so the user can see
 * progress, then collapses again once the stream is done.
 */
const CollapsibleProseRow: Component<{
    text: string;
    streaming: boolean;
    label: string;
    isThinking?: boolean;
}> = (props) => {
    // Auto-open while streaming so the user can watch progress, then collapse
    // again once the stream completes. After streaming ends the user can
    // toggle freely via the button.
    const [open, setOpen] = createSignal(false);
    createEffect(() => {
        setOpen(props.streaming);
    });
    let bodyRef: HTMLDivElement | undefined;
    // Pin scroll to bottom as content streams in, so the user always sees the
    // latest line. Re-running on `props.text` triggers once per chunk.
    createEffect(() => {
        // Read props.text to subscribe; value itself is unused.
        void props.text;
        if (!bodyRef) return;
        bodyRef.scrollTop = bodyRef.scrollHeight;
    });
    return (
        <div class="sd-rail-row">
            <button
                type="button"
                class="flex w-full items-center gap-1 text-left text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setOpen((v) => !v)}
            >
                <span>{props.label}</span>
                <ChevronIcon direction={open() ? 'down' : 'right'} class="ml-auto" />
            </button>
            <Show when={open()}>
                <div class="relative mt-0">
                    <div ref={bodyRef} class="max-h-[14rem] overflow-y-auto opacity-80 text-xs">
                        <StreamedMarkdown
                            isThinking={props.isThinking}
                            content={props.text}
                            streaming={props.streaming}
                        />
                    </div>
                    <div class="pointer-events-none absolute inset-x-0 top-0 h-[1.8em] bg-gradient-to-b from-background to-transparent" />
                </div>
            </Show>
        </div>
    );
};

const ThinkingRow: Component = () => (
    <div class="sd-rail-row">
        <div class="flex items-end gap-1 text-muted-foreground">
            <span class="size-1.5 rounded-full bg-current sd-dot" />
            <span class="size-1.5 rounded-full bg-current sd-dot sd-dot-2" />
            <span class="size-1.5 rounded-full bg-current sd-dot sd-dot-3" />
        </div>
    </div>
);

const AbortedRow: Component = () => (
    <div class="sd-rail-row text-xs opacity-60 italic">(stopped)</div>
);
