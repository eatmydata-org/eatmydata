import type { DemoAbout, DemoHiddenPattern, DemoTableSummary } from './types';

/**
 * "About this dataset" content for the synthetic Retail demo. Three
 * size variants (xs / m / xl) all share schema and biases; only the
 * row counts and file size change. The hidden-patterns list is the
 * authoritative documentation for the dataset's intentional biases —
 * if you change the bias weights in `src/lib/sqlite/seed.ts`, update
 * the numbers here too.
 */

const DESCRIPTION = `
A synthetic, deterministic dataset modelling a multinational shoe
retailer with eight regional warehouses and roughly two and a half
years of order history. Built from scratch in
[src/lib/sqlite/seed.ts](src/lib/sqlite/seed.ts) using a seeded PRNG, so
re-running the generator with the same seed reproduces the data
byte-for-byte. There is no real-world source — these are made-up
brands, customers, orders, returns, and warranty claims.

The schema is eight tables (warehouses, products, stock, customers,
orders, order_items, returns, claims) plus a \`sales\` view that joins
orders + items + products and filters to non-cancelled orders. The
domain is intentionally familiar so SQL written against it can be read
by non-analysts.

The dataset is layered with realistic biases — see "Hidden patterns to
discover" below — so exploratory queries and BI dashboards have
something meaningful to find rather than uniform noise.

Human-entered text fields (\`customers.first_name\` / \`last_name\` /
\`city\` and \`claims.description\`) carry realistic data-entry noise —
dropped letters, doubled letters, transpositions and fat-finger
substitutions — so they read as messy free text rather than a clean
pick-list. Identifiers (\`sku\`, \`email\`) and join keys (\`country\`)
are left pristine. Expect \`COUNT(DISTINCT first_name)\` to be high and
exact grouping on names to fragment — fuzzy / semantic matching is the
intended path.
`.trim();

const HIDDEN_PATTERNS: ReadonlyArray<DemoHiddenPattern> = [
    {
        id: 1,
        title: 'Brand-popularity Pareto',
        body:
            'Sales counts skew sharply by brand. Nike (~26%) and Adidas (~18%) ' +
            'combine for ~44% of sales. Birkenstock, Allbirds, On and Salomon ' +
            'are long-tail (each ~2%). Popularity affects *which* product is ' +
            'bought per line, not how many distinct SKUs each brand has.\n\n' +
            '```sql\nSELECT brand, SUM(quantity) FROM sales GROUP BY brand ' +
            'ORDER BY 2 DESC;\n```',
    },
    {
        id: 2,
        title: 'Color preference',
        body:
            'Black and White each get ~4× the demand of mid-popular colours. ' +
            'Yellow, Orange and Olive are unloved (<0.5× baseline).',
    },
    {
        id: 3,
        title: 'Category seasonality',
        body:
            'Per-category monthly demand multipliers (northern-hemisphere ' +
            'calendar):\n\n' +
            '- **boots** — Nov-Jan peak (~3×), summer trough (~0.3×)\n' +
            '- **sandals** — May-Aug peak (~3.5×), winter trough (~0.4×)\n' +
            '- **hiking** — Sept-Nov peak (~1.5-2×)\n' +
            '- **running** — Jan resolution spike (~2×), Sept back-to-school (~1.5×)\n' +
            '- **sneakers / casual** — roughly flat',
    },
    {
        id: 4,
        title: 'Day-of-week + US-calendar promo spikes',
        body:
            'Weekends carry ~1.8× weekday volume. On top of that:\n\n' +
            '- **Cyber Friday window** (Thurs before Black Friday → Cyber Monday): ' +
            '~3.5× boost; Black Friday itself ~6×. Discount probability jumps from ' +
            '18% → 55% in the window and average discount magnitude doubles.\n' +
            '- **US Memorial Day** (last Monday of May): ~2× volume.\n' +
            '- **Dec 1-23** (holiday gifting): ~1.6× volume.',
    },
    {
        id: 5,
        title: 'Loyalty-tier activity',
        body:
            'Order pick-probability per customer is weighted by tier — ' +
            'bronze 1.0, silver 1.4, gold 2.2, platinum 3.5. Platinum customers ' +
            '(~3% of the base) drive ~10% of all orders. Platinum return rate is ' +
            '~0.4× the baseline.',
    },
    {
        id: 6,
        title: 'Channel mix by country',
        body:
            'The global channel split hides per-country deviations:\n\n' +
            '- **Japan** — ~60% mobile (vs ~30% global)\n' +
            '- **Germany / France** — ~55-60% web\n' +
            '- **USA** — ~22% in-store (vs ~10% global)\n' +
            '- **Brazil / Mexico** — ~25% marketplace',
    },
    {
        id: 7,
        title: 'Category-specific return rates',
        body:
            'Returns are not uniform across product categories: boots 12%, ' +
            "hiking 8%, sneakers 7%, casual 5%, running 5%, sandals 3%. Boots' " +
            'return-reason mix is dominated by `wrong_size` (~55%).',
    },
    {
        id: 8,
        title: 'Skechers supplier-quality incident',
        body:
            'Claims against Skechers products fire at ~3× the baseline rate. ' +
            '`warranty` and `quality` categories together account for ~85% of ' +
            'Skechers claims, and severity skews to medium / high.',
    },
    {
        id: 9,
        title: 'LAX01 inventory shrinkage',
        body:
            'Warehouse LAX01 has chronic, unexplained stock losses. Its ' +
            '`quantity_on_hand` values are systematically reduced to 75-90% ' +
            'of the uniform stocking policy. The other seven warehouses follow ' +
            'policy normally.\n\n' +
            '```sql\nSELECT w.code, AVG(s.quantity_on_hand) FROM stock s ' +
            'JOIN warehouses w USING (warehouse_id) GROUP BY w.code;\n```',
    },
    {
        id: 10,
        title: 'Partner-channel cancellations',
        body:
            'Orders placed on the `partner` channel cancel at ~3× the baseline ' +
            'rate (~21% cancelled vs ~7%), pointing at a handoff / integration ' +
            'problem with that channel.',
    },
];

const TABLE_NOTES: Record<string, string> = {
    warehouses: '8 regional DCs across USA / EU / APAC',
    products: 'SKU catalogue, 17 brands × multiple models',
    stock: 'per-warehouse inventory levels',
    customers: 'individual buyers with loyalty tier',
    orders: 'header rows with channel + status',
    order_items: 'line items per order, 1-4 per header',
    returns: 'subset of items returned, with reason',
    claims: 'warranty / quality complaints, with status',
};

function buildTables(rowCounts: Record<string, number>): ReadonlyArray<DemoTableSummary> {
    return Object.entries(rowCounts).map(([name, rows]) => ({
        name,
        rows,
        note: TABLE_NOTES[name],
    }));
}

const SOURCE = {
    origin: 'Generated in-house by `seedRetail()`',
    url: 'src/lib/sqlite/seed.ts',
    license: 'MIT (this repository)',
} as const;

export const RETAIL_XS: DemoAbout = {
    id: 'retail-xs',
    family: 'retail',
    variant: 'xs',
    title: 'Retail demo (xs · ~110 k rows)',
    summary: 'Synthetic shoe retailer, smallest size — quick to download.',
    description: DESCRIPTION,
    rowCountApprox: 114_852,
    fileSizeBytesApprox: 9_740_288,
    tables: buildTables({
        warehouses: 8,
        products: 1_500,
        stock: 7_127,
        customers: 8_000,
        orders: 35_000,
        order_items: 58_769,
        returns: 3_113,
        claims: 1_335,
    }),
    hiddenPatterns: HIDDEN_PATTERNS,
    source: SOURCE,
};

export const RETAIL_M: DemoAbout = {
    id: 'retail-m',
    family: 'retail',
    variant: 'm',
    title: 'Retail demo (m · ~350 k rows)',
    summary: 'Synthetic shoe retailer, mid size — good default.',
    description: DESCRIPTION,
    rowCountApprox: 356_374,
    fileSizeBytesApprox: 30_367_744,
    tables: buildTables({
        warehouses: 8,
        products: 4_000,
        stock: 19_206,
        customers: 25_000,
        orders: 110_000,
        order_items: 184_018,
        returns: 9_975,
        claims: 4_167,
    }),
    hiddenPatterns: HIDDEN_PATTERNS,
    source: SOURCE,
};

export const RETAIL_XL: DemoAbout = {
    id: 'retail-xl',
    family: 'retail',
    variant: 'xl',
    title: 'Retail demo (xl · ~1.2 M rows)',
    summary: 'Synthetic shoe retailer, largest size — stress-test territory.',
    description: DESCRIPTION,
    rowCountApprox: 1_202_406,
    fileSizeBytesApprox: 103_489_536,
    tables: buildTables({
        warehouses: 8,
        products: 10_000,
        stock: 47_829,
        customers: 80_000,
        orders: 380_000,
        order_items: 634_384,
        returns: 35_459,
        claims: 14_726,
    }),
    hiddenPatterns: HIDDEN_PATTERNS,
    source: SOURCE,
};
