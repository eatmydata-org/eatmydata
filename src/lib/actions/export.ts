import { listActions, listVersionsForAction, listResultsForAction } from './store';

/**
 * A best-effort `JSON.stringify` replacer that makes a "mostly" JSON-safe
 * value actually safe to serialize. Action rows are plain data today, but
 * `ActionExecution.output` is typed `unknown` (whatever a user's sandboxed
 * code returned), so we harden the dump rather than trust it:
 *   - `bigint` → string  (raw `JSON.stringify` throws on bigint)
 *   - circular references → `'[Circular]'`  (raw `JSON.stringify` throws)
 *   - functions → dropped  (JSON drops these anyway; made explicit)
 *
 * A fresh replacer (with its own `seen` set) must be created per call.
 */
function jsonSafeReplacer(): (key: string, value: unknown) => unknown {
    const seen = new WeakSet<object>();
    return (_key, value) => {
        if (typeof value === 'bigint') return value.toString();
        if (typeof value === 'function') return undefined;
        if (value !== null && typeof value === 'object') {
            if (seen.has(value)) return '[Circular]';
            seen.add(value);
        }
        return value;
    };
}

export type ActionsExport = {
    kind: 'analyst-actions-export';
    version: 1;
    exportedAt: number;
    count: number;
    actions: {
        action: unknown;
        versions: unknown[];
        results: unknown[];
    }[];
};

/**
 * Serialize every stored action — together with its version history and
 * recorded runs — into a single JSON string. This is a raw dump of the
 * internal representation: no schema/shape guarantees (hence `unknown` in
 * {@link ActionsExport}), but guaranteed to be JSON-serializable via
 * {@link jsonSafeReplacer}.
 */
export async function buildActionsExportJson(): Promise<string> {
    const actions = await listActions();
    const items = await Promise.all(
        actions.map(async (action) => ({
            action,
            versions: await listVersionsForAction(action.id),
            results: await listResultsForAction(action.id),
        })),
    );
    const payload: ActionsExport = {
        kind: 'analyst-actions-export',
        version: 1,
        exportedAt: Date.now(),
        count: actions.length,
        actions: items,
    };
    return JSON.stringify(payload, jsonSafeReplacer(), 2);
}
