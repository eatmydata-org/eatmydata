import type { ProviderKind } from '@/lib/runtime/state/settings-types';
import type { ProviderAdapter } from './types';
import { openRouterAdapter } from './openrouter';
import { googleAdapter } from './google';
import { openAICompatibleAdapter } from './openai-compatible';
import { chromeAiAdapter } from './chrome-ai';

export type { ProviderAdapter, ConnectionTestResult, CatalogModel } from './types';

const ADAPTERS: Record<ProviderKind, ProviderAdapter> = {
    openrouter: openRouterAdapter,
    'google-ai-studio': googleAdapter,
    'openai-compatible': openAICompatibleAdapter,
    'chrome-ai': chromeAiAdapter,
};

/** The capability adapter for a provider kind. */
export function adapterFor(kind: ProviderKind): ProviderAdapter {
    return ADAPTERS[kind];
}

/** All adapters, in the order they appear in the "Add provider" picker. */
export const PROVIDER_ADAPTERS: ProviderAdapter[] = [
    openRouterAdapter,
    googleAdapter,
    openAICompatibleAdapter,
    chromeAiAdapter,
];
