import { For, Show, type Component } from 'solid-js';
import { Button } from '@/registry/ui/button';
import type { ConfirmationDecision } from './index';

type Variant = 'default' | 'secondary' | 'ghost' | 'outline' | 'destructive';

export type DecisionOption = {
    /** Button label. */
    label: string;
    /** Decision sent when the user clicks this option. The selected option is
     * matched back to its decision (approved + structural-equality on response)
     * to decide which button gets the checkmark after the decision resolves. */
    decision: ConfirmationDecision;
    /** Variant used while the decision is still pending. After a decision,
     * the selected button switches to `default` and the rest to `ghost`. */
    variant?: Variant;
};

type Props = {
    options: DecisionOption[];
    /** From the confirmation MessagePart. `null` while pending. */
    approved: boolean | null;
    /** Optional response captured alongside `approved`. Required to identify
     * which option was picked in multi-button dialogs. */
    response?: unknown;
    onDecide: (decision: ConfirmationDecision) => void;
};

/**
 * Renders the action row for a confirmation card. While the decision is
 * pending the buttons are active with their configured variants. After the
 * user picks one, every button stays visible but is disabled — the picked
 * one switches to the `default` variant and shows a check icon, while the
 * rest collapse to `ghost`. Keeps the audit trail of "what was offered" in
 * the chat instead of erasing the choice.
 */
export const DecisionButtons: Component<Props> = (props) => {
    const isDecided = () => props.approved !== null;
    const isSelected = (opt: DecisionOption) => {
        if (!isDecided()) return false;
        if (opt.decision.approved !== props.approved) return false;
        return equalResponses(opt.decision.response, props.response);
    };
    return (
        <div class="flex gap-2 flex-wrap">
            <For each={props.options}>
                {(opt) => {
                    const selected = () => isSelected(opt);
                    const variant = (): Variant => {
                        if (!isDecided()) return opt.variant ?? 'default';
                        return selected() ? 'default' : 'ghost';
                    };
                    return (
                        <Button
                            size="sm"
                            variant={variant()}
                            disabled={isDecided()}
                            onClick={() => props.onDecide(opt.decision)}
                        >
                            <Show when={selected()}>
                                <CheckIcon />
                            </Show>
                            {opt.label}
                        </Button>
                    );
                }}
            </For>
        </div>
    );
};

const CheckIcon: Component = () => (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
            d="M3 8.5l3 3 7-7"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
        />
    </svg>
);

/**
 * Compares two response values for the purpose of identifying the selected
 * option. Treats `undefined` as a match (option declared no response data),
 * primitives are === compared, objects fall back to JSON equality which is
 * good enough for the small structured payloads we use today.
 */
function equalResponses(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a === undefined || b === undefined) {
        // One side declared no response. Treat as match — the typical
        // 2-button case has `approved` alone disambiguating.
        return a === undefined && b === undefined;
    }
    if (typeof a !== 'object' || typeof b !== 'object') return false;
    try {
        return JSON.stringify(a) === JSON.stringify(b);
    } catch {
        return false;
    }
}
