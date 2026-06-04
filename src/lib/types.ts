export type Role = 'system' | 'user' | 'assistant';

export type AgentId = 'orchestrator' | 'planner' | 'coder';

export type PlanInput = {
    summary: string;
    tables: string[];
    columns: string[];
    intended_queries: string[];
};

export type ToolStatus = 'pending' | 'running' | 'ok' | 'error';

export type SavedQuery = {
    name: string;
    sql: string;
    description: string;
};

export type SavedDataSourcePreview = {
    name: string;
    query: string;
    semanticDescription: string;
    /** TypeScript declaration (`type Foo = Array<{...}>;` + `declare const ...`). */
    typeDeclaration: string;
    /** Sanitized sample columns + rows (already perturbed) for visual review. */
    sampleColumns: string[];
    sampleRows: Array<Record<string, unknown>>;
    truncated: boolean;
};

export type SubAgentStatus = 'running' | 'done' | 'error' | 'cancelled';

export type SubAgentRun = {
    runId: string;
    agentId: AgentId;
    agentName: string;
    kickoff: string;
    messages: Message[];
    inflightId: string | null;
    status: SubAgentStatus;
    result?: string;
    error?: string;
};

export type MessagePart =
    | { kind: 'text'; id: string; text: string }
    | { kind: 'reasoning'; id: string; text: string }
    /** A free-text reply the user typed into the composer to answer a parked
     * confirmation (e.g. the explanation after a thumbs-down review). Rendered
     * as a normal right-aligned user balloon, in timeline order, so the user's
     * input is visible in the chat just like a regular message. */
    | { kind: 'user-note'; id: string; text: string }
    | {
          kind: 'tool-call';
          toolCallId: string;
          toolName: string;
          input: unknown;
          status: ToolStatus;
          result?: unknown;
          error?: string;
      }
    | {
          kind: 'confirmation';
          toolCallId: string;
          agent?: AgentId;
          rendererId: string;
          payload: unknown;
          approved: boolean | null;
          /** Structured payload returned by the renderer alongside the
           * approve/reject signal (e.g. which of several approve buttons was
           * clicked). Required by multi-button cards to highlight the
           * selected option after the decision resolves. */
          response?: unknown;
          decidedAt?: number;
      }
    | { kind: 'saved-query'; toolCallId: string; query: SavedQuery }
    | {
          kind: 'saved-data-source';
          toolCallId: string;
          status: 'validating' | 'ok' | 'error';
          preview?: SavedDataSourcePreview;
          error?: string;
      }
    | { kind: 'sub-agent'; runId: string; run: SubAgentRun }
    | {
          kind: 'action-result-link';
          resultId: string;
          actionName: string;
          /** 1-based index in the committed-versions list at the time
           * this chip was emitted. Rendered as "v3 saved" in the chat
           * rail. */
          versionIndex?: number;
          createdAt: number;
      }
    | {
          kind: 'action-failed';
          reason:
              | 'planner-error'
              | 'planner-empty'
              | 'planner-aborted'
              | 'coder-error'
              | 'coder-empty'
              | 'coder-aborted'
              | 'persistence-error';
          /** User's original intent — used as the default "Retry" payload. */
          intent: string;
          /** Sidebar/title text for the action that was being attempted. */
          actionName: string;
          /** Optional one-liner detail (sub-agent error, persistence error). */
          detail?: string;
          createdAt: number;
      };

export type Message = {
    id: string;
    role: Role;
    content: string;
    createdAt: number;
    aborted?: boolean;
    agent?: AgentId;
    parts?: MessagePart[];
};

export type ChatState = {
    messages: Message[];
    inflightId: string | null;
    error: string | null;
    modelId: string;
};

/**
 * Rolling token + USD totals for a chat. Accumulates across every step the
 * agent runs in a single Action — orchestrator and every spawned sub-agent
 * roll up into the same counter.
 */
export type ChatUsage = {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cachedInputTokens: number;
    /** Accumulated USD spend. 0 when the chat has only run unpriced models. */
    costUsd: number;
};

export const ZERO_USAGE: ChatUsage = {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    costUsd: 0,
};
