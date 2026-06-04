import type { DemoAbout } from './types';

/**
 * Northwind — the Microsoft sample database for a fictional gourmet-food
 * import/export company, originally written for Access in the 1990s and
 * a fixture of SQL tutorials ever since. The SQLite distribution served
 * here is built directly from `contrib/northwind-sqlite3` (jpwhite3's
 * SQLite port of the upstream sample).
 */
export const NORTHWIND: DemoAbout = {
    id: 'northwind',
    family: 'northwind',
    title: 'Northwind',
    summary: "Microsoft's classic sample database — gourmet food trading.",
    description: `
Northwind Traders is a fictional importer of specialty foods (cheeses,
condiments, beverages, seafood) operating out of Seattle. The schema
spans **customers**, **orders**, **order details**, **products**,
**suppliers**, **shippers**, **employees**, **territories**, and a
handful of helpful views like \`Sales by Category\` and
\`Quarterly Orders\`.

It's one of the most-cited demo databases in SQL teaching, so virtually
any SQL pattern you want to test has an idiomatic Northwind example
somewhere on the internet. Small dataset — ~16k orders, ~600k order
lines — so most queries return instantly.

The SQLite distribution comes from
[jpwhite3/northwind-SQLite3](https://github.com/jpwhite3/northwind-SQLite3),
which mirrors the upstream Microsoft sample. We pin a submodule at
\`contrib/northwind-sqlite3/\` and copy \`dist/northwind.db\` straight
through — no transformation.
`.trim(),
    rowCountApprox: 626_000,
    fileSizeBytesApprox: 24_702_976,
    tables: [
        { name: 'Categories', rows: 8, note: 'product categories' },
        { name: 'Customers', rows: 93, note: 'wholesale buyers' },
        { name: 'Employees', rows: 9, note: 'sales and management staff' },
        { name: 'EmployeeTerritories', rows: 49 },
        { name: 'Orders', rows: 16_282, note: 'order headers' },
        { name: 'Order Details', rows: 609_283, note: 'line items per order' },
        { name: 'Products', rows: 77, note: 'specialty food SKUs' },
        { name: 'Regions', rows: 4 },
        { name: 'Shippers', rows: 3 },
        { name: 'Suppliers', rows: 29, note: 'food producers' },
        { name: 'Territories', rows: 53 },
        { name: 'CustomerDemographics', rows: 0 },
        { name: 'CustomerCustomerDemo', rows: 0 },
    ],
    source: {
        origin: 'jpwhite3 / northwind-SQLite3 — SQLite port of the Microsoft sample',
        url: 'https://github.com/jpwhite3/northwind-SQLite3',
        license: 'MIT (port); the original Microsoft sample is freely redistributable.',
        docsUrl: 'https://en.wikipedia.org/wiki/Northwind_and_pubs_sample_databases',
    },
};
