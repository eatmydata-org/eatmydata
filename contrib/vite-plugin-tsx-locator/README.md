# vite-plugin-tsx-locator

Dev-only "where did this DOM come from" tooling for SolidJS apps. Find the
component behind any element on screen, and jump to its source.

Two halves, both stripped from production builds:

1. **`tsxElementBabelPlugin({ root })`** — a Babel plugin for vite-plugin-solid's
   pipeline. Stamps each component's root element with
   `data-tsx-element="Component@relpath:line"` (one tag per component — the
   "module border"; nested children are left untagged). It tags the returned
   *host* root, descending through control-flow (`Show`/`For`/`Switch`/…) and
   render callbacks; a component whose root is another component is left for
   that inner component to tag.

2. **`tsxLocator()`** — a Vite plugin (`apply: 'serve'`) that injects
   [`runtime.js`](./runtime.js) into the page: **Shift + Alt + click** any
   element to open the owning component's source in your editor
   (`vscode://file/…`), plus a small bottom-right reminder.

## UX

There are two things you interact with in the browser — a passive **visual**
marker and an active **click** gesture.

### Visual

- **The reminder badge.** A tiny, fixed pill in the **bottom-right corner**
  reading `⇧⌥ + click → open source`. It's faint (low-opacity grey monospace),
  sits above everything (`z-index: max`), and is **non-interactive**
  (`pointer-events: none`) — it never blocks clicks, scrolling, or hover on the
  app underneath. It's purely a discoverability hint that this mode is on; it's
  present on every page in dev and absent in production.

- **The DOM tags.** Open DevTools and every component's root element shows a
  `data-tsx-element="ChatView@src/components/chat-view.tsx:69"` attribute. There
  is **one tag per component** (its outermost rendered element), not per node —
  so to find which component any element belongs to, look at the **nearest
  ancestor** in the element tree that carries the attribute: that's its "module
  border." The value reads as `Component@<file>:<line>`.

### Click

Hold **Shift + Alt** (⇧⌥ — Option on macOS) and **left-click any element** on the
page:

1. The handler walks up from what you clicked to the nearest
   `[data-tsx-element]` ancestor (the enclosing component).
2. It parses `Component@file:line` and opens
   `vscode://file/<abs-path>:<line>` — your editor jumps to that component's
   definition.
3. The click is **swallowed** (`preventDefault` + `stopPropagation`, capture
   phase) so the app's own handlers don't fire — a Shift+Alt+click won't submit
   a form, follow a link, or trigger a button.

Without the modifiers, clicks behave completely normally — the locator only
reacts to **Shift+Alt+left-click**. If you click somewhere with no tagged
ancestor, nothing happens and the click passes through untouched.

## Usage

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'
import solid from 'vite-plugin-solid'
import { tsxElementBabelPlugin, tsxLocator } from './contrib/vite-plugin-tsx-locator/src/index'

const projectRoot = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig(({ command }) => ({
  plugins: [
    solid(
      command === 'serve'
        ? { babel: { plugins: [tsxElementBabelPlugin({ root: projectRoot })] } }
        : undefined,
    ),
    tsxLocator(),
    // …other plugins
  ],
}))
```

No production cost: the Babel plugin is only added in `serve`, and `tsxLocator`
is `apply: 'serve'`.

## Why a Babel plugin (and the ordering subtlety)

JSX is compiled by `vite-plugin-solid` → `babel-preset-solid`. The stamping runs
in a `Program`-enter `traverse` so the attribute is in place **before**
dom-expressions folds each static subtree into a `_$template(...)` string. A
plain `JSXOpeningElement` / `JSXElement` visitor runs too late — the element has
already been consumed — and the attribute silently vanishes.

## Editor scheme

`runtime.js` builds `vscode://file/<abs>:<line>`. For a different editor, change
the scheme there (e.g. `vscode-insiders://`, `cursor://`).
