/**
 * Tab-side reactive wrapper around Chrome AI availability.
 *
 * The probe is async and per-tab (the Prompt API global is only exposed on
 * the main thread, which is where the agent loop now runs). This module owns
 * a single Solid signal mirroring the live status, kicks the first probe off
 * lazily, and exposes a download helper for the Settings page.
 */

import { createSignal } from 'solid-js';
import {
    downloadChromeAiModel,
    isChromeAiPresent,
    probeChromeAiAvailability,
    type ChromeAiStatus,
} from '@/lib/agent/chrome-ai/availability';

const [status, setStatus] = createSignal<ChromeAiStatus>(
    isChromeAiPresent() ? 'unknown' : 'unsupported',
);

let probeStarted = false;

/** Run the availability probe once and push the result into the signal. */
export function refreshChromeAiStatus(): Promise<ChromeAiStatus> {
    return probeChromeAiAvailability().then((s) => {
        setStatus(s);
        return s;
    });
}

/** Kick off the first probe lazily (idempotent). Safe to call from render. */
export function ensureChromeAiProbe(): void {
    if (probeStarted) return;
    probeStarted = true;
    void refreshChromeAiStatus().catch((e) =>
        console.error('[chrome-ai] initial availability probe failed:', e),
    );
}

/** Reactive accessor for the current normalized status. */
export function useChromeAiStatus() {
    ensureChromeAiProbe();
    return status;
}

/** True when Chrome AI can serve requests right now. */
export function chromeAiReady(): boolean {
    return status() === 'available';
}

/**
 * Download the on-device model (driving the Settings progress UI), then
 * refresh the signal to the post-download status.
 */
export async function startChromeAiDownload(
    onProgress?: (loaded: number) => void,
    signal?: AbortSignal,
): Promise<ChromeAiStatus> {
    setStatus('downloading');
    try {
        const next = await downloadChromeAiModel(onProgress, signal);
        setStatus(next);
        return next;
    } catch (e) {
        // Refresh so we don't get stuck showing "downloading" after a failure.
        await refreshChromeAiStatus();
        throw e;
    }
}
