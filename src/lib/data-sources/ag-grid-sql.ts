/**
 * Translators from ag-grid's filter/sort model JSON to SQL fragments
 * (WHERE / ORDER BY). Used by table-grid.tsx's IDatasource to push
 * filtering and sorting down to sqlite instead of doing it client-side.
 *
 * The db layer (`execRaw`) is string-based — there's no parameter
 * binding exposed at that surface — so the translator emits SQL
 * literals directly. All user-supplied values flow through
 * `sqlLiteralValue` / `sqlLikePattern`, which single-quote-escape and
 * gate types. Column names go through `escIdent`.
 *
 * Coverage: ag-grid Community's built-in text / number / date filters,
 * including the two-condition AND/OR form. Set filter (Excel-style
 * multi-select) is Enterprise; not handled here.
 */

export type SortDir = 'asc' | 'desc';

export interface SortModelItem {
    colId: string;
    sort: SortDir;
}

// ag-grid splits filters by `filterType`. The shapes below are the
// subset we actually generate SQL for. See ag-grid docs:
// https://www.ag-grid.com/javascript-data-grid/filter-provided-simple/
export type TextFilterOp =
    | 'equals'
    | 'notEqual'
    | 'contains'
    | 'notContains'
    | 'startsWith'
    | 'endsWith'
    | 'blank'
    | 'notBlank';

export type NumberFilterOp =
    | 'equals'
    | 'notEqual'
    | 'lessThan'
    | 'lessThanOrEqual'
    | 'greaterThan'
    | 'greaterThanOrEqual'
    | 'inRange'
    | 'blank'
    | 'notBlank';

export type DateFilterOp = NumberFilterOp;

export interface TextFilter {
    filterType: 'text';
    type: TextFilterOp;
    filter?: string;
}
export interface NumberFilter {
    filterType: 'number';
    type: NumberFilterOp;
    filter?: number | null;
    filterTo?: number | null;
}
export interface DateFilter {
    filterType: 'date';
    type: DateFilterOp;
    // ag-grid date filters serialize to 'YYYY-MM-DD HH:mm:ss' strings.
    dateFrom?: string | null;
    dateTo?: string | null;
}

export type LeafFilter = TextFilter | NumberFilter | DateFilter;

export interface CombinedFilter {
    filterType: 'text' | 'number' | 'date';
    operator: 'AND' | 'OR';
    condition1: LeafFilter;
    condition2: LeafFilter;
}

export type ColumnFilter = LeafFilter | CombinedFilter;

export type FilterModel = Record<string, ColumnFilter>;

/** Escape a SQL identifier for double-quote quoting. */
export function escIdent(s: string): string {
    return s.replace(/"/g, '""');
}

/** Escape a single-quoted SQL string literal. */
function escStr(s: string): string {
    return s.replace(/'/g, "''");
}

/**
 * Render a JS value as a SQL literal. Mirrors the helper in
 * table-grid.tsx but exported for the translator and the row-edit path.
 */
export function sqlLiteralValue(v: unknown): string {
    if (v === null || v === undefined || v === '') return 'NULL';
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
    if (typeof v === 'boolean') return v ? '1' : '0';
    return `'${escStr(String(v))}'`;
}

/** Escape a value for use inside a `LIKE` pattern. Doubles `%` and `_`. */
function sqlLikePattern(needle: string, mode: 'contains' | 'starts' | 'ends'): string {
    const esc = needle.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    const safe = escStr(esc);
    if (mode === 'contains') return `'%${safe}%' ESCAPE '\\'`;
    if (mode === 'starts') return `'${safe}%' ESCAPE '\\'`;
    return `'%${safe}' ESCAPE '\\'`;
}

/**
 * Translate a single leaf filter to a SQL boolean expression.
 * Returns `null` when the leaf is incomplete (e.g. `contains` with no
 * `filter` value) — caller should treat that as "no constraint".
 */
function leafToSql(colId: string, f: LeafFilter): string | null {
    const col = `"${escIdent(colId)}"`;
    if (f.filterType === 'text') {
        const v = f.filter;
        switch (f.type) {
            case 'blank':
                return `(${col} IS NULL OR ${col} = '')`;
            case 'notBlank':
                return `(${col} IS NOT NULL AND ${col} <> '')`;
            case 'equals':
                return v == null ? null : `${col} = '${escStr(v)}'`;
            case 'notEqual':
                return v == null ? null : `${col} <> '${escStr(v)}'`;
            case 'contains':
                return v == null || v === ''
                    ? null
                    : `${col} LIKE ${sqlLikePattern(v, 'contains')}`;
            case 'notContains':
                return v == null || v === ''
                    ? null
                    : `${col} NOT LIKE ${sqlLikePattern(v, 'contains')}`;
            case 'startsWith':
                return v == null || v === ''
                    ? null
                    : `${col} LIKE ${sqlLikePattern(v, 'starts')}`;
            case 'endsWith':
                return v == null || v === ''
                    ? null
                    : `${col} LIKE ${sqlLikePattern(v, 'ends')}`;
        }
        return null;
    }
    if (f.filterType === 'number') {
        const a = f.filter;
        const b = f.filterTo;
        switch (f.type) {
            case 'blank':
                return `${col} IS NULL`;
            case 'notBlank':
                return `${col} IS NOT NULL`;
            case 'equals':
                return a == null ? null : `${col} = ${numLit(a)}`;
            case 'notEqual':
                return a == null ? null : `${col} <> ${numLit(a)}`;
            case 'lessThan':
                return a == null ? null : `${col} < ${numLit(a)}`;
            case 'lessThanOrEqual':
                return a == null ? null : `${col} <= ${numLit(a)}`;
            case 'greaterThan':
                return a == null ? null : `${col} > ${numLit(a)}`;
            case 'greaterThanOrEqual':
                return a == null ? null : `${col} >= ${numLit(a)}`;
            case 'inRange':
                if (a == null || b == null) return null;
                return `${col} BETWEEN ${numLit(a)} AND ${numLit(b)}`;
        }
        return null;
    }
    if (f.filterType === 'date') {
        const a = f.dateFrom;
        const b = f.dateTo;
        switch (f.type) {
            case 'blank':
                return `${col} IS NULL`;
            case 'notBlank':
                return `${col} IS NOT NULL`;
            case 'equals':
                return a == null ? null : `${col} = '${escStr(a)}'`;
            case 'notEqual':
                return a == null ? null : `${col} <> '${escStr(a)}'`;
            case 'lessThan':
                return a == null ? null : `${col} < '${escStr(a)}'`;
            case 'lessThanOrEqual':
                return a == null ? null : `${col} <= '${escStr(a)}'`;
            case 'greaterThan':
                return a == null ? null : `${col} > '${escStr(a)}'`;
            case 'greaterThanOrEqual':
                return a == null ? null : `${col} >= '${escStr(a)}'`;
            case 'inRange':
                if (a == null || b == null) return null;
                return `${col} BETWEEN '${escStr(a)}' AND '${escStr(b)}'`;
        }
        return null;
    }
    return null;
}

function numLit(n: number): string {
    return Number.isFinite(n) ? String(n) : 'NULL';
}

function columnToSql(colId: string, f: ColumnFilter): string | null {
    if ('operator' in f) {
        const a = leafToSql(colId, f.condition1);
        const b = leafToSql(colId, f.condition2);
        if (a && b) return `(${a} ${f.operator} ${b})`;
        return a ?? b ?? null;
    }
    return leafToSql(colId, f);
}

/**
 * Convert an ag-grid filterModel into a SQL fragment beginning with
 * ` WHERE ...` (leading space). Returns the empty string when no
 * applicable constraints are present.
 */
export function filterModelToWhere(model: FilterModel | null | undefined): string {
    if (!model) return '';
    const parts: string[] = [];
    for (const colId of Object.keys(model)) {
        const expr = columnToSql(colId, model[colId]!);
        if (expr) parts.push(expr);
    }
    if (parts.length === 0) return '';
    return ` WHERE ${parts.join(' AND ')}`;
}

/**
 * Convert ag-grid's sortModel array into ` ORDER BY ...`. Returns ''
 * when empty.
 */
export function sortModelToOrderBy(model: SortModelItem[] | null | undefined): string {
    if (!model || model.length === 0) return '';
    const parts = model.map(
        (s) => `"${escIdent(s.colId)}" ${s.sort === 'desc' ? 'DESC' : 'ASC'}`,
    );
    return ` ORDER BY ${parts.join(', ')}`;
}
