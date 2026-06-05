/**
 * Global setup for integration tests. Loaded once per test file via
 * `setupFiles` in vitest.integration.config.ts.
 *
 * Responsibilities:
 *  - Surface a one-time cost reminder before the suite starts.
 *  - Wire the QuickJS sandbox to read `public/qjs.wasm` from disk
 *    (the production code path resolves via browser fetch).
 *
 * Module mocks for `@/lib/runtime/state/settings` and
 * `@/lib/data-sources/resolver` live at the top of the test file itself —
 * vitest needs `vi.mock` calls hoisted into the importer.
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll } from 'vitest';
import { setWasmLoader } from '@/libs/qjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const qjsWasmPath = resolve(__dirname, '../../../assets/qjs.wasm');
const settingsTypesPath = resolve(__dirname, '../../runtime/state/settings-types.ts');

/**
 * Resolve the OpenRouter API key, preferring the explicit env var and
 * falling back to the dev-default key already committed in
 * `settings-types.ts`. Surfaced via `globalThis.__INTEGRATION_API_KEY`
 * so the test file's settings mock (which can't read the env var at
 * vi.mock factory time without forcing setup ordering) can pick it up
 * consistently.
 */
async function resolveApiKey(): Promise<string> {
    if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
    try {
        const src = await readFile(settingsTypesPath, 'utf-8');
        const m = src.match(/'(sk-or-v1-[A-Za-z0-9]+)'/);
        if (m) return m[1]!;
    } catch {
        // fall through to empty key — tests will skip
    }
    return '';
}

let warned = false;

// Flip the agent-loop's opt-in error mirroring so 429s / SSE rate-limit
// injections / stream errors surface in stderr alongside any assertion
// failure. Set BEFORE the loop module is imported so the constant in
// loop.ts picks it up.
process.env.AGENT_LOG_API_ERRORS = '1';

beforeAll(async () => {
    const key = await resolveApiKey();
    (globalThis as Record<string, unknown>).__INTEGRATION_API_KEY = key;
    if (!warned) {
        warned = true;
        if (key) {
            // eslint-disable-next-line no-console
            console.warn(
                '[integration] Hitting real OpenRouter — ~$0.05 per full run with Gemini Flash Lite. Do not switch to Opus.',
            );
        } else {
            // eslint-disable-next-line no-console
            console.warn('[integration] No API key found — all tests will skip.');
        }
    }
    // Sandbox wasm: same pattern as src/lib/sandbox/runtime.test.ts.
    const bytes = await readFile(qjsWasmPath);
    setWasmLoader(() => bytes);
});
