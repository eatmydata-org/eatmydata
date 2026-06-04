import { Show, type Component } from 'solid-js';
import type { MessagePart } from '@/lib/types';
import { getResult } from '@/lib/runtime/client';

type Props = {
    part: Extract<MessagePart, { kind: 'action-result-link' }>;
};

/**
 * One-line "v{N} saved" chip dropped into the chat rail when the
 * orchestrator commits a new ActionVersion. The side panel renders the
 * result itself, so the chip is just a scrollback breadcrumb — no
 * "Open in side panel" button (the panel is always open) and no
 * surface area for re-execution. Clicking the action name still opens
 * the standalone result page in a new tab so the user has a
 * shareable link.
 */
export const ActionResultLinkCard: Component<Props> = (props) => {
    const result = () => getResult(props.part.resultId);
    const exists = () => Boolean(result());
    const versionLabel = () =>
        props.part.versionIndex !== undefined ? `v${props.part.versionIndex}` : 'version';
    return (
        <div class="flex items-center gap-2 text-xs text-muted-foreground">
            <span class="px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-700 dark:text-blue-300 font-mono text-[10px] font-semibold uppercase tracking-wider">
                {versionLabel()} saved
            </span>
            <Show when={exists()} fallback={<span class="truncate">{props.part.actionName}</span>}>
                <a
                    href={`/result/${props.part.resultId}`}
                    target="_blank"
                    rel="noreferrer"
                    class="truncate text-primary hover:underline"
                    title="Open result in new window"
                >
                    {props.part.actionName}
                </a>
            </Show>
        </div>
    );
};
