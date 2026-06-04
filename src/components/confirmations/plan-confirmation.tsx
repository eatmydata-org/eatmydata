import { For, Show, type Component } from 'solid-js';
import type { PlanInput } from '@/lib/types';
import type { ConfirmationRendererProps } from './index';
import { CtaPanel } from '../cta-panel';
import { StatusIcon } from '../status-icon';
import { DecisionButtons, type DecisionOption } from './decision-buttons';

export const PlanConfirmation: Component<ConfirmationRendererProps<PlanInput>> = (props) => {
    const options: DecisionOption[] = [
        { label: 'Run plan', decision: { approved: true } },
        { label: 'Cancel', decision: { approved: false }, variant: 'ghost' },
    ];
    const status = () =>
        props.approved === null ? 'pending' : props.approved ? 'approved' : 'cancelled';

    return (
        <div class="text-sm">
            <div class="flex items-center gap-2">
                <span class="font-semibold">Approve plan</span>
                <Show when={status() === 'approved'}>
                    <StatusIcon status="ok" />
                </Show>
                <Show when={status() === 'cancelled'}>
                    <StatusIcon status="error" />
                </Show>
            </div>
            <div class="mt-2 flex flex-col gap-2">
                <div>{props.payload.summary}</div>
                <Show when={props.payload.tables.length > 0}>
                    <div class="flex flex-wrap items-baseline gap-1.5">
                        <span class="text-muted-foreground text-xs">tables</span>
                        <For each={props.payload.tables}>
                            {(t) => (
                                <code class="px-1.5 py-0.5 rounded bg-muted text-xs font-mono">
                                    {t}
                                </code>
                            )}
                        </For>
                    </div>
                </Show>
                <Show when={props.payload.columns.length > 0}>
                    <div class="flex flex-wrap items-baseline gap-1.5">
                        <span class="text-muted-foreground text-xs">columns</span>
                        <For each={props.payload.columns}>
                            {(c) => (
                                <code class="px-1.5 py-0.5 rounded bg-muted text-xs font-mono">
                                    {c}
                                </code>
                            )}
                        </For>
                    </div>
                </Show>
                <Show when={props.payload.intended_queries.length > 0}>
                    <div class="flex flex-col gap-1">
                        <span class="text-muted-foreground text-xs">intended queries</span>
                        <For each={props.payload.intended_queries}>
                            {(q) => (
                                <pre class="px-2 py-1.5 rounded bg-muted text-xs font-mono whitespace-pre-wrap break-words">
                                    {q}
                                </pre>
                            )}
                        </For>
                    </div>
                </Show>
            </div>
            <CtaPanel>
                <p class="text-sm">Approve to run this plan, or cancel to revise.</p>
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
