import { createMemo, type Component } from 'solid-js';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectPortal,
    SelectTrigger,
    SelectValue,
} from '@/registry/ui/select';
import { formatPricingLine } from '@/lib/agent/cost';
import { findModelEntry, useSettings } from '@/lib/runtime/client';
import { useChromeAiStatus } from '@/lib/runtime/chrome-ai-status';
import { splitModelId } from '@/lib/runtime/state/settings-types';

type Props = {
    value: string;
    onChange: (id: string) => void;
    disabled?: boolean;
    triggerClass?: string;
};

export const ModelSelector: Component<Props> = (props) => {
    const chromeAiStatus = useChromeAiStatus();

    // Stabilize the array reference: if the ids haven't changed, return the
    // previous array so Kobalte's Select doesn't see `options` as dirty when
    // an unrelated settings field updates (which would remount the listbox
    // and close an open dropdown mid-interaction).
    //
    // Options span every enabled provider's models. The on-device chrome-ai
    // provider's models are gated on a live "available" probe so we never
    // offer a model the browser can't actually run.
    const ids = createMemo(
        () => {
            const out: string[] = [];
            for (const p of useSettings().providers) {
                if (!p.enabled) continue;
                if (p.kind === 'chrome-ai' && chromeAiStatus() !== 'available') continue;
                for (const m of p.models) out.push(m.id);
            }
            return out;
        },
        undefined,
        {
            equals: (prev, next) =>
                prev.length === next.length && prev.every((v, i) => v === next[i]),
        },
    );

    // Provider label for an option, for disambiguation when two providers
    // expose a similarly-named model.
    const providerLabel = (fqid: string): string => {
        const { providerId } = splitModelId(fqid);
        return useSettings().providers.find((p) => p.id === providerId)?.label ?? providerId;
    };

    return (
        <Select<string>
            options={ids()}
            value={props.value}
            onChange={(v) => v && props.onChange(v)}
            disabled={props.disabled}
            placeholder="Select model"
            itemComponent={(itemProps) => (
                // Reads stay inside JSX so Solid tracks the underlying store
                // paths — capturing `findModelEntry(...)` in a const would
                // snapshot the entry at construct time and miss later updates.
                <SelectItem item={itemProps.item}>
                    <span class="flex flex-col items-start leading-tight">
                        <span>
                            <span class="text-muted-foreground">
                                {providerLabel(itemProps.item.rawValue)} ·{' '}
                            </span>
                            {findModelEntry(itemProps.item.rawValue).label}
                        </span>
                        <span class="text-[10px] text-muted-foreground tabular-nums">
                            {formatPricingLine(findModelEntry(itemProps.item.rawValue).pricing)}
                        </span>
                    </span>
                </SelectItem>
            )}
        >
            <SelectTrigger size="sm" aria-label="Model" class={props.triggerClass}>
                <SelectValue<string>>
                    {(state) => (
                        <span>
                            <span class="text-muted-foreground">
                                {providerLabel(state.selectedOption())} ·{' '}
                            </span>
                            {findModelEntry(state.selectedOption()).label}
                        </span>
                    )}
                </SelectValue>
            </SelectTrigger>
            <SelectPortal>
                <SelectContent />
            </SelectPortal>
        </Select>
    );
};
