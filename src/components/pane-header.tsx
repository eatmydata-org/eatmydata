import { type Component, type JSX } from 'solid-js';
import { cn } from '@/lib/cn';

type PaneHeaderProps = {
    /** Padding / justify / bg overrides (merged via tailwind-merge). */
    class?: string;
    children: JSX.Element;
};

/**
 * The horizontal bar that tops every pane: the Actions sidebar + chat pane,
 * and the Data Sources list + detail panes. Fixes the height, padding,
 * border, and background in one place so sibling panes line their `border-b`
 * up exactly. Compose the leading title with `PaneHeaderTitle` and trailing
 * controls with `PaneHeaderActions`.
 */
export const PaneHeader: Component<PaneHeaderProps> = (props) => (
    <header class={cn('flex items-center gap-2 px-3 h-12 border-b bg-card flex-none', props.class)}>
        {props.children}
    </header>
);

/** Standard pane title — `text-sm font-semibold`, matching every pane. */
export const PaneHeaderTitle: Component<{
    class?: string;
    children: JSX.Element;
}> = (props) => <span class={cn('text-sm font-semibold', props.class)}>{props.children}</span>;

/** Trailing control cluster, pushed to the far edge of the bar. */
export const PaneHeaderActions: Component<{
    class?: string;
    children: JSX.Element;
}> = (props) => (
    <div class={cn('ml-auto flex items-center gap-1', props.class)}>{props.children}</div>
);
