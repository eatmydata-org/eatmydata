import { For, Show, type Component } from 'solid-js';
import {
    AlertDialog,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/registry/ui/alert-dialog';
import { Button } from '@/registry/ui/button';
import type { Action } from '@/lib/actions/types';

export type CascadeChoice = 'cascade' | 'keep' | 'cancel';

type Props = {
    open: boolean;
    /** Used in the dialog title — "table" or "view". */
    kind: 'table' | 'view';
    tableName: string;
    /** Actions that appear to reference the table being dropped. */
    actions: Action[];
    onChoice(choice: CascadeChoice): void;
};

/**
 * Modal shown when the user tries to drop a table or view that some saved
 * Action's SQL appears to reference. The user picks: cascade-delete the
 * referencing actions (and their executions/versions), keep them as-is
 * (they'll fail on next run), or cancel the drop.
 */
export const CascadeDropDialog: Component<Props> = (props) => (
    <AlertDialog
        open={props.open}
        onOpenChange={(o) => !o && props.onChoice('cancel')}
    >
        <AlertDialogContent>
            <AlertDialogHeader>
                <AlertDialogTitle>
                    {props.kind === 'view'
                        ? `Drop view "${props.tableName}"?`
                        : `Drop table "${props.tableName}"?`}
                </AlertDialogTitle>
                <AlertDialogDescription>
                    {props.actions.length}{' '}
                    {props.actions.length === 1 ? 'action' : 'actions'} appear
                    to reference{' '}
                    <span class="font-mono">{props.tableName}</span> in their
                    SQL. Keeping them around means they'll error on the next
                    run.
                </AlertDialogDescription>
            </AlertDialogHeader>
            <div class="text-xs text-muted-foreground max-h-48 overflow-y-auto border rounded-md bg-muted/30 p-2">
                <ul class="space-y-0.5">
                    <For each={props.actions}>
                        {(a) => (
                            <li class="flex items-baseline gap-2">
                                <span class="truncate font-medium text-foreground">
                                    {a.name || '(untitled)'}
                                </span>
                                <Show when={a.dataSources.length > 1}>
                                    <span class="tabular-nums text-[10px]">
                                        {a.dataSources.length} sources
                                    </span>
                                </Show>
                            </li>
                        )}
                    </For>
                </ul>
            </div>
            <AlertDialogFooter>
                <Button
                    variant="ghost"
                    onClick={() => props.onChoice('cancel')}
                >
                    Cancel
                </Button>
                <Button
                    variant="secondary"
                    onClick={() => props.onChoice('keep')}
                >
                    Drop + keep actions
                </Button>
                <Button
                    class="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    onClick={() => props.onChoice('cascade')}
                >
                    Drop + delete actions
                </Button>
            </AlertDialogFooter>
        </AlertDialogContent>
    </AlertDialog>
);
