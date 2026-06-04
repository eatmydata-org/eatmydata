import {
    For,
    Show,
    createEffect,
    createMemo,
    createResource,
    createSignal,
    on,
    onCleanup,
    onMount,
    type Component,
} from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { Button } from '@/registry/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/registry/ui/tooltip';
import { listRecentActions } from '@/lib/actions/store';
import { activeAction } from '@/lib/actions/action-live-store';
import type { Action } from '@/lib/actions/types';
import { formatAgo } from '@/lib/format-time';
import { PaneHeader, PaneHeaderTitle } from '@/components/pane-header';

type Props = {
    collapsed: boolean;
    onToggleCollapsed(): void;
    onNewAction(): void;
};

export const ActionsSidebar: Component<Props> = (props) => {
    const navigate = useNavigate();
    const [refreshTick, setRefreshTick] = createSignal(0);

    const [actions] = createResource<Action[], number>(refreshTick, async () => {
        try {
            return await listRecentActions(50);
        } catch (e) {
            console.warn('[sidebar] listRecentActions failed', e);
            return [];
        }
    });

    createEffect(
        on(
            () => activeAction()?.action?.updatedAt,
            (ts) => {
                if (ts !== undefined) setRefreshTick((t) => t + 1);
            },
            { defer: true },
        ),
    );

    // Overlay the active draft's live name onto the cached list. A brand-new
    // action only lands in IDB as a `'New Action'` stub (persistChat) and is
    // renamed in-place there on the in-memory draft when `work_on_action`
    // first fires — IDB (and thus this list) doesn't see the real name until
    // the user approves. Without this overlay the entry sits under "New
    // action" in Recents for the whole planner→coder→review cycle. The draft
    // is reactive, so the rename shows up the moment the tool names it.
    const recents = createMemo<Action[]>(() => {
        const list = actions() ?? [];
        const draft = activeAction();
        const name = draft?.actionName?.trim();
        if (!draft || !name) return list;
        const existing = list.find((a) => a.id === draft.id);
        if (existing) {
            if (existing.name === name) return list;
            return list.map((a) => (a.id === draft.id ? { ...a, name } : a));
        }
        // Draft carries a persisted Action shell the cached list predates —
        // prepend it so the live action is visible right away.
        if (draft.action) return [{ ...draft.action, name }, ...list];
        return list;
    });

    onMount(() => {
        const onFocus = () => setRefreshTick((t) => t + 1);
        window.addEventListener('focus', onFocus);
        onCleanup(() => window.removeEventListener('focus', onFocus));
    });

    const handleSelect = (id: string) => {
        navigate(`/chat/${id}`);
    };

    return (
        <aside
            class={
                'h-full flex flex-col border-r bg-card overflow-hidden flex-none transition-[width] duration-150 ' +
                (props.collapsed ? 'w-14' : 'w-64')
            }
        >
            <Header collapsed={props.collapsed} onToggle={props.onToggleCollapsed} />
            <NewActionRow collapsed={props.collapsed} onClick={props.onNewAction} />
            <Show when={!props.collapsed}>
                <div class="px-3 pt-3 pb-1 text-[10px] uppercase tracking-wider font-semibold text-muted-foreground flex-none">
                    Recents
                </div>
                <RecentsList
                    actions={recents()}
                    // Only the very first load shows the skeleton. On refetch
                    // (window focus, end-of-turn) `actions()` keeps the previous
                    // list, so gating on `loading` alone would flash "Loading…"
                    // over good data — a flicker on every refresh.
                    loading={actions.loading && actions() === undefined}
                    activeId={activeAction()?.id}
                    onSelect={handleSelect}
                />
            </Show>
        </aside>
    );
};

const Header: Component<{ collapsed: boolean; onToggle(): void }> = (props) => (
    <PaneHeader class={props.collapsed ? 'px-2 justify-center' : 'px-2 justify-between'}>
        <Show when={!props.collapsed}>
            <PaneHeaderTitle class="pl-1">Actions</PaneHeaderTitle>
        </Show>
        <Tooltip>
            <TooltipTrigger
                as={Button}
                variant="ghost"
                size="icon-sm"
                onClick={props.onToggle}
                aria-label={props.collapsed ? 'Open sidebar' : 'Close sidebar'}
            >
                <SidebarToggleIcon open={!props.collapsed} />
            </TooltipTrigger>
            <TooltipContent>{props.collapsed ? 'Open sidebar' : 'Close sidebar'}</TooltipContent>
        </Tooltip>
    </PaneHeader>
);

const NewActionRow: Component<{
    collapsed: boolean;
    onClick(): void;
}> = (props) => (
    <Show
        when={!props.collapsed}
        fallback={
            <div class="flex justify-center py-2 flex-none">
                <Tooltip>
                    <TooltipTrigger
                        as={Button}
                        variant="ghost"
                        size="icon-sm"
                        onClick={props.onClick}
                        aria-label="New action"
                    >
                        <EditIcon />
                    </TooltipTrigger>
                    <TooltipContent>New action</TooltipContent>
                </Tooltip>
            </div>
        }
    >
        <div class="px-2 py-2 flex-none">
            <Button
                variant="secondary"
                size="sm"
                onClick={props.onClick}
                class="w-full justify-start gap-2"
            >
                <EditIcon />
                <span>New action</span>
            </Button>
        </div>
    </Show>
);

type RecentsListProps = {
    actions: Action[];
    loading: boolean;
    activeId: string | undefined;
    onSelect(id: string): void;
};

const RecentsList: Component<RecentsListProps> = (props) => (
    <div class="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
        <Show
            when={!props.loading}
            fallback={
                <div class="px-4 py-6 text-center text-xs text-muted-foreground italic">
                    Loading…
                </div>
            }
        >
            <Show
                when={props.actions.length > 0}
                fallback={
                    <div class="px-4 py-6 text-center text-xs text-muted-foreground italic">
                        No actions yet.
                    </div>
                }
            >
                <ul class="flex flex-col gap-0.5 px-2 pb-2">
                    <For each={props.actions}>
                        {(a) => (
                            <li>
                                <button
                                    type="button"
                                    onClick={() => props.onSelect(a.id)}
                                    class={
                                        'w-full text-left rounded-md px-2 py-1.5 text-sm overflow-hidden transition-colors ' +
                                        (props.activeId === a.id
                                            ? 'bg-primary/10 text-foreground'
                                            : 'hover:bg-muted text-foreground/90')
                                    }
                                >
                                    <span class="truncate block">{a.name || 'New action'}</span>
                                    <span
                                        class="text-[10px] text-muted-foreground tabular-nums block leading-tight"
                                        title={new Date(a.updatedAt).toLocaleString()}
                                    >
                                        {formatAgo(a.updatedAt)}
                                    </span>
                                </button>
                            </li>
                        )}
                    </For>
                </ul>
            </Show>
        </Show>
    </div>
);

const SidebarToggleIcon: Component<{ open: boolean }> = (props) => (
    <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="size-4"
    >
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <line x1="9" y1="4" x2="9" y2="20" />
        <Show when={props.open} fallback={<polyline points="14 9 17 12 14 15" />}>
            <polyline points="17 9 14 12 17 15" />
        </Show>
    </svg>
);

const EditIcon: Component = () => (
    <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="size-4"
    >
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.121 2.121 0 113 3L7 19l-4 1 1-4 12.5-12.5z" />
    </svg>
);
