import type { DemoAbout } from './types';

/**
 * Contoso — Microsoft's fictional retail chain used heavily in the
 * Power BI / Fabric / Azure data tutorials. SQL BI maintains a modern
 * "V2" generator that produces consistent star-schema CSVs at multiple
 * row scales. Our pipeline downloads the 100K CSV bundle pinned to a
 * specific release tag and imports it into SQLite via the `sqlite3`
 * CLI's `.import` (see `scripts/build-demo-contoso.sh`).
 *
 * Opt-in dependency: the upstream archive is .7z-compressed; building
 * Contoso needs a 7z extractor (`brew install sevenzip` on macOS). The
 * other demos build without it.
 */
export const CONTOSO: DemoAbout = {
    id: 'contoso',
    family: 'contoso',
    title: 'Contoso 100K',
    summary: 'Star-schema retail dataset from SQL BI — Sales and Orders facts.',
    description: `
Contoso is Microsoft's go-to fictional company across their
documentation — most prominently as the worked example for Power BI and
Fabric. SQL BI maintains a modern, deterministic generator
([Contoso-Data-Generator-V2](https://github.com/sql-bi/Contoso-Data-Generator-V2))
that emits classic dimensional-modelling shapes: a **Date** dimension,
**Customer / Store / Product** dimensions, **CurrencyExchange** rates,
and two facts — a fully-denormalised **Sales** fact and a normalised
**Orders** fact (order headers in **Orders**, line items in
**OrderRows**).

The "100K" variant shipped here carries ~200K Sales lines and ~200K
order lines across ~83K orders, against ~105K customers and ~2.5K
products. The schema is intentionally well-suited to BI exercises:
clear dim/fact split and conformed dimensions.

**Build dependency**: the SQL BI CSV archives are .7z-compressed and we
extract them with \`7zz\` (macOS: \`brew install sevenzip\`). If the
extractor is missing, \`make demo-contoso\` exits with a clear message
and the other demos remain available.
`.trim(),
    rowCountApprox: 685_000,
    fileSizeBytesApprox: 73_000_000,
    tables: [
        { name: 'Date', rows: 3_653, note: 'date dimension' },
        { name: 'CurrencyExchange', rows: 91_325, note: 'daily exchange rates' },
        { name: 'Store', rows: 74, note: 'retail stores' },
        { name: 'Customer', rows: 104_990, note: 'individual buyers' },
        { name: 'Product', rows: 2_517 },
        { name: 'Sales', rows: 199_873, note: 'denormalised point-of-sale fact' },
        { name: 'Orders', rows: 83_130, note: 'order headers' },
        { name: 'OrderRows', rows: 199_873, note: 'order line items' },
    ],
    source: {
        origin: 'SQL BI — Contoso Data Generator V2 (100K CSV release)',
        url: 'https://github.com/sql-bi/Contoso-Data-Generator-V2-Data',
        license: 'MIT (SQL BI generator); freely redistributable.',
        docsUrl: 'https://docs.sqlbi.com/contoso-data-generator/',
    },
};
