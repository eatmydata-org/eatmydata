import { For, Show, type Component, type JSX } from 'solid-js';
import { A, useLocation } from '@solidjs/router';
import { Button } from '@/registry/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/registry/ui/dropdown-menu';
import ModeToggle from '@/registry/examples/mode-toggle';
import { useSettings } from '@/lib/runtime/client';
import { Brand } from './brand';

interface PowerTool {
    id: 'qjs' | 'sql' | 'pii';
    href: string;
    label: string;
}

export const TopBar = () => {
    const location = useLocation();
    const settings = useSettings();

    const path = () => location.pathname;
    const isActionsActive = () => path() === '/chat' || path().startsWith('/chat/');
    const isDataSourcesActive = () => path().startsWith('/data-sources');

    const powerTools = (): PowerTool[] => {
        const all: PowerTool[] = [
            { id: 'qjs', href: '/qjs', label: 'QJS' },
            { id: 'sql', href: '/sql', label: 'SQL' },
            { id: 'pii', href: '/pii', label: 'PII' },
        ];
        return all.filter((t) => {
            if (t.id === 'qjs') return settings.showQjsTester;
            if (t.id === 'sql') return settings.showSqlConsole;
            if (t.id === 'pii') return settings.showPiiTester;
            return false;
        });
    };

    const activePowerTool = (): PowerTool | undefined =>
        powerTools().find((t) => path().startsWith(t.href));

    return (
        <header class="border-b bg-background px-4 py-2 grid grid-cols-[1fr_auto_1fr] items-center gap-3 flex-none">
            <div class="flex items-center gap-2 justify-self-start">
                <Brand class="text-base" />
            </div>

            <nav class="flex items-center gap-1">
                <NavLink
                    href="/chat"
                    active={isActionsActive()}
                    icon={<ActionsIcon class="size-4" />}
                >
                    Actions
                </NavLink>
                <NavLink
                    href="/data-sources"
                    active={isDataSourcesActive()}
                    icon={<DatabaseIcon class="size-4" />}
                >
                    Data Sources
                </NavLink>
                <Show when={powerTools().length > 0}>
                    <DropdownMenu modal={false}>
                        <DropdownMenuTrigger
                            as={(p: Record<string, unknown>) => (
                                <Button
                                    {...p}
                                    variant={activePowerTool() ? 'default' : 'ghost'}
                                    size="sm"
                                    class="gap-1.5"
                                >
                                    <ToolsIcon class="size-4" />
                                    <Show
                                        when={activePowerTool()}
                                        fallback={<span>Power Tools</span>}
                                    >
                                        {(t) => <span>Power Tools — {t().label}</span>}
                                    </Show>
                                    <ChevronDownIcon class="size-3 opacity-70" />
                                </Button>
                            )}
                        />
                        <DropdownMenuContent>
                            <For each={powerTools()}>
                                {(tool) => (
                                    <DropdownMenuItem
                                        as={A}
                                        href={tool.href}
                                        class={
                                            activePowerTool()?.id === tool.id
                                                ? 'bg-accent text-accent-foreground'
                                                : ''
                                        }
                                    >
                                        {tool.label}
                                    </DropdownMenuItem>
                                )}
                            </For>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </Show>
            </nav>

            <div class="flex items-center gap-1 justify-self-end">
                <Button
                    as={A}
                    href="/settings"
                    variant={path().startsWith('/settings') ? 'default' : 'ghost'}
                    size="icon-sm"
                    aria-label="Settings"
                >
                    <SettingsIcon class="size-4" />
                </Button>
                <ModeToggle />
            </div>
        </header>
    );
};

interface NavLinkProps {
    href: string;
    active: boolean;
    icon: JSX.Element;
    children: JSX.Element;
}

const NavLink: Component<NavLinkProps> = (props) => (
    <Button
        as={A}
        href={props.href}
        variant={props.active ? 'default' : 'ghost'}
        size="sm"
        class="gap-1.5"
    >
        {props.icon}
        {props.children}
    </Button>
);

const ActionsIcon: Component<{ class?: string }> = (p) => (
    <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
        class={p.class}
    >
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
);

const DatabaseIcon: Component<{ class?: string }> = (p) => (
    <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
        class={p.class}
    >
        <ellipse cx="12" cy="5" rx="9" ry="3" />
        <path d="M3 5v14a9 3 0 0 0 18 0V5" />
        <path d="M3 12a9 3 0 0 0 18 0" />
    </svg>
);

const ToolsIcon: Component<{ class?: string }> = (p) => (
    <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
        class={p.class}
    >
        <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
);

const ChevronDownIcon: Component<{ class?: string }> = (p) => (
    <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
        class={p.class}
    >
        <polyline points="6 9 12 15 18 9" />
    </svg>
);

const SettingsIcon: Component<{ class?: string }> = (p) => (
    <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
        class={p.class}
    >
        <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
        <circle cx="12" cy="12" r="3" />
    </svg>
);

export default TopBar;
