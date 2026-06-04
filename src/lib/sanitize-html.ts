import DOMPurify from 'dompurify';

/**
 * HTML sanitization for untrusted markup before it is injected via
 * `innerHTML`.
 *
 * The one consumer today is the `html`-format action output
 * ([action-result-view.tsx](../components/action-result-view.tsx)): that
 * markup is produced by LLM-authored code running in the sandbox, so it is
 * untrusted and a direct `innerHTML` of it is a DOM-XSS sink (flagged by
 * `solid/no-innerhtml`). Routing it through here strips `<script>`, inline
 * event handlers (`onerror`, `onclick`, …), `javascript:` URLs, and other
 * active content, leaving safe presentational HTML.
 *
 * Runs in the browser main thread (DOMPurify needs a real `window`/DOM).
 */

/**
 * Sanitize untrusted HTML, returning a safe string suitable for `innerHTML`.
 * Restricted to the HTML profile (no SVG/MathML) to shrink the attack
 * surface — action output is presentational prose, not vector graphics.
 * DOMPurify's defaults also drop `target`, so links open in-place and there
 * is no reverse-tabnabbing vector to guard against.
 */
export function sanitizeHtml(dirty: string): string {
    return DOMPurify.sanitize(dirty, { USE_PROFILES: { html: true } });
}
