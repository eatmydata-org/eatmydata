import { createSignal, For, Show, type Component } from 'solid-js';
import { Button } from '@/registry/ui/button';
import type { ConfirmationRendererProps } from './index';
import { CtaPanel } from '../cta-panel';
import { StatusIcon } from '../status-icon';

export type UserQuestionOption = {
    id: string;
    label: string;
    hint?: string;
};

export type UserQuestionPayload = {
    question: string;
    options: UserQuestionOption[];
    allowFreeText: boolean;
};

/**
 * Structured multi-option question card driven by the orchestrator's
 * `ask_user` tool. The user selects one of the proposed options and presses
 * Send; the choice returns to the LLM as `{ choiceId, freeText: null }`.
 *
 * There is no in-card free-text input. The "Other" / custom-answer path is
 * the main chat composer instead: while a question is pending, typing there
 * resolves the same ticket as `{ choiceId: null, freeText }` (see chat-view's
 * `handleSubmit`). The card carries a hint pointing the user at it.
 */
export const UserQuestionConfirmation: Component<ConfirmationRendererProps<UserQuestionPayload>> = (
    props,
) => {
    const [selectedId, setSelectedId] = createSignal<string | null>(null);

    const status = () =>
        props.approved === null ? 'pending' : props.approved ? 'approved' : 'cancelled';

    const isDecided = () => props.approved !== null;

    const response = () =>
        props.response as { choiceId?: string | null; freeText?: string | null } | undefined;

    const pickedChoiceId = (): string | null =>
        isDecided() ? (response()?.choiceId ?? null) : null;

    // A non-null free-text answer means the user replied via the main chat
    // composer (the "Other" path) rather than picking an option.
    const pickedFreeText = (): string | null => {
        if (!isDecided()) return null;
        const ft = response()?.freeText ?? null;
        return ft && ft.trim() !== '' ? ft : null;
    };

    // While pending, the highlighted row tracks the local selection; once
    // decided it tracks whichever option the LLM received.
    const isSelected = (id: string) =>
        isDecided() ? pickedChoiceId() === id : selectedId() === id;

    const send = () => {
        const id = selectedId();
        if (!id || isDecided()) return;
        props.onDecide({
            approved: true,
            response: { choiceId: id, freeText: null },
        });
    };

    return (
        <div class="text-sm">
            <div class="flex items-center gap-2">
                <span class="font-semibold">Question</span>
                <Show when={status() === 'approved'}>
                    <StatusIcon status="ok" />
                </Show>
                <Show when={status() === 'cancelled'}>
                    <StatusIcon status="error" />
                </Show>
            </div>
            <div class="mt-2 whitespace-pre-wrap break-words">{props.payload.question}</div>
            <CtaPanel>
                <div class="flex flex-col gap-2">
                    <For each={props.payload.options}>
                        {(opt) => {
                            const selected = () => isSelected(opt.id);
                            return (
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    disabled={isDecided()}
                                    onClick={() => setSelectedId(opt.id)}
                                    class={
                                        'w-full justify-start items-center h-auto py-2 pr-6 text-left ' +
                                        (selected()
                                            ? 'bg-foreground/10 hover:bg-foreground/10'
                                            : 'hover:bg-foreground/5')
                                    }
                                >
                                    <span class="flex flex-col gap-0.5">
                                        <span class="flex items-center gap-2">
                                            <RadioDot selected={selected()} decided={isDecided()} />
                                            <span class="font-medium">{opt.label}</span>
                                        </span>
                                        <Show when={opt.hint}>
                                            <span class="pl-6 text-xs text-muted-foreground font-normal">
                                                {opt.hint}
                                            </span>
                                        </Show>
                                    </span>
                                </Button>
                            );
                        }}
                    </For>
                </div>

                <Show when={!isDecided()}>
                    <div class="flex flex-col gap-2">
                        <Button
                            size="sm"
                            disabled={selectedId() === null}
                            onClick={send}
                            class="self-start"
                        >
                            Send
                        </Button>
                        <div class="mt-1.5 flex items-center gap-2 text-muted-foreground text-xs">
                            <ChatHintIcon />
                            <span>
                                Something else? Type your answer directly in the chat below.
                            </span>
                        </div>
                    </div>
                </Show>

                {/* The user took the "Other" path and typed a custom answer
                    in the main chat — echo it so the card stays legible. */}
                <Show when={pickedFreeText()}>
                    <div class="flex flex-col gap-0.5">
                        <span class="text-[10px] uppercase tracking-wide text-muted-foreground">
                            Your answer
                        </span>
                        <span class="whitespace-pre-wrap break-words">{pickedFreeText()}</span>
                    </div>
                </Show>
            </CtaPanel>
        </div>
    );
};

const RadioDot: Component<{ selected: boolean; decided: boolean }> = (props) => (
    <Show
        when={props.selected && props.decided}
        fallback={
            <span
                aria-hidden="true"
                class={
                    'grid size-4 shrink-0 place-items-center rounded-full border ' +
                    (props.selected ? 'border-current' : 'border-muted-foreground/50')
                }
            >
                <Show when={props.selected}>
                    <span class="size-2 rounded-full bg-current" />
                </Show>
            </span>
        }
    >
        <CheckIcon />
    </Show>
);

const CheckIcon: Component = () => (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" class="size-4 shrink-0">
        <path
            d="M3 8.5l3 3 7-7"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
        />
    </svg>
);

const ChatHintIcon: Component = () => (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" class="size-4 shrink-0">
        <path
            d="M2 4.5A1.5 1.5 0 0 1 3.5 3h9A1.5 1.5 0 0 1 14 4.5v5A1.5 1.5 0 0 1 12.5 11H7l-3 2.5V11H3.5A1.5 1.5 0 0 1 2 9.5v-5Z"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linejoin="round"
        />
    </svg>
);
