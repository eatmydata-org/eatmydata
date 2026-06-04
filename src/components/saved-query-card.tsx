import { createSignal, type Component } from 'solid-js';
import { Button } from '@/registry/ui/button';
import type { MessagePart } from '@/lib/types';
import { CollapsibleCode } from './collapsible-code';
import { StatusIcon } from './status-icon';

type Props = {
    part: Extract<MessagePart, { kind: 'saved-query' }>;
};

export const SavedQueryCard: Component<Props> = (props) => {
    const [copied, setCopied] = createSignal(false);

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(props.part.query.sql);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            // ignore
        }
    };

    return (
        <div class="text-sm">
            <div class="flex items-center gap-2">
                <span>{props.part.query.name}</span>
                <StatusIcon status="ok" />
                <Button
                    size="sm"
                    variant="ghost"
                    class="ml-auto"
                    onClick={copy}
                >
                    {copied() ? 'copied' : 'copy SQL'}
                </Button>
            </div>
            <p class="text-muted-foreground text-xs mt-1">
                {props.part.query.description}
            </p>
            <div class="mt-2">
                <CollapsibleCode code={props.part.query.sql} previewChars={40} />
            </div>
        </div>
    );
};
