import { type Component } from 'solid-js';
import { A } from '@solidjs/router';

/**
 * eatmydata mark — a serving-dome ("cloche") over a plate. Line art that
 * inherits the current text colour (so it works in light and dark), and
 * scales via width/height utility classes. Native ratio 30×28; pass e.g.
 * `class="h-7 w-auto"` to size it.
 */
export const Logo: Component<{ class?: string }> = (props) => (
    <svg
        viewBox="0 0 30 28"
        role="img"
        aria-label="eatmydata"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        class={props.class}
    >
        <title>eatmydata</title>
        <g stroke="none" stroke-width="1" fill="none" fill-rule="evenodd">
            <g transform="translate(-1.3594, -0.7602)" stroke="currentColor">
                <g transform="translate(14, 11) rotate(-20) translate(-14, -11) translate(2, 4)">
                    <path
                        d="M11.9770389,2 C18.306266,2 23.4888433,6.90939176 23.9244383,13.1278429 C23.9440878,13.4083546 23.9540778,13.6915301 23.9540778,13.9770389 L0,13.9770389 C0,7.36230296 5.36230296,2 11.9770389,2 Z"
                        stroke-linejoin="round"
                    />
                    <path
                        d="M7.17567239,5.55674317 C5.57912439,6.56258402 4.27223763,7.9862216 3.40847305,9.67419496"
                        stroke-linecap="round"
                    />
                    <circle fill="currentColor" cx="11.9770389" cy="1" r="1" />
                </g>
                <path
                    d="M2.8591542,22.4793981 L29.8591542,22.4793981 C29.8591542,24.1362524 28.5160084,25.4793981 26.8591542,25.4793981 L5.8591542,25.4793981 C4.20229995,25.4793981 2.8591542,24.1362524 2.8591542,22.4793981 L2.8591542,22.4793981 L2.8591542,22.4793981 Z"
                    stroke-linejoin="round"
                />
            </g>
        </g>
    </svg>
);

/** Top-left wordmark: logo + lowercase "eatmydata", linking home. */
export const Brand: Component<{ class?: string }> = (props) => (
    <A
        href="/"
        aria-label="eatmydata — home"
        class={`group flex items-center gap-2 font-semibold tracking-tight lowercase text-foreground/90 hover:text-foreground transition-colors ${props.class ?? ''}`}
    >
        <Logo class="h-7 w-auto" />
        <span>eatmydata</span>
    </A>
);

export default Brand;
