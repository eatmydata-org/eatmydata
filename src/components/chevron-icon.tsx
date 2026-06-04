import type { Component } from 'solid-js';

type Props = {
    direction: 'right' | 'down';
    class?: string;
};

export const ChevronIcon: Component<Props> = (props) => (
    <svg
        viewBox="0 0 16 16"
        fill="none"
        class={'size-3.5 ' + (props.class ?? '')}
        aria-hidden="true"
        style={{
            transform: props.direction === 'down' ? 'rotate(90deg)' : undefined,
            transition: 'transform 120ms ease',
        }}
    >
        <path
            d="M6 4l4 4-4 4"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
        />
    </svg>
);
