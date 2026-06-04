import { For, Show, createSignal, type Component } from 'solid-js';
import type { MessagePart } from '@/lib/types';
import { ChevronIcon } from './chevron-icon';
import { CollapsibleCode } from './collapsible-code';
import { StatusIcon } from './status-icon';

type Props = {
    part: Extract<MessagePart, { kind: 'saved-data-source' }>;
};

export const SavedDataSourceCard: Component<Props> = (props) => {
    const preview = () => props.part.preview;
    const rowCount = () => preview()?.sampleRows.length ?? 0;
    const colCount = () => preview()?.sampleColumns.length ?? 0;
    const [open, setOpen] = createSignal(true);

    return (
        <div class="text-sm">
            <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                class="flex w-full items-center gap-2 text-left"
            >
                <span class="font-semibold">{preview()?.name ?? '(pending)'}</span>
                <Show when={props.part.status === 'validating'}>
                    <StatusIcon status="running" />
                </Show>
                <Show when={props.part.status === 'ok'}>
                    <StatusIcon status="ok" />
                    <span class="text-xs text-muted-foreground font-mono">
                        {rowCount()} × {colCount()}
                    </span>
                </Show>
                <Show when={props.part.status === 'error'}>
                    <StatusIcon status="error" />
                </Show>
                <ChevronIcon
                    direction={open() ? 'down' : 'right'}
                    class="ml-auto text-muted-foreground"
                />
            </button>
            <Show when={preview()?.semanticDescription}>
                <p class="text-muted-foreground text-xs mt-1">{preview()!.semanticDescription}</p>
            </Show>
            <Show when={open()}>
                <div class="mt-2 flex flex-col gap-2">
                    <Show when={props.part.error}>
                        <CollapsibleCode
                            code={String(props.part.error)}
                            previewChars={40}
                            tone="destructive"
                        />
                    </Show>
                    <Show when={preview()}>
                        {(p) => (
                            <>
                                <div>
                                    <div class="text-muted-foreground text-[10px] uppercase tracking-wide mb-1">
                                        SQL
                                    </div>
                                    <CollapsibleCode code={p().query} previewChars={40} />
                                </div>
                                <Show when={p().sampleRows.length > 0}>
                                    <div>
                                        <SampleTable
                                            columns={p().sampleColumns}
                                            rows={p().sampleRows}
                                            truncated={p().truncated}
                                        />
                                    </div>
                                </Show>
                            </>
                        )}
                    </Show>
                </div>
            </Show>
        </div>
    );
};

const DEFAULT_VISIBLE_ROWS = 2;

const SampleTable: Component<{
    columns: string[];
    rows: Array<Record<string, unknown>>;
    truncated: boolean;
}> = (props) => {
    const [showAll, setShowAll] = createSignal(false);
    const total = () => props.rows.length;
    const hidden = () => Math.max(0, total() - DEFAULT_VISIBLE_ROWS);
    const visible = () => (showAll() ? props.rows : props.rows.slice(0, DEFAULT_VISIBLE_ROWS));

    return (
        <div class="flex flex-col gap-1">
            <div class="overflow-x-auto rounded border">
                <table class="w-full text-xs font-mono border-collapse">
                    <thead class="bg-muted">
                        <tr>
                            <For each={props.columns}>
                                {(c) => (
                                    <th class="text-left px-2 py-1 border-b font-semibold">{c}</th>
                                )}
                            </For>
                        </tr>
                    </thead>
                    <tbody>
                        <For each={visible()}>
                            {(row) => (
                                <tr class="border-b last:border-b-0">
                                    <For each={props.columns}>
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
                <Show when={showAll() && total() > DEFAULT_VISIBLE_ROWS}>
                    <button
                        type="button"
                        onClick={() => setShowAll(false)}
                        class="hover:text-foreground"
                    >
                        collapse
                    </button>
                </Show>
                <div class="flex flex-1 items-center justify-end gap-2">
                    <Show when={props.truncated}>
                        <span>truncated</span>
                    </Show>
                    <span>Anonymized</span>
                </div>
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
