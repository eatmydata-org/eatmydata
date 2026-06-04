import type { ToolSet } from 'ai';
import type { AgentId } from '@/lib/types';
import type { AgentControls } from './loop';
import type { ToolResult } from './tools';

export type SubAgentKickoff = {
    instruction: string;
    context?: Record<string, unknown>;
};

export type SubAgentResult =
    | { ok: true; summary: string; data?: unknown }
    | { ok: false; error: string };

export type AgentRunCtx = {
    controls: AgentControls;
    stepId: string;
    toolCallId: string;
    signal: AbortSignal;
    /**
     * Per-run mutable scratch space, stable across all tool calls in one
     * `runAgent` invocation. Tools that need to accumulate state across steps
     * (e.g. the Planner's data-source drafts) read/write here. Reset for every
     * new sub-agent run.
     */
    runState: Record<string, unknown>;
    spawn: (
        childId: AgentId,
        kickoff: SubAgentKickoff,
    ) => Promise<SubAgentResult>;
};

export type ToolExecutorResult = ToolResult & { terminate?: boolean };

export type ToolExecutor = (
    input: unknown,
    ctx: AgentRunCtx,
) => Promise<ToolExecutorResult>;

export type IdleTurnOutcome = {
    /** When true, the agent loop keeps going; the optional message is added
     *  to the conversation as if it were a user turn so the LLM can react.
     *  When false, the loop exits. */
    continue: boolean;
    /** Inserted as a user-role message before the next iteration. */
    feedbackForLLM?: string;
};

export type OnIdleTurn = (ctx: AgentRunCtx) => Promise<IdleTurnOutcome>;

export type AgentDefinition = {
    id: AgentId;
    name: string;
    /**
     * Static prompt string, or a getter that produces one per step. The agent
     * loop resolves the getter on every `runOneStep` call so the orchestrator
     * can inject the active action's data-source manifest into the prompt
     * without re-creating the AgentDefinition each turn.
     */
    systemPrompt: string | (() => string);
    tools: ToolSet;
    toolExecutors: Record<string, ToolExecutor>;
    modelId?: string;
    /**
     * Optional hook fired when the model responds with text and no tool
     * calls. Lets the agent react — e.g. the Planner uses this as the
     * implicit "I'm done saving sources" signal and asks the user to approve
     * the current draft set. If the hook is absent, the loop exits as before.
     */
    onIdleTurn?: OnIdleTurn;
};
