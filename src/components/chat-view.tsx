import {
    Show,
    createEffect,
    createSignal,
    on,
    onCleanup,
    onMount,
    type Component,
    type JSX,
} from 'solid-js';
import { useNavigate, useParams } from '@solidjs/router';
import { useStickToBottom } from '@/lib/stick-to-bottom';
import { saveDebugBlocks } from '@/lib/storage';
import { getSqliteDb } from '@/lib/sqlite/client';
import { ZERO_USAGE, type ChatUsage, type Message } from '@/lib/types';
import { formatTokens, formatUsd } from '@/lib/agent/cost';
import { MessageList } from './message-list';
import type { ConfirmationDecision } from './confirmations';
import { Composer } from './composer';
import { JumpToLatest } from './jump-to-latest';
import { DebugLogView } from './debug-log-view';
import { debugLog } from '@/lib/debug-log';
import { ActionPanel } from './action-panel';
import { ActionTopBar } from './action-top-bar';
import { Resizable, ResizableHandle, ResizablePanel } from '@/registry/ui/resizable';
import { ActionsSidebar } from './sidebar/actions-sidebar';
import { findModelEntry, runtime, useSession, useSettings } from '@/lib/runtime/client';
import { activeAction } from '@/lib/actions/action-live-store';
import { DataSourceSelector } from './data-source-selector';
import { TopBar } from './top-bar';

const SIDEBAR_COLLAPSED_KEY = 'sidebar:collapsed';
const CHAT_HIDDEN_KEY = 'chat:hidden';

// Confirmation rendererIds whose pending card is answered by typing in the
// main chat composer (not by clicking a button in the card). While one is
// open the agent loop is parked on its ticket; `handleSubmit` resolves it
// with the typed text rather than starting a new turn.
const CHAT_INPUT_RENDERERS = new Set(['user-question', 'analysis-review-feedback']);

function loadSidebarCollapsed(): boolean {
    try {
        return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
    } catch {
        return false;
    }
}

function saveSidebarCollapsed(v: boolean): void {
    try {
        if (v) localStorage.setItem(SIDEBAR_COLLAPSED_KEY, '1');
        else localStorage.removeItem(SIDEBAR_COLLAPSED_KEY);
    } catch {
        // ignore
    }
}

function loadChatHidden(): boolean {
    try {
        return localStorage.getItem(CHAT_HIDDEN_KEY) === '1';
    } catch {
        return false;
    }
}

function saveChatHidden(v: boolean): void {
    try {
        if (v) localStorage.setItem(CHAT_HIDDEN_KEY, '1');
        else localStorage.removeItem(CHAT_HIDDEN_KEY);
    } catch {
        // ignore
    }
}

const ChatView: Component = () => {
    const params = useParams<{ actionId?: string }>();
    const navigate = useNavigate();

    // Tab-local UI state.
    const [sidebarCollapsed, setSidebarCollapsed] = createSignal(loadSidebarCollapsed());
    const [chatHidden, setChatHidden] = createSignal(loadChatHidden());

    const [scrollEl, setScrollEl] = createSignal<HTMLDivElement | undefined>();
    const { stuck, scrollToBottom, kick } = useStickToBottom(scrollEl);

    // Reactive accessors over the runtime mirror.
    const session = () => useSession(params.actionId);
    const messages = (): Message[] => session()?.messages ?? [];
    const inflightId = (): string | null => session()?.inflightId ?? null;
    const error = (): string | null => session()?.error ?? null;
    const streaming = (): boolean => inflightId() !== null;
    const usage = (): ChatUsage => session()?.usage ?? ZERO_USAGE;
    const selectedPricing = () => findModelEntry(useSettings().defaultModelId).pricing;

    onMount(async () => {
        try {
            const db = await getSqliteDb();
            await db.seed();
        } catch (e) {
            console.warn('[chat-view] sqlite seed failed', e);
        }
    });

    onCleanup(() => {
        // Don't abort the background loop — it survives in the worker.
    });

    // URL → make sure the worker hydrates this action's draft so the
    // sidebar/panel can render it without the user submitting first.
    createEffect(
        on(
            () => params.actionId,
            (id) => {
                if (id) void runtime.setActiveAction(id);
                else void runtime.clearActiveAction();
            },
        ),
    );

    // When messages change, auto-scroll if we're stuck to bottom.
    createEffect(
        on(
            () => messages().length,
            () => {
                if (stuck()) requestAnimationFrame(() => kick());
            },
        ),
    );

    // End-of-turn — persist debug log. Chat persistence is the worker's
    // responsibility now.
    createEffect(
        on(
            () => inflightId(),
            (id) => {
                if (id !== null) return;
                debugLog.closeAllOpen();
                saveDebugBlocks(debugLog.blocks);
            },
        ),
    );

    const handleConfirmDecision = (toolCallId: string, decision: ConfirmationDecision) => {
        // Route through `decideConfirmation` so a thumbs-up/down on a reloaded
        // tab (where the parked loop's ticket is gone) still commits/rejects the
        // persisted candidate instead of no-opping. Live behavior is unchanged.
        if (params.actionId) {
            void runtime.decideConfirmation(params.actionId, toolCallId, decision);
        } else {
            void runtime.resolveTicket(toolCallId, decision);
        }
    };

    // Some confirmation cards are answered by typing in the main composer
    // rather than by clicking a button: `ask_user` (the "Other" path) and the
    // analysis-review thumbs-down follow-up that asks what to change. While one
    // is pending the agent loop is parked on its ticket, so we detect it here
    // and route a submission to it (see `handleSubmit`) instead of starting a
    // new turn. Returns the pending part's `{ ticketId, rendererId }` or
    // undefined when none is open.
    const pendingChatInput = (): { ticketId: string; rendererId: string } | undefined => {
        for (const m of messages()) {
            for (const p of m.parts ?? []) {
                if (
                    p.kind === 'confirmation' &&
                    p.approved === null &&
                    CHAT_INPUT_RENDERERS.has(p.rendererId)
                ) {
                    return { ticketId: p.toolCallId, rendererId: p.rendererId };
                }
            }
        }
        return undefined;
    };

    const composerPlaceholder = (): string | undefined => {
        const pending = pendingChatInput();
        if (!pending) return undefined;
        return pending.rendererId === 'analysis-review-feedback'
            ? 'Explain what to change, and I’ll revise the draft…'
            : 'Type your answer to the question above…';
    };

    const handleSubmit = async (text: string) => {
        // While a chat-answered confirmation is pending, the typed text is the
        // answer to it, not a new turn. On the tab running the loop this
        // resolves the live ticket and the parked agent resumes; after a reload
        // (or in a tab that never ran the loop) the ticket's Deferred is gone,
        // so this instead settles the card and restarts the turn from the
        // persisted chat log. See `host.answerPendingConfirmation`.
        const pending = pendingChatInput();
        if (pending && params.actionId) {
            await runtime.answerPendingConfirmation(
                params.actionId,
                pending.ticketId,
                text,
                useSettings().defaultModelId,
            );
            scrollToBottom();
            return;
        }
        if (streaming()) return;
        // For fresh chats, send along the user-picked source. The worker
        // writes it to the Action on first persist and ignores it after.
        const sourceForSubmit = params.actionId ? undefined : pickedSource();
        const result = await runtime.submit(
            params.actionId,
            text,
            useSettings().defaultModelId,
            sourceForSubmit,
        );
        if (!params.actionId) {
            navigate(`/chat/${result.actionId}`, { replace: true });
        }
        scrollToBottom();
    };

    // For new chats this drives `runtime.submit`; for existing chats the
    // source is read off the Action via activeAction() and the selector
    // is disabled (sealed to the action).
    const [pickedSource, setPickedSource] = createSignal<string | undefined>(undefined);
    const activeSourceId = (): string | undefined => {
        if (params.actionId) {
            return activeAction()?.action?.dataSourceId;
        }
        return pickedSource();
    };

    const handleStop = () => {
        if (params.actionId) void runtime.abort(params.actionId);
    };

    const handleNewAction = () => {
        debugLog.clear();
        if (params.actionId) navigate('/chat');
    };

    const handleToggleSidebar = () => {
        const next = !sidebarCollapsed();
        setSidebarCollapsed(next);
        saveSidebarCollapsed(next);
    };

    const handleToggleChatHidden = () => {
        const next = !chatHidden();
        setChatHidden(next);
        saveChatHidden(next);
    };

    const visibleMessages = () => messages().filter((m) => m.role !== 'system');

    const handleSyncToStep = (stepId: string) => {
        const root = scrollEl();
        if (!root) return;
        const target = root.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(stepId)}"]`);
        if (!target) return;
        root.dispatchEvent(new WheelEvent('wheel', { deltaY: -1 }));
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };

    return (
        <main class="h-svh flex flex-col bg-background text-foreground">
            <TopBar />

            <Show when={error()} fallback={null}>
                <div class="border-b bg-destructive/10 px-4 py-2 text-xs text-destructive">
                    {error()}
                </div>
            </Show>

            <div class="flex-1 min-h-0 flex flex-row">
                <ActionsSidebar
                    collapsed={sidebarCollapsed()}
                    onToggleCollapsed={handleToggleSidebar}
                    onNewAction={handleNewAction}
                />
                <div class="flex-1 min-w-0 min-h-0 flex flex-col">
                    <ActionTopBar
                        chatHidden={chatHidden()}
                        onToggleChatHidden={handleToggleChatHidden}
                    />
                    <div class="flex-1 min-w-0 min-h-0">
                        <PanelArea
                            chatHidden={chatHidden()}
                            debugEnabled={debugLog.enabled}
                            chat={
                                <ChatPane
                                    empty={visibleMessages().length === 0}
                                    messages={messages()}
                                    inflightId={inflightId()}
                                    setScrollRef={setScrollEl}
                                    onConfirmDecision={handleConfirmDecision}
                                    stuck={stuck}
                                    scrollToBottom={scrollToBottom}
                                    scrollEl={scrollEl}
                                    onSubmit={handleSubmit}
                                    onStop={handleStop}
                                    streaming={streaming()}
                                    awaitingAnswer={pendingChatInput() !== undefined}
                                    composerPlaceholder={composerPlaceholder()}
                                    usage={usage()}
                                    pricingKnown={selectedPricing() !== undefined}
                                    showSourcePicker={!params.actionId}
                                    sourceValue={activeSourceId()}
                                    onSourceChange={setPickedSource}
                                />
                            }
                            debug={
                                <DebugLogView
                                    onClose={() => debugLog.setEnabled(false)}
                                    onSyncToStep={handleSyncToStep}
                                />
                            }
                        />
                    </div>
                </div>
            </div>
        </main>
    );
};

type PanelAreaProps = {
    chatHidden: boolean;
    debugEnabled: boolean;
    chat: JSX.Element;
    debug: JSX.Element;
};

/**
 * Resizable arrangement of the chat, action, and debug panels under the
 * ActionTopBar. Each combination of (chatHidden, debugEnabled) is its
 * own layout — keeping them as discrete branches lets the `Resizable`
 * components remount cleanly so saved sizes don't fight new shapes.
 */
const PanelArea: Component<PanelAreaProps> = (props) => (
    <Show
        when={!props.chatHidden}
        fallback={
            <Show when={props.debugEnabled} fallback={<ActionPanel />}>
                <Resizable orientation="horizontal" class="h-full">
                    <ResizablePanel initialSize={0.6} minSize={0.3} class="overflow-hidden min-w-0">
                        <ActionPanel />
                    </ResizablePanel>
                    <ResizableHandle withHandle />
                    <ResizablePanel initialSize={0.4} minSize={0.2} class="overflow-hidden min-w-0">
                        {props.debug}
                    </ResizablePanel>
                </Resizable>
            </Show>
        }
    >
        <Show
            when={props.debugEnabled}
            fallback={
                <Resizable orientation="horizontal" class="h-full">
                    <ResizablePanel
                        initialSize={0.5}
                        minSize={0.25}
                        class="overflow-hidden min-w-0"
                    >
                        {props.chat}
                    </ResizablePanel>
                    <ResizableHandle withHandle />
                    <ResizablePanel
                        initialSize={0.5}
                        minSize={0.25}
                        class="overflow-hidden min-w-0"
                    >
                        <ActionPanel />
                    </ResizablePanel>
                </Resizable>
            }
        >
            <Resizable orientation="horizontal" class="h-full">
                <ResizablePanel initialSize={0.62} minSize={0.3} class="overflow-hidden min-w-0">
                    <Resizable orientation="horizontal" class="h-full">
                        <ResizablePanel
                            initialSize={0.5}
                            minSize={0.25}
                            class="overflow-hidden min-w-0"
                        >
                            {props.chat}
                        </ResizablePanel>
                        <ResizableHandle withHandle />
                        <ResizablePanel
                            initialSize={0.5}
                            minSize={0.25}
                            class="overflow-hidden min-w-0"
                        >
                            <ActionPanel />
                        </ResizablePanel>
                    </Resizable>
                </ResizablePanel>
                <ResizableHandle withHandle />
                <ResizablePanel initialSize={0.38} minSize={0.2} class="overflow-hidden min-w-0">
                    {props.debug}
                </ResizablePanel>
            </Resizable>
        </Show>
    </Show>
);

type ChatPaneProps = {
    empty: boolean;
    messages: Message[];
    inflightId: string | null;
    setScrollRef: (el: HTMLDivElement) => void;
    onConfirmDecision: (toolCallId: string, decision: ConfirmationDecision) => void;
    stuck: () => boolean;
    scrollToBottom: () => void;
    scrollEl: () => HTMLDivElement | undefined;
    onSubmit: (text: string) => void;
    onStop: () => void;
    streaming: boolean;
    /** A chat-answered confirmation (ask_user / analysis-review feedback) is
     * open; the composer answers it instead of starting a new turn, and shows
     * Send (not Stop) so the user can reply. */
    awaitingAnswer: boolean;
    /** Placeholder for the composer while awaiting a chat answer. */
    composerPlaceholder: string | undefined;
    usage: ChatUsage;
    pricingKnown: boolean;
    /** Only set on new chats; existing chats hide the picker entirely. */
    showSourcePicker: boolean;
    sourceValue: string | undefined;
    onSourceChange: (id: string | undefined) => void;
};

const ChatPane: Component<ChatPaneProps> = (props) => (
    <div class="relative flex h-full min-h-0 flex-col">
        <Show
            when={!props.empty}
            fallback={
                <div class="flex-1 flex items-center justify-center px-6 text-center">
                    <div class="max-w-md flex flex-col items-center gap-3">
                        <div class="size-12 rounded-full bg-primary text-primary-foreground grid place-items-center text-sm font-semibold">
                            Or
                        </div>
                        <h2 class="text-lg font-semibold">Start a conversation</h2>
                        <p class="text-sm text-muted-foreground">
                            Ask what data is available, or pose a business question. The assistant
                            will propose a plan, ask you to approve it, then explore the SQLite
                            database with bounded read-only samples.
                        </p>
                        <Show when={props.showSourcePicker}>
                            <div class="mt-2 w-full max-w-xs flex flex-col items-stretch gap-1.5 text-left">
                                <span class="text-xs font-medium text-foreground">Data source</span>
                                <DataSourceSelector
                                    value={props.sourceValue}
                                    onChange={props.onSourceChange}
                                    disabled={props.streaming}
                                    autoPickDefault
                                    triggerClass="w-full"
                                />
                            </div>
                        </Show>
                    </div>
                </div>
            }
        >
            <div class="relative flex-1 flex flex-col min-h-0">
                <CostChip usage={props.usage} pricingKnown={props.pricingKnown} />
                <MessageList
                    messages={props.messages}
                    inflightId={props.inflightId}
                    setScrollRef={props.setScrollRef}
                    onConfirmDecision={props.onConfirmDecision}
                />
                <JumpToLatest
                    visible={!props.stuck()}
                    onClick={props.scrollToBottom}
                    scrollTarget={props.scrollEl}
                />
            </div>
        </Show>
        <Composer
            onSubmit={props.onSubmit}
            onStop={props.onStop}
            streaming={props.streaming && !props.awaitingAnswer}
            disabled={false}
            disabledReason={undefined}
            placeholder={props.composerPlaceholder}
        />
    </div>
);

const CostChip: Component<{ usage: ChatUsage; pricingKnown: boolean }> = (props) => (
    <div class="pointer-events-none absolute left-1/2 top-2 z-10 -translate-x-1/2">
        <div class="pointer-events-auto rounded-full border bg-background/85 backdrop-blur px-2.5 py-0.5 text-[10px] text-muted-foreground tabular-nums shadow-sm flex items-center gap-1.5">
            <span aria-label="sent tokens">
                {'↑'}
                {formatTokens(props.usage.inputTokens)}
            </span>
            <span aria-label="received tokens">
                {'↓'}
                {formatTokens(props.usage.outputTokens)}
            </span>
            <span class="text-muted-foreground/60">·</span>
            <Show when={props.pricingKnown} fallback={<span>pricing unavailable</span>}>
                <span class="font-medium text-foreground/80">{formatUsd(props.usage.costUsd)}</span>
            </Show>
        </div>
    </div>
);

export default ChatView;
