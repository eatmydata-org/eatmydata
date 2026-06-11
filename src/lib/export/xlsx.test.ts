import * as zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { rowsToXlsxBytes, type ColumnSpec } from './xlsx';

const SAMPLE_ROWS = [
    { id: 1, name: 'Widget', qty: 42, price: 9.99 },
    { id: 2, name: 'Gadget', qty: 7, price: 19.5 },
    { id: 3, name: 'Sprocket', qty: 128, price: 0.85 },
];

function readZipEntry(buf: Uint8Array, name: string): string {
    const u8 = buf;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    for (let i = 0; i < u8.length - 4; i++) {
        if (u8[i] === 0x50 && u8[i + 1] === 0x4b && u8[i + 2] === 0x03 && u8[i + 3] === 0x04) {
            const method = dv.getUint16(i + 8, true);
            const compSize = dv.getUint32(i + 18, true);
            const nameLen = dv.getUint16(i + 26, true);
            const extraLen = dv.getUint16(i + 28, true);
            const entryName = new TextDecoder().decode(u8.subarray(i + 30, i + 30 + nameLen));
            const dataStart = i + 30 + nameLen + extraLen;
            const dataEnd = dataStart + compSize;
            if (entryName === name) {
                const compData = u8.subarray(dataStart, dataEnd);
                const raw = method === 8 ? new Uint8Array(zlib.inflateRawSync(compData)) : compData;
                return new TextDecoder().decode(raw);
            }
            i = dataEnd - 1;
        }
    }
    throw new Error(`entry ${name} not found in zip`);
}

describe('rowsToXlsxBytes (plain)', () => {
    it('emits a non-empty xlsx-shaped (PK\\x03\\x04) buffer', () => {
        const bytes = rowsToXlsxBytes(SAMPLE_ROWS);
        expect(bytes.length).toBeGreaterThan(0);
        expect(bytes[0]).toBe(0x50);
        expect(bytes[1]).toBe(0x4b);
        expect(bytes[2]).toBe(0x03);
        expect(bytes[3]).toBe(0x04);
    });

    it('round-trips rows verbatim through XLSX.read', () => {
        const bytes = rowsToXlsxBytes(SAMPLE_ROWS);
        const wb = XLSX.read(bytes, { type: 'buffer' });
        const sheet = wb.Sheets[wb.SheetNames[0]!]!;
        const rows = XLSX.utils.sheet_to_json(sheet);
        expect(rows).toEqual(SAMPLE_ROWS);
    });

    it('uses the supplied sheet name', () => {
        const bytes = rowsToXlsxBytes(SAMPLE_ROWS, { sheetName: 'Inventory' });
        const wb = XLSX.read(bytes, { type: 'buffer' });
        expect(wb.SheetNames).toEqual(['Inventory']);
    });

    it('handles an empty row set without throwing', () => {
        const bytes = rowsToXlsxBytes([]);
        expect(bytes.length).toBeGreaterThan(0);
        const wb = XLSX.read(bytes, { type: 'buffer' });
        const sheet = wb.Sheets[wb.SheetNames[0]!]!;
        expect(XLSX.utils.sheet_to_json(sheet)).toEqual([]);
    });
});

describe('rowsToXlsxBytes (styled)', () => {
    const COLUMNS: ColumnSpec[] = [
        { key: 'id', header: 'ID', width: 6, numFmt: '0' },
        { key: 'name', header: 'Name', width: 18 },
        { key: 'qty', header: 'Qty', width: 8, numFmt: '#,##0' },
        { key: 'price', header: 'Price', width: 10, numFmt: '0.00' },
    ];

    function styledBytes() {
        return rowsToXlsxBytes(SAMPLE_ROWS, { columns: COLUMNS });
    }

    it('emits our custom <fonts> palette including the bold header font', () => {
        const styles = readZipEntry(styledBytes(), 'xl/styles.xml');
        expect(styles).toMatch(/<fonts count="2">/);
        expect(styles).toMatch(/<font><sz val="12"\/>.*<b\/><\/font>/);
    });

    it('emits our custom <fills> palette including the header solid fill', () => {
        const styles = readZipEntry(styledBytes(), 'xl/styles.xml');
        expect(styles).toMatch(/<fills count="3">/);
        expect(styles).toMatch(/<fill><patternFill patternType="solid"><fgColor rgb="FFE2E8F0"\/>/);
    });

    it('emits custom <numFmts> entries at numFmtId 164+', () => {
        const styles = readZipEntry(styledBytes(), 'xl/styles.xml');
        expect(styles).toMatch(/<numFmt numFmtId="164" formatCode="0"\/>/);
        expect(styles).toMatch(/<numFmt numFmtId="165" formatCode="0\.00"\/>/);
        expect(styles).toMatch(/<numFmt numFmtId="167" formatCode="#,##0"\/>/);
    });

    it('dedups cellXfs (regression for get_cell_style/style_equals fix)', () => {
        const styles = readZipEntry(styledBytes(), 'xl/styles.xml');
        const xfCount = (styles.match(/<xf\b/g) || []).length;
        expect(xfCount).toBeLessThan(10);
    });

    it('never leaks JS undefined into XML attributes', () => {
        const styles = readZipEntry(styledBytes(), 'xl/styles.xml');
        expect(styles).not.toMatch(/="undefined"/);
    });

    it('emits <cols> with customWidth for each spec', () => {
        const sheet = readZipEntry(styledBytes(), 'xl/worksheets/sheet1.xml');
        expect(sheet).toMatch(/<cols>/);
        expect(sheet).toMatch(/<col[^/]*customWidth="1"/);
    });

    it('omits <cols> entirely when no column specifies a width (Excel-for-Mac blank-grid regression)', () => {
        // The result-grid export passes `{ key, header }` with no width. A
        // width-less `<col min max/>` is read by Excel for Mac as a hidden,
        // zero-width column, so every column rendered invisible (blank grid)
        // while the data was actually present. Assert we emit no `<cols>` block
        // — and in particular no width-less `<col>` — in that case.
        const noWidthCols: ColumnSpec[] = [
            { key: 'id', header: 'ID' },
            { key: 'name', header: 'Name' },
        ];
        const sheet = readZipEntry(
            rowsToXlsxBytes(SAMPLE_ROWS, { columns: noWidthCols }),
            'xl/worksheets/sheet1.xml',
        );
        expect(sheet).not.toMatch(/<cols>/);
        expect(sheet).not.toMatch(/<col\b[^>]*\/>/);
    });

    it('still emits <col> only for width-bearing columns in a mixed set', () => {
        const mixed: ColumnSpec[] = [
            { key: 'id', header: 'ID' }, // no width -> no <col>
            { key: 'name', header: 'Name', width: 18 }, // width -> <col>
        ];
        const sheet = readZipEntry(
            rowsToXlsxBytes(SAMPLE_ROWS, { columns: mixed }),
            'xl/worksheets/sheet1.xml',
        );
        // exactly one <col>, and it carries a width (never a bare width-less col)
        const colTags = sheet.match(/<col\b[^>]*\/>/g) ?? [];
        expect(colTags).toHaveLength(1);
        expect(colTags[0]).toMatch(/customWidth="1"/);
    });

    it('header row cells reference an xf with our bold-header fontId', () => {
        const bytes = styledBytes();
        const sheet = readZipEntry(bytes, 'xl/worksheets/sheet1.xml');
        const styles = readZipEntry(bytes, 'xl/styles.xml');

        const headerRow = sheet.match(/<row r="1"[^>]*>(.*?)<\/row>/)?.[1] ?? '';
        const firstCellMatch = headerRow.match(/<c r="A1"[^>]*s="(\d+)"/);
        expect(firstCellMatch).not.toBeNull();
        const sIdx = Number(firstCellMatch![1]);

        const cellXfsBlock = styles.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] ?? '';
        const xfs = cellXfsBlock.match(/<xf\b[^/]*\/?>/g) ?? [];
        const headerXf = xfs[sIdx];
        expect(headerXf).toBeDefined();
        expect(headerXf!).toMatch(/fontId="1"/);
        expect(headerXf!).toMatch(/fillId="2"/);
    });

    it('round-trips the data values (styling does not corrupt cells)', () => {
        const wb = XLSX.read(styledBytes(), { type: 'buffer' });
        const sheet = wb.Sheets[wb.SheetNames[0]!]!;
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
        expect(rows[0]).toEqual(['ID', 'Name', 'Qty', 'Price']);
        expect(rows[1]).toEqual([1, 'Widget', 42, 9.99]);
        expect(rows[3]).toEqual([3, 'Sprocket', 128, 0.85]);
    });
});
