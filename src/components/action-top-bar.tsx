import { Show, type Component } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { Button } from '@/registry/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/registry/ui/tooltip';
import { EditableName } from './editable-name';
import { PaneHeader, PaneHeaderActions } from './pane-header';
import { ConfirmDialog } from './data-sources/confirm-dialog';
import { activeAction } from '@/lib/actions/action-live-store';
import { runtime } from '@/lib/runtime/client';
import { debugLog } from '@/lib/debug-log';
import { createSignal } from 'solid-js';

type Props = {
    chatHidden: boolean;
    onToggleChatHidden(): void;
};

/**
 * Top bar spanning the chat + action (+ optional debug) panels. Visually
 * connects with the actions sidebar header on the left — same height,
 * same border. Hosts identity (action id, renameable title) and the
 * panel-level commands that used to float over the chat.
 */
export const ActionTopBar: Component<Props> = (props) => {
    const navigate = useNavigate();
    const draft = () => activeAction();
    const actionId = () => draft()?.action?.id;
    const actionName = () => draft()?.actionName ?? '';
    const hasAction = () => !!draft()?.action;

    const [confirmDelete, setConfirmDelete] = createSignal(false);

    const handleRename = (next: string) => {
        const id = actionId();
        if (!id) return;
        void runtime.renameAction(id, next);
    };

    const handleDelete = async () => {
        const id = actionId();
        if (!id) return;
        try {
            await runtime.deleteAction(id);
        } catch (e) {
            console.warn('[action-top-bar] deleteAction failed', e);
        }
        navigate('/chat');
    };

    return (
        <PaneHeader>
            <Show
                when={hasAction()}
                fallback={
                    <span class="text-xs italic text-muted-foreground">No action selected</span>
                }
            >
                <EditableName
                    value={actionName()}
                    onSave={handleRename}
                    placeholder="Untitled action"
                    class="text-sm font-semibold truncate max-w-[28ch]"
                    inputClass="text-sm font-semibold bg-transparent border-b border-primary px-0.5 outline-none w-[28ch]"
                />
                <span
                    class="font-mono text-[10px] text-muted-foreground select-all"
                    title={actionId()}
                >
                    {shortId(actionId()!)}
                </span>
            </Show>

            <PaneHeaderActions>
                <Tooltip>
                    <TooltipTrigger
                        as={Button}
                        onClick={props.onToggleChatHidden}
                        variant={props.chatHidden ? 'default' : 'outline'}
                        size="icon-sm"
                        aria-label={props.chatHidden ? 'Show chat' : 'Hide chat'}
                    >
                        <ChatIcon hidden={props.chatHidden} />
                    </TooltipTrigger>
                    <TooltipContent>{props.chatHidden ? 'Show chat' : 'Hide chat'}</TooltipContent>
                </Tooltip>

                <Tooltip>
                    <TooltipTrigger
                        as={Button}
                        onClick={() => debugLog.toggleEnabled()}
                        variant={debugLog.enabled ? 'default' : 'outline'}
                        size="icon-sm"
                        aria-label={debugLog.enabled ? 'Hide chat debug' : 'Show chat debug'}
                    >
                        <DebugIcon />
                    </TooltipTrigger>
                    <TooltipContent>
                        {debugLog.enabled ? 'Hide chat debug' : 'Show chat debug'}
                    </TooltipContent>
                </Tooltip>

                <Show when={hasAction()}>
                    <Tooltip>
                        <TooltipTrigger
                            as={Button}
                            onClick={() => setConfirmDelete(true)}
                            variant="outline"
                            size="icon-sm"
                            class="text-destructive hover:text-destructive hover:bg-destructive/10"
                            aria-label="Delete action"
                        >
                            <TrashIcon />
                        </TooltipTrigger>
                        <TooltipContent>Delete action</TooltipContent>
                    </Tooltip>
                </Show>
            </PaneHeaderActions>

            <ConfirmDialog
                open={confirmDelete()}
                onOpenChange={(o) => !o && setConfirmDelete(false)}
                title={`Delete "${actionName() || 'this action'}"?`}
                description="The chat, versions, and execution history will be removed. This cannot be undone."
                confirmLabel="Delete action"
                onConfirm={handleDelete}
            />
        </PaneHeader>
    );
};

function shortId(id: string): string {
    return id.length > 8 ? id.slice(0, 8) : id;
}

const ChatIcon: Component<{ hidden: boolean }> = (props) => (
    <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="size-4"
        aria-hidden="true"
    >
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        <Show when={props.hidden}>
            <line x1="3" y1="3" x2="21" y2="21" />
        </Show>
    </svg>
);

const DebugIcon: Component = () => (
    <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="size-4"
        aria-hidden="true"
    >
        <polyline points="4 17 10 11 4 5" />
        <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
);

const TrashIcon: Component = () => (
    <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="size-4"
        aria-hidden="true"
    >
        <polyline points="3 6 5 6 21 6" />
        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
        <path d="M10 11v6" />
        <path d="M14 11v6" />
        <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
    </svg>
);
