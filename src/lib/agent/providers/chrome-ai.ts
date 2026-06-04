import {
    isChromeAiPresent,
    isChromeAiReady,
    probeChromeAiAvailability,
} from '@/lib/agent/chrome-ai/availability';
import type { ProviderAdapter } from './types';
import { timedProbe } from './types';

/**
 * On-device Chrome AI adapter. No API key, no base URL, no pricing — its
 * "connection test" is the Prompt API availability probe. The Settings UI
 * renders the download/status surface for this kind instead of a key field.
 */
export const chromeAiAdapter: ProviderAdapter = {
    kind: 'chrome-ai',
    label: 'Chrome AI (on-device)',
    requiresApiKey: false,
    baseURL: 'none',
    canFetchPrices: false,

    testConnection() {
        return timedProbe(async () => {
            if (!isChromeAiPresent()) {
                return {
                    ok: false,
                    message:
                        'Not available in this browser (needs a recent Chrome/Edge with the built-in model).',
                };
            }
            const status = await probeChromeAiAvailability();
            if (isChromeAiReady(status)) return { ok: true, label: 'on-device model ready' };
            return { ok: false, message: `Model ${status}` };
        });
    },
};
