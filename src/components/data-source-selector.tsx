import {
    Show,
    createMemo,
    createResource,
    onMount,
    type Component,
} from 'solid-js';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectPortal,
    SelectTrigger,
    SelectValue,
} from '@/registry/ui/select';
import { listSources } from '@/lib/data-sources/store';
import type { DataSource } from '@/lib/data-sources/types';

type Props = {
    value: string | undefined;
    onChange(id: string | undefined): void;
    disabled?: boolean;
    /** Pre-pick the starred (or first) source when no value is set. */
    autoPickDefault?: boolean;
    triggerClass?: string;
};

export const DataSourceSelector: Component<Props> = (props) => {
    const [sources] = createResource<DataSource[]>(async () => {
        try {
            return await listSources();
        } catch (e) {
            console.warn('[data-source-selector] list failed', e);
            return [];
        }
    });

    // Stabilize the array reference so Kobalte's Select doesn't see
    // `options` as dirty on unrelated re-renders (see model-selector).
    const ids = createMemo(
        () => (sources() ?? []).map((s) => s.id),
        undefined,
        {
            equals: (prev, next) =>
                prev.length === next.length &&
                prev.every((v, i) => v === next[i]),
        },
    );

    const findSource = (id: string | undefined): DataSource | undefined =>
        id ? (sources() ?? []).find((s) => s.id === id) : undefined;

    onMount(() => {
        if (!props.autoPickDefault) return;
        const wait = setInterval(() => {
            const list = sources();
            if (!list) return;
            clearInterval(wait);
            if (props.value) return;
            const def = list.find((s) => s.isDefault) ?? list[0];
            if (def) props.onChange(def.id);
        }, 50);
    });

    return (
        <Show
            when={(sources() ?? []).length > 0}
            fallback={
                <span class="text-xs text-muted-foreground italic">
                    No data sources yet — add one from the Data sources page.
                </span>
            }
        >
            <Select<string>
                options={ids()}
                value={props.value}
                onChange={(v) => props.onChange(v ?? undefined)}
                disabled={props.disabled}
                placeholder="Select a data source"
                itemComponent={(itemProps) => (
                    <SelectItem item={itemProps.item}>
                        <span class="flex items-center gap-1.5">
                            <Show when={findSource(itemProps.item.rawValue)?.isDefault}>
                                <span aria-hidden="true">★</span>
                            </Show>
                            <span>
                                {findSource(itemProps.item.rawValue)?.name ??
                                    itemProps.item.rawValue}
                            </span>
                        </span>
                    </SelectItem>
                )}
            >
                <SelectTrigger
                    size="sm"
                    aria-label="Data source"
                    class={props.triggerClass}
                >
                    <SelectValue<string>>
                        {(state) =>
                            findSource(state.selectedOption())?.name ?? '—'
                        }
                    </SelectValue>
                </SelectTrigger>
                <SelectPortal>
                    <SelectContent />
                </SelectPortal>
            </Select>
        </Show>
    );
};
