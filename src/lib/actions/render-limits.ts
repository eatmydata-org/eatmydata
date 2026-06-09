/**
 * Render-time limits that keep a large result from stalling the browser.
 *
 * The reliable path is the block model: tabular data goes through AG-Grid
 * (virtualized — any row count is fine). These caps are the BACKSTOP for the
 * cases where output still reaches a non-virtualized renderer: a hand-rolled
 * markdown table, raw HTML, or a giant JSON blob. They bound how much ever
 * touches the DOM so the synchronous layout pass can't freeze the tab.
 */

/** At or below this many rows the AG-Grid renders with `domLayout:'autoHeight'`
 *  so it hugs its content instead of sitting in a tall empty box; above it the
 *  grid gets a bounded, virtualized, scrollable box. All tabular results go to
 *  the grid either way — there is no inline/markdown table path. */
export const GRID_AUTO_HEIGHT_MAX_ROWS = 20;

/** Hard cap on `<tr>` ever rendered from a markdown GFM table. ~3000 rows is
 *  the empirical knee where synchronous layout starts to jank; the grid path
 *  is unbounded, so this only catches non-compliant markdown output. */
export const MAX_DOM_TABLE_ROWS = 3000;

/** Stringified-JSON length (chars) above which the `<pre>` view is truncated. */
export const MAX_JSON_PRE_CHARS = 200_000;

/** HTML length (chars) above which we refuse `innerHTML` and show a notice. */
export const MAX_HTML_CHARS = 500_000;
