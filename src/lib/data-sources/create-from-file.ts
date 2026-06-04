/**
 * Top-level "import a file as a new data source" orchestrator.
 *
 * Rules (see Settings → Data sources for the storage rule):
 *  - Display name: derived from the file's basename without extension.
 *  - Internal table name: snake_case of the display name.
 *  - On display-name collision: append " (1)", " (2)", … (human form).
 *  - On internal-name collision (separate dedup): append "_1", "_2", …
 *  - Storage mode: read from Settings, NOT from per-source choice.
 *
 * The two suffix systems are deliberately independent: a user-renamed
 * source can end up with display "Sales Q3 (2)" but internal `sales_q3_2`
 * (or a different number) without that mismatching feeling wrong, because
 * the internal name is also unique within sqlite by construction.
 */
import type { DataSource, Persistence } from './types';
import {
    makeDataSourceId,
    makeDbFile,
    putSource,
    listSources,
    takenDbLeaves,
} from './store';
import { getWorkerSessionId } from './session';
import {
    basenameWithoutExtension,
    dedupHumanName,
    toSnakeCase,
} from './identifier';
import { stageFile, importBatch, type ImportJobOutcome } from './import';

export type CreateFromFileResult = {
    source: DataSource;
    outcomes: ImportJobOutcome[];
    /** True when the display name had to be suffixed to avoid collision. */
    renamed: boolean;
    requestedName: string;
    finalName: string;
};

/**
 * Create a fresh data source whose name comes from `file`, then import
 * the file into it. Returns the resulting source + outcomes so the
 * caller can surface a "name was taken, renamed to X" warning.
 */
export async function createSourceFromFile(
    file: File,
    persistence: Persistence,
): Promise<CreateFromFileResult> {
    const requestedName = basenameWithoutExtension(file.name) || 'untitled';

    // Dedup against ALL existing source display names, regardless of
    // storage mode. The rule is "no duplicate display names anywhere".
    const all = await listSources();
    const takenNames = new Set(all.map((s) => s.name));
    const finalName = dedupHumanName(requestedName, takenNames);

    const id = makeDataSourceId();
    const now = Date.now();
    const source: DataSource = {
        id,
        name: finalName,
        dbFile: makeDbFile(finalName, persistence, takenDbLeaves(all), id),
        kind: 'imported',
        persistence,
        sessionId:
            persistence === 'temp' ? getWorkerSessionId() : undefined,
        isDefault: false,
        createdAt: now,
        updatedAt: now,
    };
    await putSource(source);

    // Stage + import the file into the fresh source.
    // Force the staged table name to be the snake_case of `finalName`
    // (not the original filename) so the internal name follows the
    // user-visible name. Within a fresh source there are no existing
    // tables to collide with, so the import-time dedup is a no-op.
    const seedTableName = toSnakeCase(finalName, 'data');
    const staged = await stageFile(file, [], new Set());
    // For CSV → single job. For XLSX with multiple sheets → multiple
    // jobs; only the first inherits the seed name; the rest keep their
    // sheet-derived names so the user can tell sheets apart.
    if (staged.length > 0 && staged[0]) {
        staged[0]!.tableName = seedTableName;
    }
    const outcomes = await importBatch(source, staged, []);

    return {
        source,
        outcomes,
        renamed: finalName !== requestedName,
        requestedName,
        finalName,
    };
}
