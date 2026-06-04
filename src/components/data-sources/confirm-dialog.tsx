import { Show, type Component, type JSX } from 'solid-js';
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/registry/ui/alert-dialog';
import { Button } from '@/registry/ui/button';

/**
 * Promise-friendly styled confirm. Caller flips `open` from a signal,
 * passes labels + a callback per outcome. Used for destructive
 * operations (delete table, delete data source, drop view) so users
 * see a real shadcn dialog instead of the browser's native confirm().
 *
 * `tone` controls the action button color: 'destructive' (default for
 * deletes) renders the confirm button red.
 */
type Props = {
    open: boolean;
    onOpenChange(open: boolean): void;
    title: JSX.Element;
    description?: JSX.Element;
    /** Extra body (column lists, etc.) rendered below the description. */
    body?: JSX.Element;
    confirmLabel?: string;
    cancelLabel?: string;
    tone?: 'destructive' | 'default';
    /**
     * Default: confirm button is a Kobalte CloseButton that auto-closes the
     * dialog on click. When false, the confirm button is a plain Button so
     * the dialog stays open after `onConfirm` runs — the caller is responsible
     * for closing it. Use this when `onConfirm` may surface an error inside
     * the dialog (`body={...errorState}`); otherwise the auto-close hides the
     * error before the user can read it.
     */
    closeOnConfirm?: boolean;
    onConfirm(): void | Promise<void>;
};

export const ConfirmDialog: Component<Props> = (props) => {
    const tone = () => props.tone ?? 'destructive';
    const closeOnConfirm = () => props.closeOnConfirm ?? true;
    const destructiveClass =
        'bg-destructive text-destructive-foreground hover:bg-destructive/90';
    return (
        <AlertDialog open={props.open} onOpenChange={props.onOpenChange}>
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>{props.title}</AlertDialogTitle>
                    <Show when={props.description}>
                        <AlertDialogDescription>
                            {props.description}
                        </AlertDialogDescription>
                    </Show>
                </AlertDialogHeader>
                <Show when={props.body}>
                    <div class="text-xs text-muted-foreground">
                        {props.body}
                    </div>
                </Show>
                <AlertDialogFooter>
                    <AlertDialogCancel>
                        {props.cancelLabel ?? 'Cancel'}
                    </AlertDialogCancel>
                    <Show
                        when={closeOnConfirm()}
                        fallback={
                            <Button
                                class={
                                    tone() === 'destructive'
                                        ? destructiveClass
                                        : undefined
                                }
                                onClick={() => void props.onConfirm()}
                            >
                                {props.confirmLabel ?? 'Confirm'}
                            </Button>
                        }
                    >
                        <AlertDialogAction
                            class={
                                tone() === 'destructive'
                                    ? destructiveClass
                                    : undefined
                            }
                            onClick={() => void props.onConfirm()}
                        >
                            {props.confirmLabel ?? 'Confirm'}
                        </AlertDialogAction>
                    </Show>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
};
