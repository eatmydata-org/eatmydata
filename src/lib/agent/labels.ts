import type { AgentId } from '@/lib/types';

const LABELS: Record<AgentId, string> = {
    orchestrator: 'Orchestrator',
    planner: 'Planner',
    coder: 'Coder',
};

export function agentLabel(id: AgentId | undefined): string {
    if (!id) return 'Orchestrator';
    return LABELS[id] ?? 'Orchestrator';
}

const INITIALS: Record<AgentId, string> = {
    orchestrator: 'Or',
    planner: 'Pl',
    coder: 'Co',
};

export function agentInitials(id: AgentId | undefined): string {
    if (!id) return 'Or';
    return INITIALS[id] ?? 'Or';
}
