import { Show, type Component } from 'solid-js';
import type { ConfirmationRendererProps } from './index';
import { CtaPanel } from '../cta-panel';
import { StatusIcon } from '../status-icon';
import { DecisionButtons, type DecisionOption } from './decision-buttons';

export type GenericTextPayload = {
    title?: string;
    text: string;
};

export const GenericTextConfirmation: Component<ConfirmationRendererProps<GenericTextPayload>> = (
    props,
) => {
    const options: DecisionOption[] = [
        { label: 'Approve', decision: { approved: true } },
        { label: 'Reject', decision: { approved: false }, variant: 'ghost' },
    ];
    const status = () =>
        props.approved === null ? 'pending' : props.approved ? 'approved' : 'cancelled';

    return (
        <div class="text-sm">
            <div class="flex items-center gap-2">
                <span class="font-semibold">{props.payload.title ?? 'Confirm'}</span>
                <Show when={status() === 'approved'}>
                    <StatusIcon status="ok" />
                </Show>
                <Show when={status() === 'cancelled'}>
                    <StatusIcon status="error" />
                </Show>
            </div>
            <div class="mt-2 whitespace-pre-wrap break-words">{props.payload.text}</div>
            <CtaPanel>
                <DecisionButtons
                    options={options}
                    approved={props.approved}
                    response={props.response}
                    onDecide={props.onDecide}
                />
            </CtaPanel>
        </div>
    );
};
