import { openDB, type IDBPDatabase } from 'idb';
import type { Action, ActionVersion } from './types';
import type { ActionExecution } from './executor';
import { STORAGE_VERSION } from '@/lib/storage';

const DB_NAME = `analyst:v${STORAGE_VERSION}`;
const DB_VERSION = 3;
const ACTIONS = 'actions';
const RESULTS = 'results';
const ACTION_VERSIONS = 'action_versions';

type Schema = {
    actions: {
        key: string;
        value: Action;
        indexes: { 'by-updatedAt': number };
    };
    results: {
        key: string;
        value: ActionExecution;
        indexes: { 'by-finishedAt': number; 'by-actionId': string };
    };
    action_versions: {
        key: string;
        value: ActionVersion;
        indexes: {
            'by-actionId': string;
            'by-actionId-contentHash': [string, string];
        };
    };
};

let dbPromise: Promise<IDBPDatabase<Schema>> | null = null;

export function openActionsDb(): Promise<IDBPDatabase<Schema>> {
    if (!dbPromise) {
        dbPromise = openDB<Schema>(DB_NAME, DB_VERSION, {
            upgrade(db, oldVersion) {
                if (oldVersion < 1) {
                    const store = db.createObjectStore(ACTIONS, {
                        keyPath: 'id',
                    });
                    store.createIndex('by-updatedAt', 'updatedAt');
                }
                if (oldVersion < 2) {
                    const store = db.createObjectStore(RESULTS, {
                        keyPath: 'id',
                    });
                    store.createIndex('by-finishedAt', 'finishedAt');
                    store.createIndex('by-actionId', 'actionId');
                }
                if (oldVersion < 3) {
                    const store = db.createObjectStore(ACTION_VERSIONS, {
                        keyPath: 'id',
                    });
                    store.createIndex('by-actionId', 'actionId');
                    store.createIndex(
                        'by-actionId-contentHash',
                        ['actionId', 'contentHash'],
                    );
                }
            },
        });
    }
    return dbPromise;
}

export async function listActions(): Promise<Action[]> {
    const db = await openActionsDb();
    return await db.getAllFromIndex(ACTIONS, 'by-updatedAt');
}

/**
 * Most recently updated actions first, capped at `limit`. Backed by a reverse
 * cursor on the `by-updatedAt` index so the DB only walks as far as needed.
 */
export async function listRecentActions(limit = 50): Promise<Action[]> {
    const db = await openActionsDb();
    const out: Action[] = [];
    let cursor = await db
        .transaction(ACTIONS)
        .store.index('by-updatedAt')
        .openCursor(null, 'prev');
    while (cursor && out.length < limit) {
        out.push(cursor.value);
        cursor = await cursor.continue();
    }
    return out;
}

export async function getAction(id: string): Promise<Action | undefined> {
    const db = await openActionsDb();
    return await db.get(ACTIONS, id);
}

export async function putAction(action: Action): Promise<void> {
    const db = await openActionsDb();
    await db.put(ACTIONS, action);
}

export async function deleteAction(id: string): Promise<void> {
    const db = await openActionsDb();
    await db.delete(ACTIONS, id);
}

export async function listResults(): Promise<ActionExecution[]> {
    const db = await openActionsDb();
    return await db.getAllFromIndex(RESULTS, 'by-finishedAt');
}

export async function getResultRow(
    id: string,
): Promise<ActionExecution | undefined> {
    const db = await openActionsDb();
    return await db.get(RESULTS, id);
}

export async function putResultRow(result: ActionExecution): Promise<void> {
    const db = await openActionsDb();
    await db.put(RESULTS, result);
}

export async function deleteResultRow(id: string): Promise<void> {
    const db = await openActionsDb();
    await db.delete(RESULTS, id);
}

export async function listResultsForAction(
    actionId: string,
): Promise<ActionExecution[]> {
    const db = await openActionsDb();
    return await db.getAllFromIndex(RESULTS, 'by-actionId', actionId);
}

export async function deleteActionCascade(actionId: string): Promise<void> {
    const db = await openActionsDb();
    const tx = db.transaction(
        [ACTIONS, RESULTS, ACTION_VERSIONS],
        'readwrite',
    );
    const results = await tx
        .objectStore(RESULTS)
        .index('by-actionId')
        .getAllKeys(actionId);
    for (const k of results) await tx.objectStore(RESULTS).delete(k);
    const versions = await tx
        .objectStore(ACTION_VERSIONS)
        .index('by-actionId')
        .getAllKeys(actionId);
    for (const k of versions) await tx.objectStore(ACTION_VERSIONS).delete(k);
    await tx.objectStore(ACTIONS).delete(actionId);
    await tx.done;
}

/**
 * Find every Action whose query SQL appears to reference `tableName` inside
 * `sourceId`. Matched lexically against the literal identifier (bare or
 * double-quoted) — there's no SQL parser in the project, but this catches
 * the common `FROM table`, `JOIN table`, `"table"` shapes well enough for
 * the cascade-delete confirmation. Legacy actions without `dataSourceId`
 * are included when the literal matches (we can't otherwise tell).
 */
export async function findActionsReferencingTable(
    sourceId: string,
    tableName: string,
): Promise<Action[]> {
    const actions = await listActions();
    const escaped = tableName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(
        `(?:^|[^A-Za-z0-9_"])"?${escaped}"?(?![A-Za-z0-9_])`,
        'i',
    );
    return actions.filter((a) => {
        if (a.dataSourceId && a.dataSourceId !== sourceId) return false;
        return a.dataSources.some((ds) => re.test(ds.query));
    });
}

/**
 * Nukes every actions/results/versions row. Dev-only helper backing the
 * "Delete everything" button in the Sources panel.
 */
export async function clearAllActions(): Promise<void> {
    const db = await openActionsDb();
    const tx = db.transaction(
        [ACTIONS, RESULTS, ACTION_VERSIONS],
        'readwrite',
    );
    await tx.objectStore(ACTIONS).clear();
    await tx.objectStore(RESULTS).clear();
    await tx.objectStore(ACTION_VERSIONS).clear();
    await tx.done;
}

export async function putActionVersion(version: ActionVersion): Promise<void> {
    const db = await openActionsDb();
    await db.put(ACTION_VERSIONS, version);
}

export async function getActionVersion(
    id: string,
): Promise<ActionVersion | undefined> {
    const db = await openActionsDb();
    return await db.get(ACTION_VERSIONS, id);
}

export async function getActionVersionByHash(
    actionId: string,
    contentHash: string,
): Promise<ActionVersion | undefined> {
    const db = await openActionsDb();
    return await db.getFromIndex(
        ACTION_VERSIONS,
        'by-actionId-contentHash',
        [actionId, contentHash],
    );
}

export async function listVersionsForAction(
    actionId: string,
): Promise<ActionVersion[]> {
    const db = await openActionsDb();
    const rows = await db.getAllFromIndex(
        ACTION_VERSIONS,
        'by-actionId',
        actionId,
    );
    rows.sort((a, b) => a.createdAt - b.createdAt);
    return rows;
}
