import { Show, type Component } from 'solid-js';
import type { Message } from '@/lib/types';
import { MessageStream } from './message-stream';
import type { ConfirmationDecision } from './confirmations';

type Props = {
    messages: Message[];
    inflightId: string | null;
    setScrollRef: (el: HTMLDivElement) => void;
    onConfirmDecision?: (toolCallId: string, decision: ConfirmationDecision) => void;
};

const CHAT_DATE_FMT = new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
});

export const MessageList: Component<Props> = (props) => {
    const firstUserAt = () => props.messages.find((m) => m.role === 'user')?.createdAt;
    return (
        <div ref={props.setScrollRef} class="flex-1 overflow-y-auto overscroll-contain">
            <div class="mx-auto max-w-3xl px-4 pt-10 pb-6 flex flex-col">
                <Show when={firstUserAt()}>
                    {(ts) => (
                        <div class="text-center text-[11px] tabular-nums text-muted-foreground/70 select-none">
                            {CHAT_DATE_FMT.format(ts())}
                        </div>
                    )}
                </Show>
                <MessageStream
                    messages={props.messages}
                    inflightId={props.inflightId}
                    onConfirmDecision={props.onConfirmDecision}
                />
            </div>
        </div>
    );
};
