import * as XLSX from 'xlsx';

export type XlsxSheetParse = {
    sheetName: string;
    headers: string[];
    rows: unknown[][];
};

/**
 * Parse all sheets of an XLSX (or .xls) workbook. Each sheet is treated
 * as an independent table — callers may import all of them or skip some
 * via the staging dialog.
 *
 * Display-faithful cell decoding:
 *  - Date / datetime / time cells emit the **formatted display string**
 *    Excel shows the user (cell.w), not the underlying serial number.
 *    This is critical for time-only cells where the storage form is a
 *    fraction in [0,1) — users expect to see "10:30:00", not 0.4375.
 *  - Plain number cells stay as numbers so the type-sniffer can
 *    classify them INTEGER/REAL.
 *  - Strings, booleans, errors → their natural JS values.
 *
 * To get reliable `cell.w` and cell-type info we read with
 * `cellDates: true, cellNF: true, cellStyles: false`. Reading `cellNF`
 * keeps the per-cell number format string (`cell.z`) so we can tell
 * "date formatted as h:mm:ss" apart from "currency formatted as $0.00".
 */
export function parseXlsx(buffer: ArrayBuffer): XlsxSheetParse[] {
    const wb = XLSX.read(new Uint8Array(buffer), {
        type: 'array',
        cellDates: true,
        cellNF: true,
    });
    const out: XlsxSheetParse[] = [];
    for (const sheetName of wb.SheetNames) {
        const ws = wb.Sheets[sheetName];
        if (!ws) continue;
        const ref = ws['!ref'];
        if (!ref) {
            out.push({ sheetName, headers: [], rows: [] });
            continue;
        }
        const range = XLSX.utils.decode_range(ref);
        const numCols = range.e.c - range.s.c + 1;
        if (numCols <= 0) {
            out.push({ sheetName, headers: [], rows: [] });
            continue;
        }

        // First row → headers.
        const headers: string[] = [];
        for (let c = 0; c < numCols; c++) {
            const addr = XLSX.utils.encode_cell({
                r: range.s.r,
                c: range.s.c + c,
            });
            const cell = ws[addr];
            const display = cell
                ? cell.w ?? (cell.v == null ? '' : String(cell.v))
                : '';
            const trimmed = display.trim();
            headers.push(trimmed === '' ? `col_${c + 1}` : trimmed);
        }

        const rows: unknown[][] = [];
        for (let r = range.s.r + 1; r <= range.e.r; r++) {
            const row = new Array<unknown>(numCols);
            let allNull = true;
            for (let c = 0; c < numCols; c++) {
                const addr = XLSX.utils.encode_cell({
                    r,
                    c: range.s.c + c,
                });
                const cell = ws[addr];
                const value = cell ? decodeCell(cell) : null;
                if (value !== null) allNull = false;
                row[c] = value;
            }
            // Match sheet_to_json's blankrows:false behaviour.
            if (!allNull) rows.push(row);
        }

        out.push({ sheetName, headers, rows });
    }
    return out;
}

/**
 * Decode one cell to the value we'll store in sqlite. Priority:
 *  1. Date cells (`t === 'd'`) → formatted display string.
 *  2. Number cells whose format is a date/time/duration → display string.
 *  3. Booleans → JS booleans (the sniffer maps these to INTEGER 0/1).
 *  4. Numbers, strings → raw `v`.
 *  5. Empty / missing → null.
 */
function decodeCell(cell: XLSX.CellObject): unknown {
    if (cell.v === undefined && cell.w === undefined) return null;

    if (cell.t === 'd') {
        // SheetJS hands us a JS Date when cellDates:true. We prefer the
        // sheet's own formatted text so the user sees exactly what Excel
        // showed; fall back to ISO-ish if no formatted text is present.
        if (cell.w) return cell.w;
        if (cell.v instanceof Date) return cell.v.toISOString();
        return String(cell.v);
    }

    if (cell.t === 'n') {
        if (cell.z && isDateOrTimeFormat(String(cell.z))) {
            return cell.w ?? (cell.v == null ? null : String(cell.v));
        }
        return typeof cell.v === 'number' ? cell.v : Number(cell.v);
    }

    if (cell.t === 'b') return Boolean(cell.v);

    // Strings (t='s'), shared strings, formulas with string result, errors.
    // For errors we fall back to the formatted text Excel would show.
    if (cell.t === 'e') return cell.w ?? String(cell.v ?? '');

    return cell.v ?? null;
}

/**
 * Cheap heuristic: does this Excel number-format token look like a
 * date / time / duration format? We strip text-in-quotes (because
 * formats can legitimately embed words like "Year") and then look for
 * any of the date-or-time placeholder letters or duration brackets.
 *
 * False positives are cheap (we just display a string instead of a
 * number), false negatives mean times leak through as 0.4375 — so this
 * leans permissive.
 */
function isDateOrTimeFormat(z: string): boolean {
    if (!z) return false;
    const stripped = z.replace(/"[^"]*"/g, '').replace(/\\./g, '');
    if (/\[hms\]/i.test(stripped)) return true; // duration brackets
    if (/am\/pm|a\/p/i.test(stripped)) return true;
    // y/d/h/s = year/day/hour/second placeholders. We deliberately do
    // NOT include lone 'm' because it overlaps with month-vs-minute
    // ambiguity AND with currency formats like "0.00m" (rare but real).
    return /[yYdDhHsS]/.test(stripped);
}
