import { type Component, For, Show } from 'solid-js';
import { EntityBadge } from './entity-badge';
import type { PiiEntity, PiiDetector } from '@/lib/transformers/client';

const DETECTOR_CHIP: Record<PiiDetector, string> = {
    ner: 'bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30',
    regex: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30',
};

export const EntityList: Component<{
    text: string;
    results: PiiEntity[];
}> = (props) => {
    const sorted = () => [...props.results].sort((a, b) => a.start - b.start);

    return (
        <div class="flex flex-col gap-2">
            <Show
                when={props.results.length > 0}
                fallback={<p class="text-sm text-muted-foreground italic">No entities detected.</p>}
            >
                <ul class="flex flex-col gap-1">
                    <For each={sorted()}>
                        {(r) => (
                            <li class="flex items-start gap-2 rounded-md border bg-card/50 px-2 py-1.5">
                                <EntityBadge type={r.entity_type} />
                                <div class="min-w-0 flex-1">
                                    <div class="font-mono text-xs truncate">
                                        {props.text.slice(r.start, r.end)}
                                    </div>
                                    <div class="text-[10px] text-muted-foreground">
                                        [{r.start}-{r.end}] · score {r.score.toFixed(2)}
                                    </div>
                                    <Show when={(r.sources?.length ?? 0) > 0}>
                                        <div class="mt-1 flex flex-wrap gap-1">
                                            <For each={r.sources}>
                                                {(s) => (
                                                    <span
                                                        class={`inline-flex items-center gap-1 rounded border px-1 py-0.5 text-[10px] font-mono ${DETECTOR_CHIP[s.detector]}`}
                                                        title={`${s.detector} → ${s.entity_type} (score ${s.score.toFixed(2)})`}
                                                    >
                                                        <span class="uppercase font-semibold">
                                                            {s.detector}
                                                        </span>
                                                        <span class="text-muted-foreground">
                                                            {s.entity_type}
                                                        </span>
                                                        <span>{s.score.toFixed(2)}</span>
                                                    </span>
                                                )}
                                            </For>
                                        </div>
                                    </Show>
                                </div>
                            </li>
                        )}
                    </For>
                </ul>
            </Show>
        </div>
    );
};
