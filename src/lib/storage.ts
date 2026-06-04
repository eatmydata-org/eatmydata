import type { DebugBlock } from './debug-log';

/**
 * Single source of truth for persistent-storage versioning. Every storage key
 * (localStorage and IndexedDB DB names) is suffixed with `v${STORAGE_VERSION}`.
 * Bump this whenever any persisted shape changes — old keys/DBs get orphaned
 * so the app starts with clean state instead of mixing shapes.
 */
export const STORAGE_VERSION = 3;

const DEBUG_KEY = `chat:debug:v${STORAGE_VERSION}`;
const DEBUG_ENABLED_KEY = `chat:debug:enabled:v${STORAGE_VERSION}`;

export function loadDebugBlocks(): DebugBlock[] {
    try {
        const raw = localStorage.getItem(DEBUG_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(isDebugBlock);
    } catch {
        return [];
    }
}

export function saveDebugBlocks(blocks: DebugBlock[]) {
    try {
        localStorage.setItem(DEBUG_KEY, JSON.stringify(blocks));
    } catch {
        // quota or disabled storage
    }
}

export function clearDebugBlocks() {
    try {
        localStorage.removeItem(DEBUG_KEY);
    } catch {
        // quota or disabled storage
    }
}

export function loadDebugEnabled(): boolean {
    try {
        return localStorage.getItem(DEBUG_ENABLED_KEY) === '1';
    } catch {
        // quota or disabled storage
        return false;
    }
}

export function saveDebugEnabled(v: boolean) {
    try {
        if (v) localStorage.setItem(DEBUG_ENABLED_KEY, '1');
        else localStorage.removeItem(DEBUG_ENABLED_KEY);
    } catch {
        // quota or disabled storage
    }
}

function isDebugBlock(x: unknown): x is DebugBlock {
    if (!x || typeof x !== 'object') return false;
    const b = x as Record<string, unknown>;
    return (
        typeof b.id === 'string' &&
        (b.kind === 'request' || b.kind === 'response' || b.kind === 'system') &&
        typeof b.stepId === 'string' &&
        typeof b.text === 'string' &&
        typeof b.done === 'boolean' &&
        typeof b.createdAt === 'number'
    );
}
