import { Show, createSignal, type Component, type JSX } from 'solid-js';

/**
 * Click-to-edit text field. Commits on Enter or blur, reverts on Escape.
 * `disabled` short-circuits everything (display only, no hover affordance).
 *
 * Shared by the Data Sources rename UX, the Action top bar, and anywhere
 * else where a single inline label should be renameable on click.
 */
type Props = {
    value: string;
    disabled?: boolean;
    onSave(name: string): void;
    /** Class applied to the display element (defaults to a label style). */
    class?: string;
    /** Class applied to the <input> when editing. */
    inputClass?: string;
    /** Shown when value is empty and not editing. */
    placeholder?: string;
    /** Tooltip when the display element is clickable. */
    title?: string;
    /** Optional render override for the display element. */
    renderDisplay?: (value: string, start: () => void) => JSX.Element;
};

const DEFAULT_CLASS = 'text-base font-semibold';
const DEFAULT_INPUT_CLASS =
    'text-base font-semibold bg-transparent border-b border-primary px-0.5 outline-none';

export const EditableName: Component<Props> = (props) => {
    const [editing, setEditing] = createSignal(false);
    const [draft, setDraft] = createSignal(props.value);

    const start = () => {
        if (props.disabled) return;
        setDraft(props.value);
        setEditing(true);
    };
    const commit = () => {
        setEditing(false);
        const next = draft().trim();
        if (!next || next === props.value) return;
        props.onSave(next);
    };
    const cancel = () => {
        setDraft(props.value);
        setEditing(false);
    };

    return (
        <Show
            when={editing()}
            fallback={
                <Show
                    when={props.renderDisplay}
                    fallback={
                        <span
                            class={
                                (props.class ?? DEFAULT_CLASS) +
                                (props.disabled
                                    ? ''
                                    : ' cursor-text hover:underline decoration-dotted underline-offset-4')
                            }
                            title={props.disabled ? undefined : (props.title ?? 'Click to rename')}
                            onClick={start}
                        >
                            {props.value || props.placeholder || ''}
                        </span>
                    }
                >
                    {props.renderDisplay!(props.value, start)}
                </Show>
            }
        >
            <input
                type="text"
                autofocus
                class={props.inputClass ?? DEFAULT_INPUT_CLASS}
                value={draft()}
                onInput={(e) => setDraft(e.currentTarget.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        commit();
                    } else if (e.key === 'Escape') {
                        e.preventDefault();
                        cancel();
                    }
                }}
            />
        </Show>
    );
};
