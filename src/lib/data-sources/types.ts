/**
 * Persistence mode chosen per data source. See store.ts for cleanup.
 *
 * - 'memory':     `:memory:` sqlite, lives in SharedWorker heap, dies with it.
 * - 'temp':       OPFS file tagged with the worker's session id; cleaned on
 *                 the next worker boot if no tabs were holding the worker
 *                 alive in between (i.e. session id no longer matches).
 * - 'persistent': OPFS file with no cleanup. Survives reloads + restarts.
 */
export type Persistence = 'memory' | 'temp' | 'persistent';

export type DataSourceKind = 'imported' | 'demo';

/**
 * Stable identifier for a pre-built demo dataset. Mirrors the keys in
 * `src/lib/data-sources/about/index.ts`; kept as a loose string here so
 * older rows that don't have this field stay valid.
 */
export type DemoSpecId =
    | 'retail-xs'
    | 'retail-m'
    | 'retail-xl'
    | 'northwind'
    | 'adventureworks'
    | 'contoso';

export type DataSource = {
    id: string;
    /** Display name (user-editable). Distinct from the sqlite DB filename. */
    name: string;
    /**
     * Stable filename used inside the OPFS VFS (`/<dbFile>`). Also the
     * `name` argument we pass to `SqliteDbInstanceAccessor.get(name)` for
     * memory-mode sources so the worker isolates them from each other.
     */
    dbFile: string;
    kind: DataSourceKind;
    persistence: Persistence;
    /** For 'temp' rows: the worker session that created this OPFS file. */
    sessionId?: string;
    /**
     * For 'demo'-kind rows: which pre-built dataset this row was seeded
     * from. The UI uses this to re-derive About content on subsequent
     * loads. Optional so older rows remain valid.
     */
    demoSpec?: DemoSpecId;
    /**
     * Exactly zero or one row may carry this flag at any time. New chats
     * open against the default source unless the user picks another.
     */
    isDefault: boolean;
    createdAt: number;
    updatedAt: number;
};

/**
 * Per-imported-table metadata kept inside each source's sqlite under
 * `__rh_meta_tables`. Sources that were created from demo seeds populate
 * this too, with originalFileName = '(demo)'.
 */
export type ImportedTableMeta = {
    tableName: string;
    originalFileName: string;
    readableName?: string;
    importedAt: number;
};
