import Papa from 'papaparse';

export type CsvParseOptions = {
    delimiter?: string;
    /** Treat the first row as headers. Defaults to true. */
    header?: boolean;
};

export type CsvParseResult = {
    headers: string[];
    rows: string[][];
    /** What papaparse picked when delimiter was auto-detected. */
    delimiter: string;
    /** Any parse errors papaparse reported (we tolerate them). */
    warnings: string[];
};

/**
 * Parse a CSV/TSV. We trust papaparse's delimiter detector — it scores
 * `, ; \t |` and picks the most consistent one. The caller can also
 * override via `options.delimiter` when the user manually picks one.
 *
 * Output is always a string-matrix; type sniffing happens in the next
 * stage so the caller can change the delimiter and re-sniff without
 * re-reading the file.
 */
export function parseCsv(
    text: string,
    options: CsvParseOptions = {},
): CsvParseResult {
    const header = options.header !== false;
    const res = Papa.parse<string[]>(text, {
        delimiter: options.delimiter ?? '',
        skipEmptyLines: 'greedy',
        header: false,
        dynamicTyping: false,
    });

    const data = (res.data ?? []) as string[][];
    let headers: string[] = [];
    let rows: string[][] = data;
    if (header && data.length > 0) {
        headers = data[0]!.map((h) => String(h ?? '').trim());
        rows = data.slice(1);
    } else {
        const w = data[0]?.length ?? 0;
        headers = Array.from({ length: w }, (_, i) => `col_${i + 1}`);
    }

    const warnings = (res.errors ?? []).map(
        (e) => `row ${e.row}: ${e.message}`,
    );

    return {
        headers,
        rows,
        delimiter: (res.meta?.delimiter as string) ?? ',',
        warnings,
    };
}
