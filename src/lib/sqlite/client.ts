/**
 * Re-export shim. The engine lives under `src/lib/wa-sqlite/`; consumers
 * keep importing from `@/lib/sqlite/client` under stable names.
 */

export {
    getSqliteDb,
    invalidateSqliteDb,
    closeSqliteDb,
    destroySqliteOpfs,
    importDemoIntoOpfs,
} from '@/lib/wa-sqlite/client';

export type { WaSqliteDb as SqliteDb } from '@/lib/wa-sqlite/db';
export type { WaSqliteDbInstanceAccessor as SqliteDbInstanceAccessor } from '@/lib/wa-sqlite/accessor';
