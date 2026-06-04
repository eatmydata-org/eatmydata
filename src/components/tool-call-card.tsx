import { For, Show, createSignal, type Component } from 'solid-js';
import { Badge } from '@/registry/ui/badge';
import type { MessagePart } from '@/lib/types';
import { ChevronIcon } from './chevron-icon';
import { CollapsibleCode } from './collapsible-code';
import { StatusIcon } from './status-icon';
import { toolDisplayName } from './tool-labels';

type Props = {
    part: Extract<MessagePart, { kind: 'tool-call' }>;
};

export const ToolCallCard: Component<Props> = (props) => {
    const [open, setOpen] = createSignal(false);
    return (
        <div class="text-sm">
            <button
                type="button"
                class="flex w-full items-center gap-2 text-left"
                onClick={() => setOpen((v) => !v)}
            >
                <span>{toolDisplayName(props.part.toolName)}</span>
                <StatusIcon status={props.part.status} />
                <ChevronIcon
                    direction={open() ? 'down' : 'right'}
                    class="ml-auto text-muted-foreground"
                />
            </button>
            <Show when={open()}>
                <div class="mt-2 flex flex-col gap-2">
                    <div>
                        <div class="text-muted-foreground text-[10px] uppercase tracking-wide mb-1">
                            input
                        </div>
                        <CollapsibleCode
                            code={JSON.stringify(props.part.input ?? null, null, 2)}
                            previewChars={40}
                        />
                    </div>
                    <Show when={props.part.error}>
                        <div>
                            <div class="text-muted-foreground text-[10px] uppercase tracking-wide mb-1">
                                error
                            </div>
                            <CollapsibleCode
                                code={String(props.part.error)}
                                previewChars={40}
                                tone="destructive"
                            />
                        </div>
                    </Show>
                    <Show when={props.part.status === 'ok' && props.part.result !== undefined}>
                        <ToolResultPreview
                            toolName={props.part.toolName}
                            result={props.part.result}
                        />
                    </Show>
                </div>
            </Show>
        </div>
    );
};

const ToolResultPreview: Component<{ toolName: string; result: unknown }> = (props) => {
    return (
        <div>
            <div class="text-muted-foreground text-[10px] uppercase tracking-wide mb-1">result</div>
            <Show
                when={props.toolName === 'data_sample'}
                fallback={
                    <CollapsibleCode
                        code={JSON.stringify(props.result, null, 2)}
                        previewChars={40}
                    />
                }
            >
                <DataSampleTable
                    result={
                        props.result as {
                            columns: string[];
                            rows: Array<Record<string, unknown>>;
                            truncated: boolean;
                            rowLimit: number;
                            sanitized?: boolean;
                        }
                    }
                />
            </Show>
        </div>
    );
};

const DEFAULT_VISIBLE_ROWS = 2;

const DataSampleTable: Component<{
    result: {
        columns: string[];
        rows: Array<Record<string, unknown>>;
        truncated: boolean;
        rowLimit: number;
        sanitized?: boolean;
    };
}> = (props) => {
    const [showAll, setShowAll] = createSignal(false);
    const totalRows = () => props.result.rows.length;
    const hidden = () => Math.max(0, totalRows() - DEFAULT_VISIBLE_ROWS);
    const visibleRows = () =>
        showAll() ? props.result.rows : props.result.rows.slice(0, DEFAULT_VISIBLE_ROWS);

    return (
        <div class="flex flex-col gap-1">
            <Show when={props.result.sanitized}>
                <div class="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                    <Badge variant="outline" class="font-mono text-[10px] px-1.5 py-0">
                        sanitized
                    </Badge>
                    <span>Synthetic values — shape only, not real data.</span>
                </div>
            </Show>
            <div class="overflow-x-auto rounded border">
                <table class="w-full text-xs font-mono border-collapse">
                    <thead class="bg-muted">
                        <tr>
                            <For each={props.result.columns}>
                                {(c) => (
                                    <th class="text-left px-2 py-1 border-b font-semibold">{c}</th>
                                )}
                            </For>
                        </tr>
                    </thead>
                    <tbody>
                        <For each={visibleRows()}>
                            {(row) => (
                                <tr class="border-b last:border-b-0">
                                    <For each={props.result.columns}>
                                        {(col) => (
                                            <td class="px-2 py-1 align-top">
                                                {formatCell(row[col])}
                                            </td>
                                        )}
                                    </For>
                                </tr>
                            )}
                        </For>
                    </tbody>
                </table>
            </div>
            <div class="flex items-center gap-2 text-[10px] uppercase tracking-wide text-muted-foreground">
                <Show when={hidden() > 0 && !showAll()}>
                    <button
                        type="button"
                        onClick={() => setShowAll(true)}
                        class="hover:text-foreground"
                    >
                        show {hidden()} more
                    </button>
                </Show>
                <Show when={showAll() && totalRows() > DEFAULT_VISIBLE_ROWS}>
                    <button
                        type="button"
                        onClick={() => setShowAll(false)}
                        class="hover:text-foreground"
                    >
                        collapse
                    </button>
                </Show>
                <Show when={props.result.truncated}>
                    <span>truncated to {props.result.rowLimit} rows</span>
                </Show>
                <Show when={totalRows() === 0}>
                    <span>no rows</span>
                </Show>
            </div>
        </div>
    );
};

function formatCell(v: unknown): string {
    if (v === null || v === undefined) return '∅';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return JSON.stringify(v);
}
