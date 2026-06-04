import { Show, createSignal, type Component } from 'solid-js';
import { useParams } from '@solidjs/router';
import type { MessagePart } from '@/lib/types';
import { Button } from '@/registry/ui/button';
import { StatusIcon } from './status-icon';
import { CtaPanel } from './cta-panel';
import { runtime, useSettings } from '@/lib/runtime/client';

type Props = {
    part: Extract<MessagePart, { kind: 'action-failed' }>;
};

/**
 * Deterministic, post-failure status card surfaced by `work_on_action` when
 * one of its sub-agent / persistence steps does not produce a finalized
 * artifact. This is not a confirmation (no yes/no decision tied to a tool
 * call); it's a self-contained UI surface guaranteeing the user sees the
 * failure regardless of what prose the model emits next.
 */
export const ActionFailedRow: Component<Props> = (props) => {
    const params = useParams<{ actionId?: string }>();
    const settings = useSettings();
    const [refining, setRefining] = createSignal(false);
    const [refineText, setRefineText] = createSignal(props.part.intent);
    const [sending, setSending] = createSignal(false);

    const headline = (): string => {
        switch (props.part.reason) {
            case 'planner-empty':
                return "Couldn't draft any data sources for this request.";
            case 'planner-error':
                return 'Data source planning failed.';
            case 'coder-empty':
                return "Couldn't produce the analysis step.";
            case 'coder-error':
                return 'Analysis step failed.';
            case 'persistence-error':
                return "Couldn't save the action.";
        }
        return 'Uknown failure';
    };

    const send = async (text: string) => {
        const trimmed = text.trim();
        if (!trimmed || sending()) return;
        setSending(true);
        try {
            await runtime.submit(params.actionId, trimmed, settings.defaultModelId);
        } finally {
            setSending(false);
            setRefining(false);
        }
    };

    return (
        <div class="text-sm">
            <div class="flex items-center gap-2">
                <StatusIcon status="error" />
                <span class="font-semibold">{props.part.actionName}</span>
                <span class="ml-auto text-[10px] uppercase tracking-wide text-muted-foreground">
                    action failed
                </span>
            </div>
            <p class="mt-1 text-muted-foreground">{headline()}</p>
            <Show when={props.part.detail}>
                <pre class="mt-1 px-2 py-1 rounded bg-muted text-[11px] font-mono whitespace-pre-wrap break-words text-destructive">
                    {props.part.detail}
                </pre>
            </Show>
            <Show when={props.part.intent}>
                <blockquote class="mt-2 border-l-2 border-muted-foreground/30 pl-2 text-xs italic text-muted-foreground">
                    {props.part.intent}
                </blockquote>
            </Show>
            <CtaPanel>
                <Show
                    when={!refining()}
                    fallback={
                        <>
                            <textarea
                                class="w-full rounded border bg-background px-2 py-1 text-sm font-mono resize-y min-h-[4rem]"
                                value={refineText()}
                                disabled={sending()}
                                onInput={(e) => setRefineText(e.currentTarget.value)}
                            />
                            <div class="flex gap-2">
                                <Button
                                    size="sm"
                                    disabled={sending() || refineText().trim().length === 0}
                                    onClick={() => void send(refineText())}
                                >
                                    Send
                                </Button>
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    disabled={sending()}
                                    onClick={() => {
                                        setRefining(false);
                                        setRefineText(props.part.intent);
                                    }}
                                >
                                    Cancel
                                </Button>
                            </div>
                        </>
                    }
                >
                    <p class="text-sm">
                        Retry with the same request, or refine it before sending again.
                    </p>
                    <div class="flex gap-2">
                        <Button
                            size="sm"
                            disabled={sending()}
                            onClick={() => void send(props.part.intent)}
                        >
                            Retry
                        </Button>
                        <Button
                            size="sm"
                            variant="ghost"
                            disabled={sending()}
                            onClick={() => setRefining(true)}
                        >
                            Refine intent
                        </Button>
                    </div>
                </Show>
            </CtaPanel>
        </div>
    );
};
