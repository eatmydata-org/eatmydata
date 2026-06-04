import * as XLSX from 'xlsx';
import { getSourceDb } from './db';
import type { DataSource } from './types';

/**
 * Export a single table or view as XLSX. Returns the bytes; the caller
 * is responsible for triggering the browser download. Kept as a thin
 * wrapper around SheetJS — we don't apply any of the styled-export
 * machinery from `src/lib/export/xlsx.ts` here because this is a raw
 * data dump, not a polished report.
 *
 * The XLSX sheet name must be ≤31 chars and can't contain `:\/?*[]`;
 * we slice and substitute to stay legal.
 */
export async function exportTableToXlsxBytes(
    source: DataSource,
    tableName: string,
): Promise<Uint8Array> {
    const db = await getSourceDb(source);
    const safe = tableName.replace(/"/g, '""');
    // Hard cap: a million rows. Caller is the data-sources UI, which
    // already shows totals to the user — they'll know if they're going
    // to bump up against this.
    const res = await db.execRaw(`SELECT * FROM "${safe}"`, 1_000_000);

    const aoa: unknown[][] = [res.columns.slice()];
    for (const row of res.rows) {
        aoa.push(res.columns.map((c) => row[c] ?? null));
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    const sheetName = sanitizeSheetName(tableName);
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
    // The patched SheetJS write path expects opts.xlsxCss to be a
    // defined object. `{}` falls through to the default XML stubs
    // — we're not styling this raw data dump.
    const buf = XLSX.write(wb, {
        bookType: 'xlsx',
        type: 'array',
        xlsxCss: {},
    } as XLSX.WritingOptions & { xlsxCss: object });
    return new Uint8Array(buf as ArrayBuffer);
}

/**
 * Drive an in-browser download of the export. Cleans up the object URL
 * after the click so we don't leak it.
 */
export function downloadBytes(
    bytes: Uint8Array,
    filename: string,
    mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
): void {
    // TS in lib.dom now narrows Uint8Array<ArrayBufferLike> away from
    // BlobPart due to SharedArrayBuffer possibility. We allocated the
    // buffer ourselves above so it's a plain ArrayBuffer.
    const blob = new Blob([bytes as BlobPart], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Defer revoke so Safari has time to start the download.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function sanitizeSheetName(name: string): string {
    const cleaned = name.replace(/[:\\/?*[\]]/g, '_');
    return cleaned.slice(0, 31) || 'data';
}
