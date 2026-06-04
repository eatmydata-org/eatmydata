/// Dev-only "click-to-source" locator runtime (plain JS, served as-is by Vite).
/// The `tsxLocator()` Vite plugin injects this module into the page in dev and
/// passes the absolute project root on the module URL (`?root=…`), so it can
/// turn the relative paths in `data-tsx-element` into `vscode://file/…` links.
///
///   Shift + Alt + click  →  open the owning component's source at its line.
///
/// Pairs with the `data-tsx-element` tags from `tsxElementBabelPlugin`. Never
/// shipped in production (the Vite plugin is `apply: 'serve'`).

const SOURCE_ROOT = (new URL(import.meta.url).searchParams.get('root') || '').replace(/\/+$/, '');
const BADGE_ID = 'tsx-locator-badge';
const INSTALLED_FLAG = '__tsxLocatorInstalled';
const BOOT_HINT =
    '[tsx-locator] dev click-to-source active — hold ⇧⌥ (Shift+Alt) and click any element to open its source in VS Code.';

/// `data-tsx-element` value is `Component@<relpath>:<line>` — open it in VS Code.
function openInEditor(tag) {
    const loc = tag.slice(tag.lastIndexOf('@') + 1); // "src/…/foo.tsx:69"
    const colon = loc.lastIndexOf(':');
    const rel = colon === -1 ? loc : loc.slice(0, colon);
    const line = colon === -1 ? '1' : loc.slice(colon + 1);
    const url = `vscode://file${SOURCE_ROOT}/${rel}:${line}`;
    console.debug('[tsx-locator]', tag, '→', url);
    // A synthetic anchor click hands the URL to the OS protocol handler without
    // navigating the page (setting location.href can blank the tab).
    const a = document.createElement('a');
    a.href = url;
    a.click();
}

function onClickCapture(e) {
    if (!e.shiftKey || !e.altKey || e.button !== 0) return;
    const el = e.target && e.target.closest ? e.target.closest('[data-tsx-element]') : null;
    const tag = el && el.getAttribute('data-tsx-element');
    if (!tag) return;
    // Swallow the gesture so the app's own click handlers don't fire.
    e.preventDefault();
    e.stopPropagation();
    openInEditor(tag);
}

/// Lazily create the (hidden) hint badge once, returning it for toggling.
function ensureBadge() {
    let badge = document.getElementById(BADGE_ID);
    if (badge) return badge;
    if (!document.body) return null;
    badge = document.createElement('div');
    badge.id = BADGE_ID;
    badge.textContent = '⇧⌥ + click → open source';
    Object.assign(badge.style, {
        position: 'fixed',
        top: '2px',
        right: '2px',
        zIndex: '2147483647',
        font: '10px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace',
        color: 'rgba(125,125,135,0.6)',
        background: 'rgba(127,127,127,0.08)',
        padding: '1px 6px',
        borderRadius: '4px',
        pointerEvents: 'none',
        userSelect: 'none',
        letterSpacing: '0.02em',
        display: 'none',
    });
    document.body.appendChild(badge);
    return badge;
}

/// Show the hint only while the ⇧⌥ chord is actually held; hide otherwise.
function setBadgeVisible(visible) {
    const badge = ensureBadge();
    if (badge) badge.style.display = visible ? 'block' : 'none';
}

function onModifierChange(e) {
    setBadgeVisible(e.shiftKey && e.altKey);
}

function setup() {
    if (window[INSTALLED_FLAG]) return; // idempotent across reloads / re-injection
    window[INSTALLED_FLAG] = true;
    console.warn(BOOT_HINT);
    document.addEventListener('click', onClickCapture, true);
    // Toggle the hint badge as the chord is pressed/released; hide on blur so a
    // tab switch with the keys still down doesn't leave it stuck on-screen.
    document.addEventListener('keydown', onModifierChange, true);
    document.addEventListener('keyup', onModifierChange, true);
    window.addEventListener('blur', () => setBadgeVisible(false));
}

setup();
