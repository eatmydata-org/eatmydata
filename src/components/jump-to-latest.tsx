import { Motion, Presence } from 'solid-motionone';
import { Show, type Component } from 'solid-js';

type Props = {
    visible: boolean;
    onClick: () => void;
    scrollTarget?: () => HTMLElement | undefined;
};

export const JumpToLatest: Component<Props> = (props) => {
    const onWheel = (e: WheelEvent) => {
        const el = props.scrollTarget?.();
        if (!el) return;
        el.scrollBy({ top: e.deltaY, left: e.deltaX });
    };
    return (
        <Presence>
            <Show when={props.visible}>
                <Motion.button
                    initial={{ opacity: 0, y: 12, scale: 0.9 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 12, scale: 0.9 }}
                    transition={{ duration: 0.18, easing: 'ease-out' }}
                    onClick={props.onClick}
                    onWheel={onWheel}
                    class="absolute bottom-0 left-1/2 -translate-x-1/2 z-10 rounded-full bg-card text-card-foreground border shadow-md px-3.5 py-1.5 text-xs font-medium hover:bg-accent flex items-center gap-1.5"
                    type="button"
                >
                    <svg
                        xmlns="http://www.w3.org/2000/svg"
                        viewBox="0 0 24 24"
                        class="size-3.5"
                        fill="currentColor"
                    >
                        <path d="M11 4h2v12.17l4.59-4.58L19 13l-7 7-7-7 1.41-1.41L11 16.17V4z" />
                    </svg>
                    Jump to latest
                </Motion.button>
            </Show>
        </Presence>
    );
};
