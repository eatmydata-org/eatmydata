import { type Component, type JSX } from 'solid-js';
import { cx } from '@/registry/lib/cva';

// Fixed palette of distinguishable Tailwind hues.
//
// Same label → same color, deterministic across reloads. Some hash
// collisions are unavoidable; for a 53-type set against a 20-entry
// palette they're acceptable in a testbed.

interface PaletteEntry {
    chip: string;
    highlight: string;
    decoration: string;
}

const PALETTE: readonly PaletteEntry[] = [
    {
        chip: 'bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30',
        highlight: 'bg-blue-500/30',
        decoration: 'decoration-blue-500',
    },
    {
        chip: 'bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 border-indigo-500/30',
        highlight: 'bg-indigo-500/30',
        decoration: 'decoration-indigo-500',
    },
    {
        chip: 'bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/30',
        highlight: 'bg-violet-500/30',
        decoration: 'decoration-violet-500',
    },
    {
        chip: 'bg-purple-500/15 text-purple-700 dark:text-purple-300 border-purple-500/30',
        highlight: 'bg-purple-500/30',
        decoration: 'decoration-purple-500',
    },
    {
        chip: 'bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-300 border-fuchsia-500/30',
        highlight: 'bg-fuchsia-500/30',
        decoration: 'decoration-fuchsia-500',
    },
    {
        chip: 'bg-pink-500/15 text-pink-700 dark:text-pink-300 border-pink-500/30',
        highlight: 'bg-pink-500/30',
        decoration: 'decoration-pink-500',
    },
    {
        chip: 'bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-500/30',
        highlight: 'bg-rose-500/30',
        decoration: 'decoration-rose-500',
    },
    {
        chip: 'bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30',
        highlight: 'bg-red-500/30',
        decoration: 'decoration-red-500',
    },
    {
        chip: 'bg-orange-500/15 text-orange-700 dark:text-orange-300 border-orange-500/30',
        highlight: 'bg-orange-500/30',
        decoration: 'decoration-orange-500',
    },
    {
        chip: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30',
        highlight: 'bg-amber-500/30',
        decoration: 'decoration-amber-500',
    },
    {
        chip: 'bg-yellow-500/15 text-yellow-700 dark:text-yellow-300 border-yellow-500/30',
        highlight: 'bg-yellow-500/30',
        decoration: 'decoration-yellow-500',
    },
    {
        chip: 'bg-lime-500/15 text-lime-700 dark:text-lime-300 border-lime-500/30',
        highlight: 'bg-lime-500/30',
        decoration: 'decoration-lime-500',
    },
    {
        chip: 'bg-green-500/15 text-green-700 dark:text-green-300 border-green-500/30',
        highlight: 'bg-green-500/30',
        decoration: 'decoration-green-500',
    },
    {
        chip: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30',
        highlight: 'bg-emerald-500/30',
        decoration: 'decoration-emerald-500',
    },
    {
        chip: 'bg-teal-500/15 text-teal-700 dark:text-teal-300 border-teal-500/30',
        highlight: 'bg-teal-500/30',
        decoration: 'decoration-teal-500',
    },
    {
        chip: 'bg-cyan-500/15 text-cyan-700 dark:text-cyan-300 border-cyan-500/30',
        highlight: 'bg-cyan-500/30',
        decoration: 'decoration-cyan-500',
    },
    {
        chip: 'bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30',
        highlight: 'bg-sky-500/30',
        decoration: 'decoration-sky-500',
    },
    {
        chip: 'bg-stone-500/15 text-stone-700 dark:text-stone-300 border-stone-500/30',
        highlight: 'bg-stone-500/30',
        decoration: 'decoration-stone-500',
    },
    {
        chip: 'bg-zinc-500/15 text-zinc-700 dark:text-zinc-300 border-zinc-500/30',
        highlight: 'bg-zinc-500/30',
        decoration: 'decoration-zinc-500',
    },
    {
        chip: 'bg-neutral-500/15 text-neutral-700 dark:text-neutral-300 border-neutral-500/30',
        highlight: 'bg-neutral-500/30',
        decoration: 'decoration-neutral-500',
    },
];

// 32b fnv-1a
function hashLabel(label: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < label.length; i++) {
        h ^= label.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

export function paletteFor(type: string): PaletteEntry {
    const idx = hashLabel(type.toLowerCase()) % PALETTE.length;
    return PALETTE[idx]!;
}

// "credit_debit_card" -> "CREDIT DEBIT CARD". The model emits
// snake_case lowercase; uppercasing with spaces reads cleaner in chips.
export function formatLabel(type: string): string {
    return type.replace(/_/g, ' ').toUpperCase();
}

export const EntityBadge: Component<{
    type: string;
    class?: string;
    children?: JSX.Element;
}> = (props) => {
    const colors = () => paletteFor(props.type);
    return (
        <span
            class={cx(
                'inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-mono font-medium leading-none whitespace-nowrap',
                colors().chip,
                props.class,
            )}
        >
            {props.children ?? formatLabel(props.type)}
        </span>
    );
};
