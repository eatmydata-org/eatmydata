/**
 * Per-column type inference + value coercion for imported data.
 *
 * Two reasons this exists separately from the parsers:
 *  - CSV parsing produces strings. The numeric detector needs to know
 *    about thousand/decimal conventions and won't assume one (e.g.
 *    "1,234.56" vs "1.234,56" vs ambiguous "1,5"). It scores both
 *    interpretations across the column and picks the consistent one.
 *  - XLSX parsing (via SheetJS with raw: true) already returns typed
 *    JS values (numbers, dates, booleans, strings, nulls). The detector
 *    coerces those to INTEGER/REAL/TEXT too.
 */

export type SqlColType = 'INTEGER' | 'REAL' | 'TEXT';

export type ColumnSniff = {
    sqlType: SqlColType;
    /**
     * Decimal style picked for this column. Only meaningful when the
     * source was strings (CSV). For typed input it's always 'point'.
     *  - 'point':  1,234.56 (en)
     *  - 'comma':  1.234,56 (de)
     *  - 'none':   no thousand separator; decimal may be either — fall
     *              back to en by default
     */
    decimal: 'point' | 'comma' | 'none';
};

const isNullish = (v: unknown): v is null | undefined | '' =>
    v === null || v === undefined || v === '';

const INT_RE = /^-?(?:0|[1-9]\d{0,17})$/;
// Real number, en: optional thousands ",", required decimal "." OR plain.
const REAL_EN_RE = /^-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/;
// Real number, de: optional thousands ".", required decimal "," OR plain.
const REAL_DE_RE = /^-?(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d+)?$/;
// Plain decimals with either separator and no thousands — ambiguous.
const REAL_AMBIG_RE = /^-?\d+[.,]\d+$/;

function coerceNumberEn(s: string): number | null {
    if (!REAL_EN_RE.test(s) && !INT_RE.test(s)) return null;
    const n = Number(s.replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
}

function coerceNumberDe(s: string): number | null {
    if (!REAL_DE_RE.test(s) && !INT_RE.test(s)) return null;
    const n = Number(s.replace(/\./g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : null;
}

/**
 * Sniff a single column from a sample of cell values. Mixed inputs
 * accepted; non-string values are inspected directly (XLSX path).
 */
export function sniffColumn(samples: readonly unknown[]): ColumnSniff {
    let nonNull = 0;
    let intOk = 0;
    let realEnOk = 0;
    let realDeOk = 0;
    let hasComma = false;
    let hasPoint = false;
    let sawNonNumeric = false;
    let sawTypedNumber = false;
    let sawTypedInt = false;

    for (const v of samples) {
        if (isNullish(v)) continue;
        nonNull++;
        if (typeof v === 'number') {
            sawTypedNumber = true;
            if (Number.isInteger(v)) sawTypedInt = true;
            intOk += Number.isInteger(v) ? 1 : 0;
            realEnOk++;
            realDeOk++;
            continue;
        }
        if (typeof v === 'boolean') {
            sawNonNumeric = true;
            continue;
        }
        const s = String(v).trim();
        if (INT_RE.test(s)) {
            intOk++;
            realEnOk++;
            realDeOk++;
            continue;
        }
        const en = coerceNumberEn(s);
        const de = coerceNumberDe(s);
        if (en !== null) realEnOk++;
        if (de !== null) realDeOk++;
        if (en === null && de === null) {
            // Plain ambiguous like "1,5" still passes en (point only) — no.
            // The ambiguous test catches the "no thousands" case where the
            // value is consistent with either parser. Score both.
            if (REAL_AMBIG_RE.test(s)) {
                realEnOk++;
                realDeOk++;
                if (s.includes(',')) hasComma = true;
                if (s.includes('.')) hasPoint = true;
            } else {
                sawNonNumeric = true;
            }
        } else {
            if (s.includes(',')) hasComma = true;
            if (s.includes('.')) hasPoint = true;
        }
    }

    if (nonNull === 0) return { sqlType: 'TEXT', decimal: 'none' };
    if (sawNonNumeric) return { sqlType: 'TEXT', decimal: 'none' };

    if (intOk === nonNull) return { sqlType: 'INTEGER', decimal: 'none' };

    if (sawTypedNumber && !sawTypedInt && realEnOk === nonNull) {
        return { sqlType: 'REAL', decimal: 'point' };
    }

    if (realEnOk === nonNull && realDeOk === nonNull) {
        // Both parsers accept every value → choose by which separator
        // actually shows up. If both, prefer en (point=decimal).
        if (hasPoint && !hasComma) return { sqlType: 'REAL', decimal: 'point' };
        if (hasComma && !hasPoint) return { sqlType: 'REAL', decimal: 'comma' };
        return { sqlType: 'REAL', decimal: 'point' };
    }
    if (realEnOk === nonNull) return { sqlType: 'REAL', decimal: 'point' };
    if (realDeOk === nonNull) return { sqlType: 'REAL', decimal: 'comma' };

    return { sqlType: 'TEXT', decimal: 'none' };
}

/**
 * Coerce a single cell value given a column sniff. Returns the value
 * suitable for binding to a sqlite prepared statement. Strings that
 * fail coercion fall back to the original string.
 */
export function coerceCell(
    value: unknown,
    sniff: ColumnSniff,
): string | number | null {
    if (isNullish(value)) return null;
    if (sniff.sqlType === 'TEXT') {
        return typeof value === 'string' ? value : String(value);
    }
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value === 'boolean') return value ? 1 : 0;
    const s = String(value).trim();
    if (s === '') return null;
    if (sniff.sqlType === 'INTEGER') {
        if (INT_RE.test(s)) {
            const n = Number(s);
            return Number.isFinite(n) ? n : s;
        }
        return s;
    }
    const n = sniff.decimal === 'comma' ? coerceNumberDe(s) : coerceNumberEn(s);
    return n ?? s;
}
