import { Show, type Component } from 'solid-js';
import { CtaPanel } from '../cta-panel';
import { StatusIcon } from '../status-icon';
import type { ConfirmationRendererProps } from './index';

export type AnalysisReviewFeedbackPayload = {
    actionName?: string;
};

/**
 * Follow-up card shown after the user thumbs-down an analysis review. It has
 * NO in-card controls: the user explains what to change by typing in the main
 * chat composer, which resolves this confirmation's ticket (see chat-view's
 * `pendingChatInput`). The typed text is rendered as a normal user balloon in
 * the timeline (a `user-note` part the orchestrator adds), so this card only
 * carries the prompt and a brief acknowledgement — it does not echo the text.
 * The orchestrator parks its review loop on this ticket and re-runs the
 * planner + coder with the feedback once it arrives. Until then the draft
 * stays on the Action panel so the user can see what they're critiquing.
 */
export const AnalysisReviewFeedbackConfirmation: Component<
    ConfirmationRendererProps<AnalysisReviewFeedbackPayload>
> = (props) => {
    const decided = () => props.approved !== null;

    return (
        <div class="text-sm">
            <div class="flex items-center gap-2">
                <span class="font-semibold">Revise draft</span>
                <Show when={decided()}>
                    <StatusIcon status="ok" />
                </Show>
            </div>
            <CtaPanel>
                <Show
                    when={!decided()}
                    fallback={
                        <p class="text-sm text-muted-foreground">
                            Got it — working on your changes…
                        </p>
                    }
                >
                    <div class="flex items-start gap-2 text-sm">
                        <ChatHintIcon />
                        <span>
                            Please explain what is wrong with the draft in the chat below, and I
                            will work on it.
                        </span>
                    </div>
                </Show>
            </CtaPanel>
        </div>
    );
};

const ChatHintIcon: Component = () => (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" class="size-4 shrink-0 mt-0.5">
        <path
            d="M2 4.5A1.5 1.5 0 0 1 3.5 3h9A1.5 1.5 0 0 1 14 4.5v5A1.5 1.5 0 0 1 12.5 11H7l-3 2.5V11H3.5A1.5 1.5 0 0 1 2 9.5v-5Z"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linejoin="round"
        />
    </svg>
);
