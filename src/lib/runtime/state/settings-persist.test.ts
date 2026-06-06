import { afterEach, describe, expect, it } from 'vitest';
import { createStore } from 'solid-js/store';
import { getSettings, patchSettings } from './settings';
import { setLocalListener } from './broadcast';
import { defaultSettings, type ProviderInstance, type Settings } from './settings-types';

// Regression: the Settings UI builds patches by mapping the live Solid
// `providers` store, so a patch can carry store PROXIES. Both IDB persist and
// the broadcast self-delivery `structuredClone` the patch, which throws on a
// proxy — silently dropping the change (no save, mirror never updates).
// `patchSettings` must normalize to a plain graph so this round-trips.

afterEach(() => setLocalListener(() => {}));

describe('patchSettings with Solid-store-proxy patches', () => {
    it('self-delivers to the mirror and persists pricing set via the store', () => {
        // A Solid store mirrors what the Settings page reads from.
        const [mirror] = createStore<Settings>(defaultSettings());

        // Build the patch exactly like the UI: map over the live store and
        // attach pricing to a Google model. The nested objects are proxies.
        const providers: ProviderInstance[] = mirror.providers.map((p) =>
            p.kind === 'google-ai-studio'
                ? {
                      ...p,
                      models: p.models.map((m) => ({
                          ...m,
                          pricing: { prompt: 1e-7, completion: 4e-7 },
                      })),
                  }
                : p,
        );

        // Without the JSON normalization in patchSettings, structuredClone of
        // this event throws and the listener is never called.
        const received: unknown[] = [];
        setLocalListener((e) => received.push(e));

        patchSettings({ providers });

        expect(received.length).toBe(1); // self-delivery succeeded (no clone throw)

        const google = getSettings().providers.find((p) => p.kind === 'google-ai-studio')!;
        expect(google.models[0]!.pricing).toEqual({ prompt: 1e-7, completion: 4e-7 });

        // The persisted graph must be structured-cloneable (what IDB does).
        expect(() => structuredClone(getSettings())).not.toThrow();
    });

    it('persists an agent-to-(provider+model) binding', () => {
        const [mirror] = createStore<Settings>(defaultSettings());
        const googleModelId = mirror.providers.find((p) => p.kind === 'google-ai-studio')!
            .models[0]!.id;
        patchSettings({ agentModels: { coder: googleModelId } });
        expect(getSettings().agentModels.coder).toBe(googleModelId);
    });
});
