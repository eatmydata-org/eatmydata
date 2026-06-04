import { Show, type Component } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import type { MessagePart } from '@/lib/types';
import { PlanConfirmation } from './plan-confirmation';
import { GenericTextConfirmation } from './generic-text-confirmation';
import { AnalysisReviewConfirmation } from './analysis-review-confirmation';
import { AnalysisReviewFeedbackConfirmation } from './analysis-review-feedback-confirmation';
import { UserQuestionConfirmation } from './user-question-confirmation';

export type ConfirmationPart = Extract<MessagePart, { kind: 'confirmation' }>;

export type ConfirmationDecision = {
    approved: boolean;
    response?: unknown;
};

export type ConfirmationRendererProps<TPayload = unknown> = {
    payload: TPayload;
    approved: boolean | null;
    /** Structured payload captured alongside `approved` when the user
     * picked an option. Only set for multi-button dialogs that need to
     * highlight which option was selected after the fact. */
    response?: unknown;
    onDecide: (decision: ConfirmationDecision) => void;
};

export type ConfirmationRenderer<TPayload = unknown> = Component<
    ConfirmationRendererProps<TPayload>
>;

const registry: Record<string, ConfirmationRenderer> = {
    plan: PlanConfirmation as ConfirmationRenderer,
    'generic-text': GenericTextConfirmation as ConfirmationRenderer,
    'analysis-review': AnalysisReviewConfirmation as ConfirmationRenderer,
    'analysis-review-feedback': AnalysisReviewFeedbackConfirmation as ConfirmationRenderer,
    'user-question': UserQuestionConfirmation as ConfirmationRenderer,
};

export function registerConfirmationRenderer(id: string, renderer: ConfirmationRenderer) {
    registry[id] = renderer;
}

type Props = {
    part: ConfirmationPart;
    onDecide: (toolCallId: string, decision: ConfirmationDecision) => void;
};

export const ConfirmationDispatcher: Component<Props> = (props) => {
    const handle = (decision: ConfirmationDecision) =>
        props.onDecide(props.part.toolCallId, decision);
    // `approved`/`response` start null and flip to the decision when the user
    // (or a peer tab) resolves the ticket — the part is mutated in place.
    // Render through `<Dynamic>` so the card receives reactive props the
    // standard way and live-updates (disables its buttons, highlights the
    // picked option) instead of freezing on the initial snapshot. `rendererId`
    // never changes for a part, so resolving the renderer is cheap.
    const renderer = (): ConfirmationRenderer | undefined => registry[props.part.rendererId];
    return (
        <Show
            when={renderer()}
            fallback={
                <GenericTextConfirmation
                    payload={{ text: JSON.stringify(props.part.payload, null, 2) }}
                    approved={props.part.approved}
                    response={props.part.response}
                    onDecide={handle}
                />
            }
        >
            {(r) => (
                <Dynamic
                    component={r()}
                    payload={props.part.payload}
                    approved={props.part.approved}
                    response={props.part.response}
                    onDecide={handle}
                />
            )}
        </Show>
    );
};
