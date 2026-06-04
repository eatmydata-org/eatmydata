import { createSignal, Show, type Component } from 'solid-js';
import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogDescription,
} from '@/registry/ui/dialog';
import { Button } from '@/registry/ui/button';
import { getSourceDb } from '@/lib/data-sources/db';
import { toSnakeCase } from '@/lib/data-sources/identifier';
import type { DataSource } from '@/lib/data-sources/types';

type Props = {
    open: boolean;
    onOpenChange(open: boolean): void;
    source: DataSource;
    existingNames: ReadonlyArray<string>;
    onCreated(viewName: string): void;
};

export const ViewEditor: Component<Props> = (props) => {
    const [name, setName] = createSignal('new_view');
    const [sql, setSql] = createSignal(
        '-- Define a view over this source\nSELECT *\nFROM table_name\nLIMIT 100',
    );
    const [busy, setBusy] = createSignal(false);
    const [error, setError] = createSignal<string | null>(null);

    const submit = async () => {
        setBusy(true);
        setError(null);
        try {
            const finalName = toSnakeCase(name(), 'new_view');
            if (props.existingNames.includes(finalName)) {
                throw new Error(
                    `Name "${finalName}" already exists in this source`,
                );
            }
            const db = await getSourceDb(props.source);
            // Sanity-check the SELECT first; CREATE VIEW silently accepts
            // a broken SQL string and then explodes on first SELECT.
            const validation = await db.validateQuery(sql());
            if (!validation.ok) {
                throw new Error(validation.error ?? 'invalid SQL');
            }
            await db.execRaw(
                `CREATE VIEW "${finalName.replace(/"/g, '""')}" AS ${sql()}`,
            );
            props.onCreated(finalName);
            props.onOpenChange(false);
            // Reset.
            setName('new_view');
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Dialog open={props.open} onOpenChange={props.onOpenChange}>
            <DialogContent class="max-w-2xl">
                <DialogHeader>
                    <DialogTitle>New view</DialogTitle>
                    <DialogDescription>
                        A view is a read-only saved query that AI can see in
                        the schema, just like a table.
                    </DialogDescription>
                </DialogHeader>
                <div class="flex flex-col gap-3">
                    <label class="flex flex-col gap-1 text-xs">
                        <span class="text-muted-foreground uppercase tracking-wide text-[10px]">
                            Name
                        </span>
                        <input
                            type="text"
                            class="rounded border border-border bg-background px-2 py-1 font-mono"
                            value={name()}
                            onChange={(e) =>
                                setName(e.currentTarget.value.trim())
                            }
                        />
                    </label>
                    <label class="flex flex-col gap-1 text-xs">
                        <span class="text-muted-foreground uppercase tracking-wide text-[10px]">
                            SELECT
                        </span>
                        <textarea
                            class="rounded border border-border bg-background px-2 py-1.5 font-mono text-xs min-h-40 max-h-72 resize-y"
                            spellcheck={false}
                            value={sql()}
                            onInput={(e) => setSql(e.currentTarget.value)}
                        />
                    </label>
                    <Show when={error()}>
                        <div class="text-xs text-destructive font-mono whitespace-pre-wrap">
                            {error()}
                        </div>
                    </Show>
                </div>
                <DialogFooter>
                    <Button
                        variant="ghost"
                        onClick={() => props.onOpenChange(false)}
                    >
                        Cancel
                    </Button>
                    <Button
                        onClick={() => void submit()}
                        disabled={busy() || !sql().trim() || !name().trim()}
                    >
                        {busy() ? 'Creating…' : 'Create view'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};
