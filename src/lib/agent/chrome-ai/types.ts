/**
 * Minimal typings for Chrome's built-in Prompt API (`globalThis.LanguageModel`).
 *
 * The API is not in TypeScript's DOM lib yet, and its shape has drifted
 * across Chrome versions (e.g. the `availability()` return strings were
 * `'no' | 'after-download' | 'readily'` in early builds and
 * `'unavailable' | 'downloadable' | 'downloading' | 'available'` in
 * current ones). We model the current surface and tolerate the legacy
 * strings in {@link ./availability.ts}.
 *
 * Leaf module — no Solid, no app imports — so the provider, the
 * availability probe, and the tests can all share these shapes.
 *
 * @see https://developer.chrome.com/docs/ai/prompt-api
 */

/** Raw strings `LanguageModel.availability()` may return across versions. */
export type ChromeAiRawAvailability =
    | 'unavailable'
    | 'downloadable'
    | 'downloading'
    | 'available'
    // legacy (Chrome ≤ ~128)
    | 'no'
    | 'after-download'
    | 'readily';

export type ChromeAiRole = 'system' | 'user' | 'assistant';

export interface ChromeAiMessage {
    role: ChromeAiRole;
    content: string;
    /**
     * Treat this assistant message as a response prefix the model should
     * continue from rather than a completed turn. Used to coax JSON output.
     */
    prefix?: boolean;
}

export interface ChromeAiDownloadProgressEvent extends Event {
    /** Fraction in `[0, 1]`. */
    readonly loaded: number;
}

export interface ChromeAiMonitor {
    addEventListener(
        type: 'downloadprogress',
        listener: (event: ChromeAiDownloadProgressEvent) => void,
    ): void;
}

export interface ChromeAiCreateOptions {
    initialPrompts?: ChromeAiMessage[];
    /** Extensions / origin-trial only; ignored (and may throw) on stable web. */
    temperature?: number;
    /** Extensions / origin-trial only. Must be paired with `temperature`. */
    topK?: number;
    signal?: AbortSignal;
    monitor?: (monitor: ChromeAiMonitor) => void;
    expectedInputs?: Array<{ type: 'text' | 'image' | 'audio'; languages?: string[] }>;
    expectedOutputs?: Array<{ type: 'text'; languages?: string[] }>;
}

export interface ChromeAiPromptOptions {
    /** JSON Schema the output must conform to. Result is then a JSON string. */
    responseConstraint?: unknown;
    /**
     * When true, the schema text is not injected into the model's context
     * (the grammar still constrains decoding). Defaults to false.
     */
    omitResponseConstraintInput?: boolean;
    signal?: AbortSignal;
}

export interface ChromeAiSession {
    prompt(input: string | ChromeAiMessage[], options?: ChromeAiPromptOptions): Promise<string>;
    promptStreaming(
        input: string | ChromeAiMessage[],
        options?: ChromeAiPromptOptions,
    ): ReadableStream<string>;
    clone(options?: { signal?: AbortSignal }): Promise<ChromeAiSession>;
    destroy(): void;
    readonly inputUsage?: number;
    readonly inputQuota?: number;
    readonly contextUsage?: number;
    readonly contextWindow?: number;
}

export interface ChromeAiParams {
    defaultTopK: number;
    maxTopK: number;
    defaultTemperature: number;
    maxTemperature: number;
}

export interface ChromeAiLanguageModelStatic {
    availability(options?: ChromeAiCreateOptions): Promise<ChromeAiRawAvailability>;
    create(options?: ChromeAiCreateOptions): Promise<ChromeAiSession>;
    params?(): Promise<ChromeAiParams | null>;
}

/**
 * Read `globalThis.LanguageModel` without a hard `declare global`, so that
 * type-checking doesn't depend on the ambient name existing and tests can
 * inject a fake. Returns undefined in environments without the API (Node,
 * non-Chromium browsers, older Chrome).
 */
export function getChromeLanguageModel(): ChromeAiLanguageModelStatic | undefined {
    const lm = (globalThis as { LanguageModel?: unknown }).LanguageModel;
    if (
        lm &&
        typeof (lm as ChromeAiLanguageModelStatic).availability === 'function' &&
        typeof (lm as ChromeAiLanguageModelStatic).create === 'function'
    ) {
        return lm as ChromeAiLanguageModelStatic;
    }
    return undefined;
}
