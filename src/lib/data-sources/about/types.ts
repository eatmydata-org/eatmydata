/**
 * Static metadata for each pre-built demo dataset. Read by the Demo
 * Dialog to render the "About this dataset" panel and by the demo-source
 * factory to know which file to download and how to label table-meta
 * rows. The actual data lives in `src/assets/demo/<id>.sqlite`, built by
 * `make demo-data` from the submodules under contrib/.
 */
export type DemoSpec =
    | 'retail-xs'
    | 'retail-m'
    | 'retail-xl'
    | 'northwind'
    | 'adventureworks'
    | 'contoso';

export type DemoFamily = 'retail' | 'northwind' | 'adventureworks' | 'contoso';

export type DemoVariant = 'xs' | 'm' | 'xl';

export type DemoTableSummary = {
    /** SQLite table name as it appears in `sqlite_master`. */
    name: string;
    /** Approximate row count — accurate at build time, indicative thereafter. */
    rows: number;
    /** One-line description (renders in the About panel's tables list). */
    note?: string;
};

export type DemoHiddenPattern = {
    id: number;
    title: string;
    /** Markdown body — what the pattern is and how to reveal it in SQL. */
    body: string;
};

export type DemoAbout = {
    id: DemoSpec;
    family: DemoFamily;
    variant?: DemoVariant;
    /** Display name in the picker. */
    title: string;
    /** Short tagline shown alongside the title. */
    summary: string;
    /** Long-form markdown description (multi-paragraph). */
    description: string;
    /** Approximate total row count across all tables. */
    rowCountApprox: number;
    /** Expected download size in bytes — drives the progress bar's denominator. */
    fileSizeBytesApprox: number;
    /** Tables to seed into __rh_meta_tables and render in the About panel. */
    tables: ReadonlyArray<DemoTableSummary>;
    /** Retail-only: the dataset's intentional biases ("ground truth"). */
    hiddenPatterns?: ReadonlyArray<DemoHiddenPattern>;
    /** Provenance + licence — always populate. */
    source: {
        origin: string;
        url: string;
        license: string;
        /** Where the upstream documentation lives. */
        docsUrl?: string;
    };
};
