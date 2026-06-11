// Vitest runs under the `node` environment (vitest.config.ts), which has no DOM
// and therefore no `localStorage`. Settings + storage migrations persist to
// localStorage, so provide a minimal in-memory implementation. Installed fresh
// per test file (setupFiles run before each file), so state doesn't leak across
// files; individual tests `localStorage.clear()` in `beforeEach` as needed.
const store = new Map<string, string>();
const localStorageStub: Storage = {
    get length() {
        return store.size;
    },
    clear() {
        store.clear();
    },
    getItem(key: string) {
        return store.has(key) ? store.get(key)! : null;
    },
    key(index: number) {
        return [...store.keys()][index] ?? null;
    },
    removeItem(key: string) {
        store.delete(key);
    },
    setItem(key: string, value: string) {
        store.set(key, String(value));
    },
};

Object.defineProperty(globalThis, 'localStorage', {
    value: localStorageStub,
    configurable: true,
    writable: true,
});
