import { type Component, type JSX } from 'solid-js';

type Props = {
    children: JSX.Element;
};

/**
 * Visually distinct call-to-action panel used to surface user-attention
 * confirmations inline in the chat. Gray background + vertical margin so
 * the eye treats it as "this is a question for you", not part of the flow.
 */
export const CtaPanel: Component<Props> = (props) => (
    <div class="mt-4 rounded-md bg-muted px-4 py-3 flex flex-col gap-3">{props.children}</div>
);
