import type { LanguageModelV3 } from '@ai-sdk/provider';
import { findModelEntry, getSettings } from '@/lib/runtime/state/settings';
import { allModels, type AgentModelKey, type ModelEntry } from '@/lib/runtime/state/settings-types';
import { getRegistry } from './registry';

export type ModelChoice = ModelEntry;

export function findModel(id: string): ModelChoice {
    return findModelEntry(id);
}

/**
 * The model id an agent should run with, or `undefined` to inherit the
 * caller's primary model. Read at agent spawn time (see {@link runAgent}'s
 * `findModel(definition.modelId ?? args.modelId)`): when "use one model for
 * all" is on, or the agent has no override, returns `undefined` so the loop
 * falls back to the primary (`defaultModelId`).
 */
export function resolveAgentModelId(agentId: AgentModelKey): string | undefined {
    const s = getSettings();
    if (s.useOneModelForAll) return undefined;
    return s.agentModels?.[agentId];
}

export function availableModels(): ModelChoice[] {
    return allModels(getSettings().providers);
}

/**
 * Resolve a fully-qualified model id (`providerId:modelId`) to a callable
 * `LanguageModelV3` via the AI SDK provider registry. The chrome-ai
 * provider is resolved through the registry too (a `customProvider`).
 */
export function createModel(fqid: string): LanguageModelV3 {
    // The registry types model ids as the template literal
    // `${providerId}:${modelId}`; our ids are plain strings built the same way.
    return getRegistry().languageModel(fqid as `${string}:${string}`);
}
