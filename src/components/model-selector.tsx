import { createMemo, Show, type Component } from 'solid-js';
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

/**
 * "free" / "paid" pill for a model. Free = pricing known and both per-token
 * rates are zero (so on-device chrome-ai and OpenRouter `:free` slugs read
 * "free"); paid = pricing known and non-zero. When pricing is unknown (e.g. a
 * Google model before "Download prices") no pill is shown. Read inside JSX so
 * Solid tracks the underlying pricing store path.
 */
const TierBadge: Component<{ fqid: string }> = (props) => {
    const tier = (): 'free' | 'paid' | undefined => {
        const p = findModelEntry(props.fqid).pricing;
        if (!p) return undefined;
        return p.prompt === 0 && p.completion === 0 ? 'free' : 'paid';
    };
    return (
        <Show when={tier()}>
            {(t) => (
                <span
                    class={`ml-1.5 rounded px-1 py-0.5 text-[9px] uppercase font-medium align-middle ${
                        t() === 'free'
                            ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                            : 'bg-muted text-muted-foreground'
                    }`}
                >
                    {t()}
                </span>
            )}
        </Show>
    );
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
                            <TierBadge fqid={itemProps.item.rawValue} />
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
                            <TierBadge fqid={state.selectedOption()} />
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
