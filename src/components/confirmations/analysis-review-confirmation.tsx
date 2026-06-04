import { Show, type Component } from 'solid-js';
import { Button } from '@/registry/ui/button';
import { CtaPanel } from '../cta-panel';
import { StatusIcon } from '../status-icon';
import type { ConfirmationRendererProps } from './index';

export type AnalysisReviewPayload = {
    actionName: string;
    iteration: number;
    /** Top-level executor error if the candidate execution surfaced one
     * — shown inline so the user can decide on it without scrolling the
     * side panel. */
    resultError?: string;
};

/**
 * Confirmation card asking the user to verify the rendered result on the
 * Action panel with a thumbs-up / thumbs-down. The decision resolves
 * immediately on click — there is no in-card feedback textarea.
 *
 * (a) Once the user answers, the choice is recorded on the confirmation part's
 * `approved` (persisted to IDB by the runtime's auto-persist), and BOTH
 * buttons stay visible but disabled, the chosen one highlighted with a check —
 * the other option can no longer be picked. `approved` is the single source of
 * truth: the click updates it (→ live recolor via the mirror) and it's
 * restored from IDB on reload / peer tabs.
 *
 * (b) On thumbs-down the orchestrator follows up with a separate
 * `analysis-review-feedback` card and parks its review loop until the user
 * explains what to change in the main chat composer (see chat-view's
 * `pendingChatInput`). This card therefore carries no feedback text.
 */
export const AnalysisReviewConfirmation: Component<
    ConfirmationRendererProps<AnalysisReviewPayload>
> = (props) => {
    const decided = () => props.approved !== null;
    const approvedNow = () => props.approved === true;
    const rejectedNow = () => props.approved === false;

    const decide = (approved: boolean) => {
        if (decided()) return;
        props.onDecide({ approved });
    };

    return (
        <div class="text-sm">
            <div class="flex items-center gap-2">
                <span class="font-semibold">Review analysis</span>
                <Show when={props.payload.iteration > 1}>
                    <span class="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                        attempt {props.payload.iteration}
                    </span>
                </Show>
                <Show when={approvedNow()}>
                    <StatusIcon status="ok" />
                </Show>
                <Show when={rejectedNow()}>
                    <StatusIcon status="error" />
                </Show>
            </div>

            <Show when={props.payload.resultError}>
                <div class="mt-2 px-2 py-1.5 rounded border border-destructive/40 bg-destructive/10 text-xs text-destructive font-mono whitespace-pre-wrap">
                    {props.payload.resultError}
                </div>
            </Show>

            <CtaPanel>
                <Show when={!decided()}>
                    <p class="text-sm">
                        Review the result on the Action panel. Does it answer your question?
                    </p>
                </Show>
                <div class="flex gap-2 flex-wrap">
                    <DecisionButton
                        label="Yes"
                        icon="up"
                        active={approvedNow()}
                        decided={decided()}
                        pendingVariant="default"
                        onClick={() => decide(true)}
                    />
                    <DecisionButton
                        label="No"
                        icon="down"
                        active={rejectedNow()}
                        decided={decided()}
                        pendingVariant="secondary"
                        onClick={() => decide(false)}
                    />
                </div>
                <Show when={approvedNow()}>
                    <p class="text-sm text-muted-foreground">Approved — version saved.</p>
                </Show>
            </CtaPanel>
        </div>
    );
};

/**
 * A single Yes/No button. While pending it shows its thumb icon and its
 * configured variant. Once the review is decided every button is disabled;
 * the picked one switches to `default` + a check icon, the other collapses
 * to `ghost` — keeping the offered choice visible instead of erasing it.
 */
const DecisionButton: Component<{
    label: string;
    icon: 'up' | 'down';
    active: boolean;
    decided: boolean;
    pendingVariant: 'default' | 'secondary';
    onClick: () => void;
}> = (props) => {
    const variant = (): 'default' | 'secondary' | 'ghost' => {
        if (!props.decided) return props.pendingVariant;
        return props.active ? 'default' : 'ghost';
    };
    return (
        <Button
            size="sm"
            variant={variant()}
            disabled={props.decided}
            aria-label={props.label}
            onClick={props.onClick}
        >
            <Show
                when={props.decided && props.active}
                fallback={
                    <Show when={props.icon === 'up'} fallback={<ThumbsDownIcon class="size-4" />}>
                        <ThumbsUpIcon class="size-4" />
                    </Show>
                }
            >
                <CheckIcon class="size-4" />
            </Show>
            {props.label}
        </Button>
    );
};

const ThumbsUpIcon: Component<{ class?: string }> = (props) => (
    <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
        class={props.class}
    >
        <path d="M7 10v12" />
        <path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H7V10l5-9 1 .5a3 3 0 0 1 2 2.88Z" />
    </svg>
);

const ThumbsDownIcon: Component<{ class?: string }> = (props) => (
    <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
        class={props.class}
    >
        <path d="M17 14V2" />
        <path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H17v12l-5 9-1-.5a3 3 0 0 1-2-2.88Z" />
    </svg>
);

const CheckIcon: Component<{ class?: string }> = (props) => (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" class={props.class}>
        <path
            d="M3 8.5l3 3 7-7"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
        />
    </svg>
);
