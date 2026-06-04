import * as XLSX from 'xlsx';

export type NumFmt =
    | '0'
    | '0.00'
    | '0.0%'
    | '#,##0'
    | '#,##0.00'
    | 'yyyy-mm-dd'
    | 'yyyy-mm-dd hh:mm';

export type ColumnSpec = {
    key: string;
    header?: string;
    width?: number;
    numFmt?: NumFmt;
};

export type SheetExportOptions = {
    sheetName?: string;
    columns?: ColumnSpec[];
    boldHeader?: boolean;
    headerBg?: boolean;
};

type XlsxFont = {
    size: number;
    color: { theme?: number; rgb?: string };
    name: string;
    family: number;
    scheme: 'minor' | 'major';
    bold?: boolean;
};

type XlsxFill = {
    patternType: 'none' | 'gray125' | 'solid';
    fgColor?: { rgb: string };
};

const DEFAULT_FONT_ID = 0;
const BOLD_HEADER_FONT_ID = 1;

const FONTS: XlsxFont[] = [
    { size: 12, color: { theme: 1 }, name: 'Calibri', family: 2, scheme: 'minor' },
    {
        size: 12,
        color: { theme: 1 },
        name: 'Calibri',
        family: 2,
        scheme: 'minor',
        bold: true,
    },
];

const HEADER_FILL_ID = 2;

const FILLS: XlsxFill[] = [
    { patternType: 'none' },
    { patternType: 'gray125' },
    { patternType: 'solid', fgColor: { rgb: 'FFE2E8F0' } },
];

const NUMFMTS = [
    '0',
    '0.00',
    '0.0%',
    '#,##0',
    '#,##0.00',
    'yyyy-mm-dd',
    'yyyy-mm-dd hh:mm',
] as const satisfies readonly NumFmt[];

const FORMAT_ID_BASE = 164;

function numFmtIdOf(fmt: NumFmt): number {
    const idx = NUMFMTS.indexOf(fmt);
    return FORMAT_ID_BASE + idx;
}

function escapeAttr(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function fontXml(f: XlsxFont): string {
    const parts: string[] = [`<sz val="${f.size}"/>`];
    if (f.color.theme !== undefined) parts.push(`<color theme="${f.color.theme}"/>`);
    else if (f.color.rgb) parts.push(`<color rgb="${f.color.rgb}"/>`);
    parts.push(`<name val="${f.name}"/>`);
    parts.push(`<family val="${f.family}"/>`);
    parts.push(`<scheme val="${f.scheme}"/>`);
    if (f.bold) parts.push('<b/>');
    return `<font>${parts.join('')}</font>`;
}

function fillXml(f: XlsxFill): string {
    if (f.patternType === 'solid' && f.fgColor) {
        return `<fill><patternFill patternType="solid"><fgColor rgb="${f.fgColor.rgb}"/><bgColor indexed="64"/></patternFill></fill>`;
    }
    return `<fill><patternFill patternType="${f.patternType}"/></fill>`;
}

function fontsXml(): string {
    return `<fonts count="${FONTS.length}">${FONTS.map(fontXml).join('')}</fonts>`;
}

function fillsXml(): string {
    return `<fills count="${FILLS.length}">${FILLS.map(fillXml).join('')}</fills>`;
}

function numFmtsXml(): string {
    return `<numFmts count="${NUMFMTS.length}">${NUMFMTS.map(
        (fmt, i) =>
            `<numFmt numFmtId="${FORMAT_ID_BASE + i}" formatCode="${escapeAttr(fmt)}"/>`,
    ).join('')}</numFmts>`;
}

const XLSX_CSS = {
    numFmts: () => numFmtsXml(),
    fonts: () => fontsXml(),
    fills: () => fillsXml(),
};

type WritingOptionsWithCss = XLSX.WritingOptions & { xlsxCss?: typeof XLSX_CSS };

function buildWorkbook(
    rows: Record<string, unknown>[],
    opts: SheetExportOptions,
): XLSX.WorkBook {
    const sheetName = opts.sheetName ?? 'Sheet1';
    const cols = opts.columns;

    let ws: XLSX.WorkSheet;
    if (cols && cols.length > 0) {
        const headers = cols.map((c) => c.header ?? c.key);
        const data = rows.map((row) => cols.map((c) => row[c.key] ?? null));
        ws = XLSX.utils.aoa_to_sheet([headers, ...data]);

        ws['!cols'] = cols.map((c) =>
            c.width !== undefined ? { wch: c.width } : {},
        );

        const wantBold = opts.boldHeader !== false;
        const wantBg = opts.headerBg !== false;
        if (wantBold || wantBg) {
            const headerStyle: Record<string, number> = {};
            if (wantBold) headerStyle.fontId = BOLD_HEADER_FONT_ID;
            if (wantBg) headerStyle.fillId = HEADER_FILL_ID;
            for (let c = 0; c < cols.length; c++) {
                const addr = XLSX.utils.encode_cell({ c, r: 0 });
                const cell = ws[addr] as XLSX.CellObject | undefined;
                if (cell) cell.s = { ...headerStyle };
            }
        }

        cols.forEach((spec, c) => {
            if (!spec.numFmt) return;
            const numFmtId = numFmtIdOf(spec.numFmt);
            for (let r = 1; r <= rows.length; r++) {
                const addr = XLSX.utils.encode_cell({ c, r });
                const cell = ws[addr] as XLSX.CellObject | undefined;
                if (cell) {
                    const prev = (cell.s as Record<string, unknown> | undefined) ?? {};
                    cell.s = { ...prev, numFmtId, fontId: DEFAULT_FONT_ID };
                }
            }
        });
    } else {
        ws = XLSX.utils.json_to_sheet(rows);
    }

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
    return wb;
}

export function rowsToXlsxBytes(
    rows: Record<string, unknown>[],
    opts: SheetExportOptions = {},
): Uint8Array {
    return XLSX.write(buildWorkbook(rows, opts), {
        type: 'buffer',
        bookType: 'xlsx',
        xlsxCss: XLSX_CSS,
    } as WritingOptionsWithCss) as Uint8Array;
}

export function exportRowsToXlsx(
    rows: Record<string, unknown>[],
    filename: string,
    opts: SheetExportOptions = {},
) {
    XLSX.writeFile(buildWorkbook(rows, opts), filename, {
        bookType: 'xlsx',
        xlsxCss: XLSX_CSS,
    } as WritingOptionsWithCss);
}
