import type { DemoAbout } from './types';

/**
 * AdventureWorks LT — the lightweight subset of Microsoft's
 * AdventureWorks sample database, modelling a fictional cycling-and-
 * sports-equipment retailer. The SQLite build comes from
 * `martinandersen3d/AdventureWorks-for-SQLite` (vendored under
 * `contrib/adventureworks-sqlite`), which ships a ready-to-use 2.7 MB
 * .db file containing the LT subset.
 *
 * The full AdventureWorks OLTP schema (68 tables across HR, Production,
 * Purchasing, Sales, Person schemas) is intentionally not in scope here
 * — LT keeps the same flavour at a small fraction of the size.
 */
export const ADVENTUREWORKS: DemoAbout = {
    id: 'adventureworks',
    family: 'adventureworks',
    title: 'AdventureWorks LT',
    summary: "Microsoft's cycling retailer sample — the lightweight (LT) subset.",
    description: `
AdventureWorks is Microsoft's go-to sample database for SQL Server
training and tutorials. It models a fictional bicycle and sports-
equipment manufacturer with sales channels across multiple countries.

The **LT** (lightweight) subset shipped here covers the customer-facing
sales side — **customers**, **addresses**, **products** and their
**categories / models**, plus **sales orders** and **line items**. It's
the same data you'll find in any AdventureWorks tutorial that says "use
AdventureWorksLT" rather than the full OLTP database.

Conversion to SQLite is courtesy of
[martinandersen3d/AdventureWorks-for-SQLite](https://github.com/martinandersen3d/AdventureWorks-for-SQLite),
which we vendor as a submodule under \`contrib/adventureworks-sqlite\`.
Sales volumes are modest (~32 orders / ~540 line items), so this
dataset is best for schema-shape exercises rather than analytics at
scale.
`.trim(),
    rowCountApprox: 4_267,
    fileSizeBytesApprox: 2_809_856,
    tables: [
        { name: 'Address', rows: 450 },
        { name: 'BuildVersion', rows: 1 },
        { name: 'Customer', rows: 847 },
        { name: 'CustomerAddress', rows: 417 },
        { name: 'ErrorLog', rows: 0 },
        { name: 'Product', rows: 295 },
        { name: 'ProductCategory', rows: 41 },
        { name: 'ProductDescription', rows: 762 },
        { name: 'ProductModel', rows: 128 },
        { name: 'ProductModelProductDescription', rows: 762 },
        { name: 'SalesOrderDetail', rows: 542 },
        { name: 'SalesOrderHeader', rows: 32 },
    ],
    source: {
        origin: "martinandersen3d / AdventureWorks-for-SQLite — port of Microsoft's AdventureWorksLT",
        url: 'https://github.com/martinandersen3d/AdventureWorks-for-SQLite',
        license: 'MIT (port); the original AdventureWorks sample is freely redistributable.',
        docsUrl:
            'https://learn.microsoft.com/en-us/sql/samples/adventureworks-install-configure',
    },
};
