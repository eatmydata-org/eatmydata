import type { ColumnInfo, QueryResult } from '@/lib/wa-sqlite/types';

/**
 * ECMAScript reserved + contextually-reserved + literal names. A column whose
 * name lands in here is renamed to `colN` even though it parses as an
 * identifier — using it as a binding/property key would either fail to parse
 * (`let return = ...`) or be valid-but-trap-prone in TS (`null`, `true`).
 *
 * Keys reachable via dot/property access (`obj.return`) are technically legal
 * in modern JS, but the generated TS declaration uses these names as type
 * keys AND we bind data sources as globals (`globalThis[name] = rows`), where
 * the reserved-name globals would be unreachable from user code. Treat them
 * uniformly as "not a usable identifier."
 */
const JS_RESERVED = new Set([
    'arguments',
    'await',
    'break',
    'case',
    'catch',
    'class',
    'const',
    'continue',
    'debugger',
    'default',
    'delete',
    'do',
    'else',
    'enum',
    'eval',
    'export',
    'extends',
    'false',
    'finally',
    'for',
    'function',
    'if',
    'implements',
    'import',
    'in',
    'instanceof',
    'interface',
    'let',
    'new',
    'null',
    'package',
    'private',
    'protected',
    'public',
    'return',
    'static',
    'super',
    'switch',
    'this',
    'throw',
    'true',
    'try',
    'typeof',
    'undefined',
    'var',
    'void',
    'while',
    'with',
    'yield',
]);

/**
 * True when `name` is a syntactically-valid JS identifier AND not a reserved
 * word. Used to decide whether a SQLite column name can flow through to the
 * generated TS declaration unchanged.
 */
export function isValidJsIdentifier(name: string): boolean {
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) && !JS_RESERVED.has(name);
}

/**
 * Normalize a column-name list: any name that isn't a valid JS identifier is
 * replaced with `col<index>`. Collisions (e.g. the original list already
 * contains the name `col2` and column 2 needs renaming) escalate to
 * `col<index>_<suffix>` to keep keys unique.
 *
 * Returns both the normalized list and a per-index renamed flag so callers
 * can short-circuit the row re-keying pass when nothing changed.
 */
export function normalizeColumnNames(columns: string[]): {
    columns: string[];
    renamed: boolean;
} {
    const used = new Set<string>();
    const out: string[] = new Array(columns.length);
    let renamed = false;
    for (let i = 0; i < columns.length; i++) {
        const orig = columns[i] ?? '';
        let name = isValidJsIdentifier(orig) ? orig : `col${i}`;
        if (name !== orig) renamed = true;
        if (used.has(name)) {
            renamed = true;
            let suffix = 1;
            while (used.has(`col${i}_${suffix}`)) suffix++;
            name = `col${i}_${suffix}`;
        }
        used.add(name);
        out[i] = name;
    }
    return { columns: out, renamed };
}

/**
 * Apply `normalizeColumnNames` to a QueryResult, returning a new result with
 * row keys rewritten in column order. Pass-through (same object) when nothing
 * needed renaming.
 *
 * Note: rows are re-keyed by ordinal (column index), not by the original
 * name. SQLite returns rows as plain objects, so two original columns with
 * the same name silently collapse into one key — that's existing behavior
 * and not made worse here.
 */
export function normalizeQueryResultColumns(result: QueryResult): QueryResult {
    const { columns, renamed } = normalizeColumnNames(result.columns);
    if (!renamed) return result;
    const origColumns = result.columns;
    const rows = result.rows.map((row) => {
        const next: Record<string, unknown> = {};
        for (let i = 0; i < columns.length; i++) {
            next[columns[i]!] = row[origColumns[i]!];
        }
        return next;
    });
    return { ...result, columns, rows };
}

/**
 * Map a SQLite declared type to a coarse TS primitive name. SQLite uses dynamic
 * typing with "type affinity", so we collapse declared types into the four
 * affinity classes plus a fallback.
 */
function affinity(declaredType: string): 'number' | 'string' | 'blob' | 'unknown' {
    const t = declaredType.toUpperCase();
    if (t.includes('INT')) return 'number';
    if (t.includes('CHAR') || t.includes('CLOB') || t.includes('TEXT')) return 'string';
    if (t.includes('BLOB') || t === '') return t === '' ? 'unknown' : 'blob';
    if (
        t.includes('REAL') ||
        t.includes('FLOA') ||
        t.includes('DOUB') ||
        t.includes('NUMERIC') ||
        t.includes('DECIMAL')
    )
        return 'number';
    return 'unknown';
}

function tsPrimitiveSource(a: ReturnType<typeof affinity>): string {
    switch (a) {
        case 'number':
            return 'number';
        case 'string':
            return 'string';
        case 'blob':
            return 'Uint8Array';
        case 'unknown':
            return 'unknown';
    }
}

export type GeneratedTs = {
    /** A `.d.ts`-style `type Foo = Array<{...}>;` block followed by a `declare const`. */
    source: string;
    /**
     * Per-column metadata used to drive the source. Kept so callers can show
     * types in UI without re-parsing the string.
     */
    columns: Array<{
        name: string;
        primitive: ReturnType<typeof affinity>;
        nullable: boolean;
    }>;
};

/**
 * Build a TS declaration from a table's declared column metadata.
 */
export function tsFromTableColumns(
    cols: ColumnInfo[],
    typeName: string,
    bindingName: string,
): GeneratedTs {
    const columns = cols.map((c) => ({
        name: c.name,
        primitive: affinity(c.type),
        nullable: !c.notnull && !c.pk,
    }));
    return buildDeclaration(columns, typeName, bindingName);
}

/**
 * Build a TS declaration from a query result (the Planner's intended use). We
 * infer nullability from sampled rows: a column is nullable if any sample row
 * contains null for it. Declared types come from sqlite3_column_decltype;
 * computed columns (aggregates, expressions) have empty declared type — fall
 * back to inferring from JS types of sample values.
 *
 * `typeName` is the PascalCase name to use for the emitted `type` alias; the
 * runtime binding name (used in the `declare const`) is derived from the
 * data source's snake_case name, passed in separately.
 */
export function tsFromQueryResult(
    result: QueryResult,
    typeName: string,
    bindingName: string,
): GeneratedTs {
    const columns = result.columns.map((name, i) => {
        const declared = result.declaredTypes[i] ?? '';
        let primitive: ReturnType<typeof affinity> =
            declared === '' ? 'unknown' : affinity(declared);
        let observedNull = false;
        if (primitive === 'unknown') {
            primitive = inferFromValues(result.rows, name) ?? 'unknown';
        }
        for (const row of result.rows) {
            if (row[name] === null) {
                observedNull = true;
                break;
            }
        }
        return { name, primitive, nullable: observedNull };
    });
    return buildDeclaration(columns, typeName, bindingName);
}

function inferFromValues(
    rows: Array<Record<string, unknown>>,
    name: string,
): ReturnType<typeof affinity> | null {
    for (const row of rows) {
        const v = row[name];
        if (v === null || v === undefined) continue;
        if (typeof v === 'number') return 'number';
        if (typeof v === 'string') return 'string';
        if (v instanceof Uint8Array) return 'blob';
    }
    return null;
}

function buildDeclaration(
    columns: GeneratedTs['columns'],
    typeName: string,
    bindingName: string,
): GeneratedTs {
    const fields = columns
        .map((c) => {
            const prim = tsPrimitiveSource(c.primitive);
            const typeExpr = c.nullable ? `${prim} | null` : prim;
            return `  ${safeKey(c.name)}: ${typeExpr};`;
        })
        .join('\n');
    const source = `type ${typeName} = Array<{\n${fields}\n}>;\ndeclare const ${bindingName}: ${typeName};`;
    return { source, columns };
}

function safeKey(name: string): string {
    return isValidJsIdentifier(name) ? name : JSON.stringify(name);
}

/**
 * snake_case → PascalCase. Splits on underscores, drops empty parts (so
 * leading/trailing/double underscores don't produce empty segments), and
 * capitalizes the first character of each remaining part if it is an ASCII
 * letter. Other characters (e.g. digits) are left as-is.
 *
 *   `top_customers_by_revenue` → `TopCustomersByRevenue`
 *   `top_10_revenue`           → `Top10Revenue`
 *   `__foo`                    → `Foo`
 */
export function toPascalCase(name: string): string {
    const parts = name.split('_').filter((p) => p.length > 0);
    if (parts.length === 0) return 'Anonymous';
    return parts
        .map((p) => {
            const first = p.charAt(0);
            if (first >= 'a' && first <= 'z') {
                return first.toUpperCase() + p.slice(1);
            }
            return p;
        })
        .join('');
}
