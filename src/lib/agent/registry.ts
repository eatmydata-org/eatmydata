/**
 * Model resolution via the Vercel AI SDK provider registry.
 *
 * Every model is referenced by a fully-qualified id `providerId:modelId`.
 * `createProviderRegistry(map, { separator: ':' })` splits that on the
 * FIRST colon, so OpenRouter slugs that themselves contain a colon
 * (`openai/gpt-oss-120b:free`) resolve correctly: provider `openrouter`,
 * model `openai/gpt-oss-120b:free`.
 *
 * The registry is rebuilt only when provider config changes — memoized by
 * a cheap signature so per-agent `createModel` calls are essentially free.
 */

import type { LanguageModelV3, ProviderV3 } from '@ai-sdk/provider';
import { createProviderRegistry, customProvider, type ProviderRegistryProvider } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { getSettings } from '@/lib/runtime/state/settings';
import type { ProviderInstance } from '@/lib/runtime/state/settings-types';
import { createChromeAi } from './chrome-ai/provider';

let cachedSig = '';
let cachedRegistry: ProviderRegistryProvider | null = null;

/** Cheap fingerprint of the bits of provider config that affect resolution. */
function signature(providers: ProviderInstance[]): string {
    return providers
        .map((p) => `${p.id}|${p.kind}|${p.enabled ? 1 : 0}|${p.apiKey ?? ''}|${p.baseURL ?? ''}`)
        .join('\n');
}

/** Build the AI SDK provider for one configured instance, or null if unusable. */
function buildProvider(p: ProviderInstance): ProviderV3 | null {
    switch (p.kind) {
        case 'openrouter':
            return createOpenRouter({
                apiKey: p.apiKey,
                // OpenRouter only returns cached/reasoning token detail —
                // which cost.ts:extractUsageCounts reads — when usage
                // accounting is requested on every call.
                extraBody: { usage: { include: true } },
            }) as ProviderV3;
        case 'google-ai-studio':
            return createGoogleGenerativeAI({
                apiKey: p.apiKey,
            }) as ProviderV3;
        case 'openai-compatible':
            // Base URL is mandatory for an OpenAI-compatible endpoint.
            if (!p.baseURL) return null;
            return createOpenAICompatible({
                name: p.id,
                baseURL: p.baseURL,
                ...(p.apiKey ? { apiKey: p.apiKey } : {}),
            }) as ProviderV3;
        case 'chrome-ai': {
            // One on-device model object, mapped under every model slug the
            // chrome-ai provider declares (normally just `gemini-nano`).
            const chromeModel = createChromeAi().chat();
            const languageModels: Record<string, LanguageModelV3> = {};
            for (const m of p.models) languageModels[m.modelId] = chromeModel;
            if (Object.keys(languageModels).length === 0) {
                languageModels['gemini-nano'] = chromeModel;
            }
            return customProvider({ languageModels }) as ProviderV3;
        }
    }
}

function buildRegistry(providers: ProviderInstance[]): ProviderRegistryProvider {
    const map: Record<string, ProviderV3> = {};
    for (const p of providers) {
        if (!p.enabled) continue;
        const provider = buildProvider(p);
        if (provider) map[p.id] = provider;
    }
    return createProviderRegistry(map, { separator: ':' });
}

/** The current registry, rebuilt only when provider config has changed. */
export function getRegistry(): ProviderRegistryProvider {
    const providers = getSettings().providers;
    const sig = signature(providers);
    if (cachedRegistry && sig === cachedSig) return cachedRegistry;
    cachedRegistry = buildRegistry(providers);
    cachedSig = sig;
    return cachedRegistry;
}
