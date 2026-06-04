import type { AgentId } from '@/lib/types';
import type { AgentDefinition } from '../agent-def';
import { orchestratorAgent } from './orchestrator';
import { plannerAgent } from './planner';
import { coderAgent } from './coder';

export type AgentFactory = (kickoffContext?: unknown) => AgentDefinition;

export const agentRegistry: Partial<Record<AgentId, AgentFactory>> = {
    orchestrator: orchestratorAgent,
    planner: plannerAgent,
    coder: coderAgent,
};
