/**
 * Detection + lifecycle helpers for Chrome's built-in Prompt API.
 *
 * Pure (no Solid). The reactive wrapper the UI consumes lives in
 * `@/lib/runtime/chrome-ai-status`.
 */

import { getChromeLanguageModel, type ChromeAiRawAvailability } from './types';

/**
 * Normalized availability used throughout the app:
 * - `unsupported`  — `globalThis.LanguageModel` is absent (Node, non-Chromium,
 *                    or a Chrome too old / without the flag).
 * - `unknown`      — present but not probed yet (initial reactive state only).
 * - `unavailable`  — present, but the device/model can't serve it at all.
 * - `downloadable` — usable after a one-time on-device model download.
 * - `downloading`  — the model is currently downloading.
 * - `available`    — ready to use right now.
 */
export type ChromeAiStatus =
    | 'unsupported'
    | 'unknown'
    | 'unavailable'
    | 'downloadable'
    | 'downloading'
    | 'available';

/** True when the Prompt API global exists in this context. */
export function isChromeAiPresent(): boolean {
    return getChromeLanguageModel() !== undefined;
}

/** Map a raw `availability()` string (current or legacy) to {@link ChromeAiStatus}. */
export function normalizeAvailability(raw: ChromeAiRawAvailability): ChromeAiStatus {
    switch (raw) {
        case 'available':
        case 'readily':
            return 'available';
        case 'downloadable':
        case 'after-download':
            return 'downloadable';
        case 'downloading':
            return 'downloading';
        case 'unavailable':
        case 'no':
            return 'unavailable';
        default:
            // New string we don't recognize yet: treat as unavailable rather
            // than silently claiming readiness.
            console.warn('[chrome-ai] unrecognized availability():', raw);
            return 'unavailable';
    }
}

/** Probe live availability. Never throws — failures normalize to a status. */
export async function probeChromeAiAvailability(): Promise<ChromeAiStatus> {
    const lm = getChromeLanguageModel();
    if (!lm) return 'unsupported';
    try {
        return normalizeAvailability(await lm.availability());
    } catch (e) {
        console.error('[chrome-ai] availability() threw:', e);
        return 'unavailable';
    }
}

/** The model can be used now (no further download required). */
export function isChromeAiReady(status: ChromeAiStatus): boolean {
    return status === 'available';
}

/**
 * Trigger the one-time on-device model download by creating (then discarding)
 * a session. Resolves to the post-download status. Reports progress in `[0,1]`.
 */
export async function downloadChromeAiModel(
    onProgress?: (loaded: number) => void,
    signal?: AbortSignal,
): Promise<ChromeAiStatus> {
    const lm = getChromeLanguageModel();
    if (!lm) throw new Error('Chrome AI (Prompt API) is not available in this browser.');
    const session = await lm.create({
        signal,
        monitor(m) {
            m.addEventListener('downloadprogress', (e) => onProgress?.(e.loaded));
        },
    });
    // We only wanted to force the download; release the on-device session.
    try {
        session.destroy();
    } catch (e) {
        console.warn('[chrome-ai] destroy() after warm-up download failed:', e);
    }
    return probeChromeAiAvailability();
}
