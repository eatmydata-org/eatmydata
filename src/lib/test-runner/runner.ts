/**
 * Browser test runner. Lightweight harness that runs an array of named
 * async tests sequentially, captures everything that goes wrong (thrown
 * errors, unhandled rejections, `console.error` / `console.warn`), and
 * produces a single text report that can be copy-pasted into a bug
 * report or AI conversation.
 *
 * Use this for things vitest can't reach: DOM, AG Grid rendering,
 * SharedWorker / DedicatedWorker / multi-tab communication scenarios.
 * Tests run in the real browser context.
 *
 * Each test:
 *   - is identified by `id` (stable, kebab-case)
 *   - gets a fresh `TestContext` with `log()` for narrative output and
 *     `expect.*` for assertions
 *   - has a per-test timeout (default 10s)
 *   - runs sequentially — global error/rejection hooks would otherwise
 *     attribute errors to the wrong test
 *
 * The runner attaches `window.error` + `window.unhandledrejection` +
 * console.error/warn monkey-patches for the duration of each test.
 */

export type TestStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';

export interface CapturedError {
    source:
        | 'thrown'
        | 'unhandled'
        | 'console.log'
        | 'console.info'
        | 'console.warn'
        | 'console.error'
        | 'console.debug'
        | 'window.error';
    message: string;
    stack?: string;
    timestampMs: number;
}

export interface TestResult {
    id: string;
    name: string;
    status: TestStatus;
    durationMs: number;
    error?: CapturedError;
    capturedErrors: CapturedError[];
    logs: string[];
}

export interface TestContext {
    log: (...parts: unknown[]) => void;
    expect: {
        equal: <T>(actual: T, expected: T, message?: string) => void;
        truthy: (value: unknown, message?: string) => void;
        instanceOf: <T>(
            value: unknown,
            ctor: new (...args: never[]) => T,
            message?: string,
        ) => void;
    };
}

/**
 * Captured-error sources whose presence fails a test by default —
 * everything else (`console.log` / `info` / `debug`) is informational
 * and recorded but doesn't change the outcome.
 */
const FAILING_CAPTURED_SOURCES: ReadonlySet<CapturedError['source']> = new Set([
    'console.error',
    'console.warn',
    'window.error',
    'unhandled',
]);

/**
 * A captured error the test author explicitly anticipates. Each entry
 * matches at most one captured error (first match wins) and removes it
 * from the failure tally. Use this when a code path under test logs to
 * `console.error` deliberately (e.g. surfacing an async-factory failure
 * via diagnostics).
 */
export interface ExpectedCaptured {
    source: CapturedError['source'];
    /** Optional substring the captured message must include to match. */
    messageIncludes?: string;
}

export interface TestDef {
    id: string;
    name: string;
    fn: (ctx: TestContext) => Promise<void> | void;
    /** Per-test timeout in ms. Default 10_000. */
    timeoutMs?: number;
    /** Skip this test in normal runs. */
    skip?: boolean;
    /**
     * Captured errors the test deliberately produces. Each entry matches
     * at most one captured error; unmatched failing-source captures cause
     * the test to fail even if its `fn` returns normally.
     */
    expectedCaptured?: ExpectedCaptured[];
}

export interface RunSummary {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

function fmtPart(part: unknown): string {
    if (part instanceof Error) {
        return part.stack ?? `${part.name}: ${part.message}`;
    }
    if (typeof part === 'string') return part;
    try {
        return JSON.stringify(part);
    } catch {
        return String(part);
    }
}

function captureFromEvent(event: ErrorEvent | PromiseRejectionEvent): CapturedError {
    const isError = 'error' in event;
    const raw = isError ? event.error : event.reason;
    if (raw instanceof Error) {
        return {
            source: isError ? 'window.error' : 'unhandled',
            message: raw.message,
            stack: raw.stack,
            timestampMs: Date.now(),
        };
    }
    return {
        source: isError ? 'window.error' : 'unhandled',
        message: fmtPart(raw),
        timestampMs: Date.now(),
    };
}

class AssertionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'AssertionError';
    }
}

async function runOne(
    def: TestDef,
    onStatusChange: (status: TestStatus) => void,
): Promise<TestResult> {
    const result: TestResult = {
        id: def.id,
        name: def.name,
        status: 'running',
        durationMs: 0,
        capturedErrors: [],
        logs: [],
    };
    onStatusChange('running');

    if (def.skip) {
        result.status = 'skipped';
        onStatusChange('skipped');
        return result;
    }

    const onError = (e: ErrorEvent) => {
        result.capturedErrors.push(captureFromEvent(e));
    };
    const onRejection = (e: PromiseRejectionEvent) => {
        result.capturedErrors.push(captureFromEvent(e));
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);

    type ConsoleMethod = 'log' | 'info' | 'warn' | 'error' | 'debug';
    const consoleMethods: ConsoleMethod[] = [
        'log',
        'info',
        'warn',
        'error',
        'debug',
    ];
    const originalConsole = {} as Record<
        ConsoleMethod,
        (...args: unknown[]) => void
    >;
    for (const m of consoleMethods) {
        originalConsole[m] = console[m].bind(console);
        console[m] = (...args: unknown[]) => {
            result.capturedErrors.push({
                source: `console.${m}` as CapturedError['source'],
                message: args.map(fmtPart).join(' '),
                timestampMs: Date.now(),
            });
            originalConsole[m](...args);
        };
    }

    const ctx: TestContext = {
        log: (...parts) => result.logs.push(parts.map(fmtPart).join(' ')),
        expect: {
            equal: (actual, expected, message) => {
                if (actual !== expected) {
                    throw new AssertionError(
                        message
                            ? `${message}: expected ${fmtPart(expected)}, got ${fmtPart(actual)}`
                            : `Expected ${fmtPart(expected)}, got ${fmtPart(actual)}`,
                    );
                }
            },
            truthy: (value, message) => {
                if (!value) {
                    throw new AssertionError(
                        message
                            ? `${message}: value was falsy (${fmtPart(value)})`
                            : `Expected truthy, got ${fmtPart(value)}`,
                    );
                }
            },
            instanceOf: (value, ctor, message) => {
                if (!(value instanceof ctor)) {
                    throw new AssertionError(
                        message
                            ? `${message}: not an instance of ${ctor.name}`
                            : `Expected instance of ${ctor.name}, got ${fmtPart(value)}`,
                    );
                }
            },
        },
    };

    const timeoutMs = def.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const startedAt = performance.now();
    // Held outside the race so we can clear it on success — otherwise
    // the loser timeout fires later and rejects a Promise<never> nothing
    // awaits, surfacing as an unhandledrejection that gets attributed to
    // whichever test is running at that moment.
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([
            Promise.resolve(def.fn(ctx)),
            new Promise<never>((_, reject) => {
                timeoutTimer = setTimeout(
                    () =>
                        reject(
                            new Error(`Test timed out after ${timeoutMs}ms`),
                        ),
                    timeoutMs,
                );
            }),
        ]);
        result.status = 'passed';
    } catch (e) {
        result.status = 'failed';
        const err = e instanceof Error ? e : new Error(fmtPart(e));
        result.error = {
            source: 'thrown',
            message: err.message,
            stack: err.stack,
            timestampMs: Date.now(),
        };
    } finally {
        if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
        result.durationMs = performance.now() - startedAt;
        window.removeEventListener('error', onError);
        window.removeEventListener('unhandledrejection', onRejection);
        for (const m of consoleMethods) {
            console[m] = originalConsole[m];
        }
        // Give microtasks a chance to settle so late rejections still
        // attribute to this test before the next one starts.
        // `unhandledrejection` is dispatched in a microtask after the
        // failing promise's settle — a few microtask drains are enough
        // (was 50 ms × 17 tests = ~850 ms dead wall time per run).
        for (let i = 0; i < 3; i++) await Promise.resolve();
    }
    // After fn returns / throws, consume the expectedCaptured matchers
    // against the captured-error list. Any unmatched captured error in a
    // FAILING source fails the test even if fn itself passed.
    if (result.status === 'passed' && result.capturedErrors.length > 0) {
        const unmatchedExpectations = (def.expectedCaptured ?? []).slice();
        const unexpected: CapturedError[] = [];
        for (const captured of result.capturedErrors) {
            if (!FAILING_CAPTURED_SOURCES.has(captured.source)) continue;
            const matchIdx = unmatchedExpectations.findIndex(
                (exp) =>
                    exp.source === captured.source &&
                    (exp.messageIncludes === undefined ||
                        captured.message.includes(exp.messageIncludes)),
            );
            if (matchIdx >= 0) {
                unmatchedExpectations.splice(matchIdx, 1);
            } else {
                unexpected.push(captured);
            }
        }
        if (unexpected.length > 0) {
            result.status = 'failed';
            const summary = unexpected
                .map((c) => `[${c.source}] ${c.message}`)
                .join('\n');
            result.error = {
                source: 'thrown',
                message: `Unexpected captured ${unexpected.length === 1 ? 'error' : 'errors'} (${unexpected.length}):\n${summary}`,
                timestampMs: Date.now(),
            };
        } else if (unmatchedExpectations.length > 0) {
            // The test declared expectations that never fired — also a
            // failure, since the diagnostic surface didn't trigger.
            result.status = 'failed';
            const missing = unmatchedExpectations
                .map(
                    (e) =>
                        `[${e.source}]${e.messageIncludes ? ` includes "${e.messageIncludes}"` : ''}`,
                )
                .join('\n');
            result.error = {
                source: 'thrown',
                message: `Expected captured errors did not fire (${unmatchedExpectations.length}):\n${missing}`,
                timestampMs: Date.now(),
            };
        }
    } else if (
        result.status === 'passed' &&
        (def.expectedCaptured?.length ?? 0) > 0
    ) {
        // No captures at all but the test expected some.
        result.status = 'failed';
        result.error = {
            source: 'thrown',
            message: `Expected captured errors did not fire (${def.expectedCaptured!.length})`,
            timestampMs: Date.now(),
        };
    }
    onStatusChange(result.status);
    return result;
}

export async function runAll(
    tests: TestDef[],
    onResultUpdate?: (id: string, partial: Partial<TestResult>) => void,
): Promise<{ results: TestResult[]; summary: RunSummary }> {
    const results: TestResult[] = [];
    const startedAt = performance.now();
    for (const def of tests) {
        const result = await runOne(def, (status) => {
            onResultUpdate?.(def.id, { status });
        });
        results.push(result);
        onResultUpdate?.(def.id, result);
    }
    const summary: RunSummary = {
        total: results.length,
        passed: results.filter((r) => r.status === 'passed').length,
        failed: results.filter((r) => r.status === 'failed').length,
        skipped: results.filter((r) => r.status === 'skipped').length,
        durationMs: performance.now() - startedAt,
    };
    return { results, summary };
}

/**
 * Format a run as a single text blob suitable for copy-paste. Mimics
 * vitest output: PASS/FAIL lines, a summary, then per-failed-test
 * details with captured errors and logs.
 */
export function formatReport(
    results: TestResult[],
    summary: RunSummary,
    meta: { userAgent: string; href: string; runAt: Date },
): string {
    const lines: string[] = [];
    lines.push('# Browser test report');
    lines.push('');
    lines.push(`run at: ${meta.runAt.toISOString()}`);
    lines.push(`url:    ${meta.href}`);
    lines.push(`ua:     ${meta.userAgent}`);
    lines.push('');
    lines.push('## Summary');
    lines.push(
        `${summary.passed}/${summary.total} passed, ${summary.failed} failed, ${summary.skipped} skipped (${summary.durationMs.toFixed(0)}ms)`,
    );
    lines.push('');
    lines.push('## Per-test results');
    for (const r of results) {
        const icon =
            r.status === 'passed'
                ? 'PASS'
                : r.status === 'failed'
                  ? 'FAIL'
                  : r.status === 'skipped'
                    ? 'SKIP'
                    : '....';
        const errCount = r.capturedErrors.length;
        const errSuffix = errCount > 0 ? `  [${errCount} captured]` : '';
        lines.push(
            `${icon}  ${r.id}  (${r.durationMs.toFixed(0)}ms)${errSuffix}  — ${r.name}`,
        );
    }
    lines.push('');
    for (const r of results) {
        if (
            r.status !== 'failed' &&
            r.capturedErrors.length === 0 &&
            r.logs.length === 0
        ) {
            continue;
        }
        lines.push(`### ${r.id} — ${r.name} (${r.status})`);
        if (r.error) {
            lines.push('');
            lines.push('**Thrown error:**');
            lines.push('```');
            lines.push(r.error.message);
            if (r.error.stack) lines.push(r.error.stack);
            lines.push('```');
        }
        if (r.capturedErrors.length > 0) {
            lines.push('');
            lines.push(`**Captured (${r.capturedErrors.length}):**`);
            for (const c of r.capturedErrors) {
                lines.push(`- [${c.source}] ${c.message}`);
                if (c.stack) {
                    const indented = c.stack
                        .split('\n')
                        .map((l) => '    ' + l)
                        .join('\n');
                    lines.push(indented);
                }
            }
        }
        if (r.logs.length > 0) {
            lines.push('');
            lines.push('**Logs:**');
            for (const l of r.logs) {
                lines.push(`- ${l}`);
            }
        }
        lines.push('');
    }
    return lines.join('\n');
}
