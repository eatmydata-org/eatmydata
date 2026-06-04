import {
    createEffect,
    createSignal,
    onCleanup,
    type Accessor,
} from 'solid-js';

const SPRING = { damping: 0.7, stiffness: 0.05, mass: 1.25 };
const THRESHOLD_PX = 70;

/**
 * Solid hook for "auto-scroll that follows the stream but yields to the user".
 *
 * Latch model: any user interaction (wheel, touch, scroll-up) disengages stick.
 * Stick re-engages only when the user scrolls back to within THRESHOLD_PX of
 * the bottom. The container's first element child is observed so growth
 * during streaming kicks the spring while stuck.
 */
export function useStickToBottom(getRoot: Accessor<HTMLElement | undefined>) {
    const [stuck, setStuck] = createSignal(true);
    let velocity = 0;
    let rafId = 0;
    let lastScrollTop = 0;
    let suppressNextScroll = false;

    const tick = () => {
        const el = getRoot();
        if (!el || !stuck()) return;
        const target = el.scrollHeight - el.clientHeight;
        const dx = target - el.scrollTop;
        if (Math.abs(dx) < 0.5) {
            velocity = 0;
            return;
        }
        velocity = (SPRING.damping * velocity + SPRING.stiffness * dx) / SPRING.mass;
        suppressNextScroll = true;
        el.scrollTop += velocity;
        lastScrollTop = el.scrollTop;
        rafId = requestAnimationFrame(tick);
    };

    const kick = () => {
        cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(tick);
    };

    const scrollToBottom = () => {
        setStuck(true);
        kick();
    };

    createEffect(() => {
        const el = getRoot();
        if (!el) return;
        lastScrollTop = el.scrollTop;

        let ro: ResizeObserver | undefined;
        const child = el.firstElementChild;
        if (child) {
            ro = new ResizeObserver(() => {
                if (stuck()) kick();
            });
            ro.observe(child);
        }

        const onWheel = (e: WheelEvent) => {
            if (e.deltaY < 0) setStuck(false);
        };
        const onTouchMove = () => {
            setStuck(false);
        };
        const onScroll = () => {
            if (suppressNextScroll) {
                suppressNextScroll = false;
                lastScrollTop = el.scrollTop;
                return;
            }
            const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
            const movedUp = el.scrollTop < lastScrollTop - 1;
            if (movedUp) {
                setStuck(false);
            } else if (dist < THRESHOLD_PX) {
                setStuck(true);
            }
            lastScrollTop = el.scrollTop;
        };

        el.addEventListener('wheel', onWheel, { passive: true });
        el.addEventListener('touchmove', onTouchMove, { passive: true });
        el.addEventListener('scroll', onScroll, { passive: true });

        onCleanup(() => {
            ro?.disconnect();
            el.removeEventListener('wheel', onWheel);
            el.removeEventListener('touchmove', onTouchMove);
            el.removeEventListener('scroll', onScroll);
            cancelAnimationFrame(rafId);
        });
    });

    return { stuck: stuck as Accessor<boolean>, scrollToBottom, kick };
}
