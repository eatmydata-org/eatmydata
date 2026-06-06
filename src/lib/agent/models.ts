import type { LanguageModelV3 } from '@ai-sdk/provider';
import { findModelEntry, getSettings } from '@/lib/runtime/state/settings';
import {
    allModels,
    resolveAgentModel,
    type AgentModelKey,
    type ModelEntry,
} from '@/lib/runtime/state/settings-types';
import { getRegistry } from './registry';

export type ModelChoice = ModelEntry;

export function findModel(id: string): ModelChoice {
    return findModelEntry(id);
}

/**
 * The model id an agent runs with: its saved pick when that model is still in
 * the enabled `@app-config` catalog, otherwise the config default (see
 * {@link resolveAgentModel}). Always concrete — the loop's
 * `findModel(definition.modelId ?? args.modelId)` therefore uses each agent's
 * own resolved model rather than inheriting the caller's.
 */
export function resolveAgentModelId(agentId: AgentModelKey): string {
    const s = getSettings();
    return resolveAgentModel(s.providers, s.agentModels, agentId);
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
