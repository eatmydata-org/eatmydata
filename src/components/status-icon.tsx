import { Match, Switch, type Component } from 'solid-js';

export type StatusKind = 'pending' | 'running' | 'ok' | 'error';

type Props = {
    status: StatusKind;
    class?: string;
};

/**
 * Small color-coded status icon used inline with tool-call and confirmation
 * headers. Replaces text badges like "ok" / "approved" / "error".
 */
export const StatusIcon: Component<Props> = (props) => (
    <span
        class={
            'inline-flex shrink-0 items-center justify-center ' +
            (props.class ?? '')
        }
        aria-label={props.status}
    >
        <Switch>
            <Match when={props.status === 'ok'}>
                <svg
                    viewBox="0 0 16 16"
                    fill="none"
                    class="size-3.5 text-emerald-600 dark:text-emerald-500"
                >
                    <path
                        d="M3 8.5l3 3 7-7"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                    />
                </svg>
            </Match>
            <Match when={props.status === 'error'}>
                <svg
                    viewBox="0 0 16 16"
                    fill="none"
                    class="size-3.5 text-destructive"
                >
                    <path
                        d="M4 4l8 8M12 4l-8 8"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                    />
                </svg>
            </Match>
            <Match when={props.status === 'running' || props.status === 'pending'}>
                <svg
                    viewBox="0 0 16 16"
                    fill="none"
                    class="size-3.5 text-sky-600 dark:text-sky-400 animate-spin"
                >
                    <circle
                        cx="8"
                        cy="8"
                        r="6"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-opacity="0.25"
                    />
                    <path
                        d="M14 8a6 6 0 0 0-6-6"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                    />
                </svg>
            </Match>
        </Switch>
    </span>
);
