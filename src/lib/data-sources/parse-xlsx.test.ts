import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { parseXlsx } from './parse-xlsx';

/**
 * Test strategy:
 *
 *  We build small worksheets cell-by-cell (setting `t`, `v`, and `z`
 *  explicitly so we control number-format strings), write them out via
 *  `XLSX.write` to an ArrayBuffer, and then feed that buffer through
 *  `parseXlsx`. The round-trip through write→read is what makes
 *  `cell.w` (the formatted display string) reliably present — SheetJS
 *  fills it in during read using the format in `cell.z`.
 *
 *  This mirrors what real .xlsx files look like coming from Excel /
 *  Numbers and exercises the same decode path users hit in production.
 */

function buildSheet(
    name: string,
    cells: Record<string, XLSX.CellObject>,
    ref: string,
): XLSX.WorkBook {
    const ws: XLSX.WorkSheet = { '!ref': ref, ...cells };
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, name);
    return wb;
}

// Patched SheetJS (contrib/sheetjs) expects opts.xlsxCss to be a
// defined object — its `write_sty_xml` reads `css.numFmts` etc.
// without a falsy guard. We pass `{}` so the default XML stubs apply.
type WritingOptionsWithCss = XLSX.WritingOptions & { xlsxCss?: object };

function toBuffer(wb: XLSX.WorkBook): ArrayBuffer {
    return XLSX.write(wb, {
        bookType: 'xlsx',
        type: 'array',
        xlsxCss: {},
    } as WritingOptionsWithCss) as ArrayBuffer;
}

describe('parseXlsx — basic cell types', () => {
    it('keeps plain strings as strings', () => {
        const wb = buildSheet(
            'S1',
            {
                A1: { t: 's', v: 'name' },
                A2: { t: 's', v: 'alice' },
                A3: { t: 's', v: 'bob' },
            },
            'A1:A3',
        );
        const sheets = parseXlsx(toBuffer(wb));
        expect(sheets).toHaveLength(1);
        expect(sheets[0]!.sheetName).toBe('S1');
        expect(sheets[0]!.headers).toEqual(['name']);
        expect(sheets[0]!.rows).toEqual([['alice'], ['bob']]);
    });

    it('keeps plain integers as numbers', () => {
        const wb = buildSheet(
            'Nums',
            {
                A1: { t: 's', v: 'count' },
                A2: { t: 'n', v: 1 },
                A3: { t: 'n', v: 42 },
                A4: { t: 'n', v: -7 },
            },
            'A1:A4',
        );
        const { rows } = parseXlsx(toBuffer(wb))[0]!;
        expect(rows).toEqual([[1], [42], [-7]]);
        for (const row of rows) expect(typeof row[0]).toBe('number');
    });

    it('keeps plain floats as numbers (no currency/date format)', () => {
        const wb = buildSheet(
            'Floats',
            {
                A1: { t: 's', v: 'amount' },
                A2: { t: 'n', v: 0.5 }, // no format → stays numeric
                A3: { t: 'n', v: 1234.56 },
            },
            'A1:A3',
        );
        const { rows } = parseXlsx(toBuffer(wb))[0]!;
        expect(rows).toEqual([[0.5], [1234.56]]);
    });

    it('keeps currency-formatted numbers as numbers', () => {
        const wb = buildSheet(
            'Curr',
            {
                A1: { t: 's', v: 'price' },
                A2: { t: 'n', v: 19.99, z: '"$"#,##0.00' },
                A3: { t: 'n', v: 1234.5, z: '0.00' },
            },
            'A1:A3',
        );
        const { rows } = parseXlsx(toBuffer(wb))[0]!;
        // Currency / general-decimal formats DO NOT contain date/time
        // tokens — the parser must keep numeric values numeric.
        expect(typeof rows[0]![0]).toBe('number');
        expect(typeof rows[1]![0]).toBe('number');
        expect(rows[0]![0]).toBeCloseTo(19.99);
        expect(rows[1]![0]).toBeCloseTo(1234.5);
    });

    it('keeps booleans as booleans', () => {
        const wb = buildSheet(
            'Bools',
            {
                A1: { t: 's', v: 'flag' },
                A2: { t: 'b', v: true },
                A3: { t: 'b', v: false },
            },
            'A1:A3',
        );
        const { rows } = parseXlsx(toBuffer(wb))[0]!;
        expect(rows).toEqual([[true], [false]]);
    });
});

describe('parseXlsx — date/time display fidelity', () => {
    it('returns date formatted display string, NOT the underlying serial', () => {
        // Excel serial 45427 = 2024-05-15 (default Excel 1900 epoch).
        const wb = buildSheet(
            'Dates',
            {
                A1: { t: 's', v: 'when' },
                A2: { t: 'n', v: 45427, z: 'm/d/yyyy' },
                A3: { t: 'n', v: 45428, z: 'yyyy-mm-dd' },
            },
            'A1:A3',
        );
        const { rows } = parseXlsx(toBuffer(wb))[0]!;
        expect(rows).toHaveLength(2);
        // We don't pin the exact locale of the m/d/yyyy formatter (Excel
        // produces "5/15/2024" in en-US); just assert it's a string that
        // looks like a date, and is NOT the numeric serial.
        expect(typeof rows[0]![0]).toBe('string');
        expect(typeof rows[1]![0]).toBe('string');
        expect(rows[0]![0]).not.toBe(45427);
        expect(rows[1]![0]).not.toBe(45428);
        expect(rows[0]![0]).toMatch(/2024/);
        expect(rows[1]![0]).toMatch(/2024-05-1[56]/);
    });

    it('returns TIME formatted display string for fractional times (the original bug)', () => {
        // Time-only cells in Excel are stored as fractions of a day:
        // 0.0   = 00:00:00
        // 0.25  = 06:00:00
        // 0.5   = 12:00:00
        // 0.75  = 18:00:00
        // The old `raw:true` path would surface these as 0.5 etc. — the
        // bug this parser fixes.
        const wb = buildSheet(
            'Times',
            {
                A1: { t: 's', v: 'when' },
                A2: { t: 'n', v: 0.25, z: 'h:mm:ss' },
                A3: { t: 'n', v: 0.5, z: 'h:mm:ss' },
                A4: { t: 'n', v: 0.75, z: 'h:mm:ss' },
            },
            'A1:A4',
        );
        const { rows } = parseXlsx(toBuffer(wb))[0]!;
        expect(rows).toHaveLength(3);
        for (const row of rows) {
            expect(typeof row[0]).toBe('string');
            // Never leak the raw fraction.
            expect(row[0]).not.toBe(0.25);
            expect(row[0]).not.toBe(0.5);
            expect(row[0]).not.toBe(0.75);
            // Loose check: the display string contains a colon, as any
            // `h:mm:ss` rendering does.
            expect(row[0] as string).toMatch(/\d+:\d+/);
        }
        // Spot-check the middle one renders as noon.
        expect(rows[1]![0]).toMatch(/12:00/);
    });

    it('returns datetime display string for combined date+time formats', () => {
        const wb = buildSheet(
            'DT',
            {
                A1: { t: 's', v: 'when' },
                // 45427.5 = 2024-05-15 12:00:00
                A2: { t: 'n', v: 45427.5, z: 'yyyy-mm-dd h:mm' },
            },
            'A1:A2',
        );
        const { rows } = parseXlsx(toBuffer(wb))[0]!;
        expect(typeof rows[0]![0]).toBe('string');
        expect(rows[0]![0]).toMatch(/2024-05-1[56]/);
        expect(rows[0]![0]).toMatch(/12:00/);
    });

    it('handles duration brackets like [h]:mm:ss as display strings', () => {
        const wb = buildSheet(
            'Dur',
            {
                A1: { t: 's', v: 'elapsed' },
                // 1.5 days = 36 hours; with [h]:mm renders as "36:00".
                A2: { t: 'n', v: 1.5, z: '[h]:mm' },
            },
            'A1:A2',
        );
        const { rows } = parseXlsx(toBuffer(wb))[0]!;
        expect(typeof rows[0]![0]).toBe('string');
        expect(rows[0]![0]).not.toBe(1.5);
    });

    it('respects per-cell formats independently (mixed format column)', () => {
        // A column where the user has formatted some cells as dates and
        // others as plain numbers. Each cell should be decoded according
        // to its own `z`, not the column's first cell.
        const wb = buildSheet(
            'Mixed',
            {
                A1: { t: 's', v: 'value' },
                A2: { t: 'n', v: 45427, z: 'm/d/yyyy' }, // date
                A3: { t: 'n', v: 42 }, // plain number, no format
                A4: { t: 'n', v: 0.5, z: 'h:mm:ss' }, // time
            },
            'A1:A4',
        );
        const { rows } = parseXlsx(toBuffer(wb))[0]!;
        expect(typeof rows[0]![0]).toBe('string'); // formatted date
        expect(typeof rows[1]![0]).toBe('number'); // plain int stays numeric
        expect(rows[1]![0]).toBe(42);
        expect(typeof rows[2]![0]).toBe('string'); // formatted time
    });
});

describe('parseXlsx — headers + empty cells', () => {
    it('strips header whitespace', () => {
        const wb = buildSheet(
            'H',
            {
                A1: { t: 's', v: '  Name  ' },
                B1: { t: 's', v: 'Age' },
                A2: { t: 's', v: 'x' },
                B2: { t: 'n', v: 1 },
            },
            'A1:B2',
        );
        const { headers } = parseXlsx(toBuffer(wb))[0]!;
        expect(headers).toEqual(['Name', 'Age']);
    });

    it('substitutes col_N for empty header cells', () => {
        const wb = buildSheet(
            'H2',
            {
                A1: { t: 's', v: 'first' },
                // B1 missing entirely
                C1: { t: 's', v: 'third' },
                A2: { t: 's', v: 'a' },
                B2: { t: 'n', v: 1 },
                C2: { t: 's', v: 'c' },
            },
            'A1:C2',
        );
        const { headers, rows } = parseXlsx(toBuffer(wb))[0]!;
        expect(headers).toEqual(['first', 'col_2', 'third']);
        expect(rows).toEqual([['a', 1, 'c']]);
    });

    it('emits null for missing cells in data rows', () => {
        const wb = buildSheet(
            'Sparse',
            {
                A1: { t: 's', v: 'a' },
                B1: { t: 's', v: 'b' },
                A2: { t: 's', v: 'x' },
                // B2 missing → null
                A3: { t: 's', v: 'y' },
                B3: { t: 's', v: 'z' },
            },
            'A1:B3',
        );
        const { rows } = parseXlsx(toBuffer(wb))[0]!;
        expect(rows).toEqual([
            ['x', null],
            ['y', 'z'],
        ]);
    });

    it('skips fully-blank rows (blankrows: false equivalent)', () => {
        const wb = buildSheet(
            'Blanks',
            {
                A1: { t: 's', v: 'a' },
                A2: { t: 's', v: 'x' },
                // Row 3 deliberately empty
                A4: { t: 's', v: 'y' },
            },
            'A1:A4',
        );
        const { rows } = parseXlsx(toBuffer(wb))[0]!;
        // The fully-empty row between should not appear.
        expect(rows).toEqual([['x'], ['y']]);
    });
});

describe('parseXlsx — workbook shape', () => {
    it('returns one entry per sheet, in workbook order', () => {
        const wb = XLSX.utils.book_new();
        const wsA: XLSX.WorkSheet = {
            '!ref': 'A1:A2',
            A1: { t: 's', v: 'name' },
            A2: { t: 's', v: 'alpha' },
        };
        const wsB: XLSX.WorkSheet = {
            '!ref': 'A1:A2',
            A1: { t: 's', v: 'val' },
            A2: { t: 'n', v: 7 },
        };
        XLSX.utils.book_append_sheet(wb, wsA, 'FirstSheet');
        XLSX.utils.book_append_sheet(wb, wsB, 'SecondSheet');
        const sheets = parseXlsx(toBuffer(wb));
        expect(sheets.map((s) => s.sheetName)).toEqual(['FirstSheet', 'SecondSheet']);
        expect(sheets[0]!.rows).toEqual([['alpha']]);
        expect(sheets[1]!.rows).toEqual([[7]]);
    });

    it('returns an empty parse for a sheet with no !ref', () => {
        const wb = XLSX.utils.book_new();
        // An empty worksheet (no cells, no ref).
        XLSX.utils.book_append_sheet(wb, {} as XLSX.WorkSheet, 'Empty');
        const sheets = parseXlsx(toBuffer(wb));
        expect(sheets).toHaveLength(1);
        expect(sheets[0]!.headers).toEqual([]);
        expect(sheets[0]!.rows).toEqual([]);
    });
});
