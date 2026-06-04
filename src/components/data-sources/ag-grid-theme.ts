import { themeQuartz } from 'ag-grid-community';

/**
 * AG-Grid theme that pulls colors from the shadcn CSS vars so the grid
 * follows light/dark mode. Theming API in ag-grid v33+ accepts CSS
 * variable references via `withParams()`. We use the
 * `--background`/`--foreground` etc. tokens defined in src/index.css.
 *
 * Shared by the Data Sources table viewer (table-grid.tsx) and the SQL
 * console results grid (sql-result-grid.tsx) so both render identically.
 */
export const shadcnGridTheme = themeQuartz.withParams({
    backgroundColor: 'var(--background)',
    foregroundColor: 'var(--foreground)',
    headerBackgroundColor: 'var(--muted)',
    headerTextColor: 'var(--foreground)',
    borderColor: 'var(--border)',
    rowBorder: { color: 'var(--border)' },
    headerColumnBorder: { color: 'var(--border)' },
    oddRowBackgroundColor: 'var(--background)',
    rowHoverColor: 'var(--accent)',
    selectedRowBackgroundColor: 'color-mix(in srgb, var(--primary) 12%, transparent)',
    accentColor: 'var(--primary)',
    inputBackgroundColor: 'var(--background)',
    inputBorder: { color: 'var(--border)' },
    fontFamily: 'inherit',
    fontSize: 13,
    headerFontSize: 12,
    headerFontWeight: 600,
    rowHeight: 32,
    headerHeight: 36,
    cellHorizontalPadding: 10,
    borderRadius: 8,
});
