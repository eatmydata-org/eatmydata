/**
 * Shared runtime types.
 *
 * - `RuntimeEvent`: events the writing tab broadcasts (both locally
 *   self-delivered and posted on `BroadcastChannel('rh-runtime')`).
 *   Peer tabs apply each one against their Solid mirror.
 * - `RuntimeSnapshot`: the bootstrap blob returned by `host.getSnapshot()`
 *   on tab init.
 *
 * The "ticket" pattern is the unified mechanism for any user action
 * that must be idempotent across N tabs (confirmations today; could
 * extend to other one-shots later).
 */

import type { ChatUsage, Message, MessagePart, SubAgentRun } from '@/lib/types';
import type { Action, ActionKind, ActionVersion, DataSource } from '@/lib/actions/types';
import type { ActionExecution } from '@/lib/actions/executor';
import type { Settings } from '@/lib/runtime/state/settings-types';

export type CodeStatus = 'validating' | 'approved' | 'rejected';

export type ConfirmationDecision = {
    approved: boolean;
    response?: unknown;
};

export type ChatSession = {
    actionId: string;
    messages: Message[];
    inflightId: string | null;
    error: string | null;
    /**
     * Rolling token + USD totals across every step the agent has executed
     * in this Action. Updated after each `streamText` call (orchestrator +
     * sub-agents). Persisted onto the Action at end-of-turn.
     */
    usage: ChatUsage;
};

/** Minimal preview shape carried in drafts. Mirrors the existing
 * SavedDataSourcePreview from @/lib/types but kept here so the
 * runtime layer can be imported without dragging that file. */
export type DraftDataSourcePreview = {
    name: string;
    query: string;
    semanticDescription: string;
    typeDeclaration: string;
    sampleColumns: string[];
    sampleRows: Array<Record<string, unknown>>;
    truncated: boolean;
};

/**
 * Candidate version under thumbs-up/thumbs-down review. While set, the
 * side panel shows a `draft` pill in the version timeline; clicking it
 * surfaces `result` and `code`. Cleared on thumbs-up (after the draft
 * is committed as an ActionVersion) or on cancel. Never persisted.
 */
export type PendingReview = {
    code: string;
    codeKind: ActionKind;
    dataSources: DataSource[];
    intent: string;
    /** Populated after the orchestrator runs executeAction on the
     * candidate. Result.versionId is undefined for drafts. */
    result?: ActionExecution;
    /** Parent committed version, used as parentVersionId on commit. */
    baseVersionId?: string;
};

/** Which slot the side panel is currently displaying. Defaults to the
 * `currentVersionId` committed version when undefined. */
export type DraftViewing = { kind: 'draft' } | { kind: 'version'; id: string };

export type ActionDraft = {
    id: string;
    actionName: string;
    intent: string;
    action?: Action;
    dataSources: DraftDataSourcePreview[];
    /**
     * Finalization payload. Either JS source (when `codeKind` is `'code'`
     * or absent) or a markdown template (when `codeKind` is `'markdown'`).
     * Kept in a single field so the panel UI can branch on `codeKind`.
     */
    code?: string;
    codeKind?: ActionKind;
    codeStatus?: CodeStatus;
    latestResult?: ActionExecution;
    versions: ActionVersion[];
    currentVersionId?: string;
    inflight: boolean;
    pendingReview?: PendingReview;
    viewing?: DraftViewing;
};

export type TicketState = 'pending' | 'resolved' | 'expired';

export type Ticket = {
    id: string;
    actionId: string;
    /** Stable kind for analytics + (optionally) renderer dispatch.
     * The actual UI renderer is selected by the confirmation
     * MessagePart's `rendererId`. */
    kind: string;
    createdAt: number;
    state: TicketState;
    decision?: ConfirmationDecision;
    resolvedAt?: number;
};

export type RuntimeSnapshot = {
    sessions: Record<string, ChatSession>;
    drafts: Record<string, ActionDraft>;
    activeActionId: string | undefined;
    results: Record<string, ActionExecution>;
    tickets: Record<string, Ticket>;
    settings: Settings;
};

export type SessionPatch = Partial<Omit<ChatSession, 'actionId'>> & {
    /** When set, the session was deleted entirely. */
    removed?: true;
};

export type DraftPatch = Partial<Omit<ActionDraft, 'id'>> & {
    removed?: true;
};

export type ActionListPatch = {
    /** Replaces the entire cached recent-actions list. Worker emits
     * this on any IDB write that could affect listing order. */
    actions: Action[];
};

export type ResultPatch = ActionExecution & { removed?: never };

export type SettingsPatch = Partial<Settings>;

export type ActiveActionPatch = { activeActionId: string | undefined };

export type RuntimeEvent =
    // Bulk session updates (hydration, error, inflight, removal).
    | { kind: 'session-patch'; actionId: string; patch: SessionPatch }
    // Fine-grained streaming events — emitted per LLM token / part /
    // tool-call update. Tabs apply each one with a path-specific
    // setStore so Solid only re-renders the changed leaf.
    | {
          kind: 'session-text-append';
          actionId: string;
          stepId: string;
          delta: string;
      }
    | {
          kind: 'session-reasoning-append';
          actionId: string;
          stepId: string;
          delta: string;
      }
    | {
          kind: 'session-part-added';
          actionId: string;
          stepId: string;
          part: MessagePart;
      }
    | {
          kind: 'session-part-updated';
          actionId: string;
          stepId: string;
          toolCallId: string;
          patch: Partial<MessagePart>;
      }
    | {
          kind: 'session-message-appended';
          actionId: string;
          message: Message;
      }
    | {
          kind: 'session-message-aborted';
          actionId: string;
          msgId: string;
      }
    | {
          kind: 'session-sweep-unresolved';
          actionId: string;
          stepId: string;
          reason: string;
      }
    | {
          kind: 'session-sub-agent-patch';
          actionId: string;
          stepId: string;
          runId: string;
          patch: Partial<SubAgentRun>;
      }
    | {
          kind: 'session-sub-agent-message-appended';
          actionId: string;
          stepId: string;
          runId: string;
          message: Message;
      }
    | {
          kind: 'session-sub-agent-message-mutated';
          actionId: string;
          stepId: string;
          runId: string;
          childStepId: string;
          // What to do with the child message. Mirrors top-level
          // events so the tab applies them identically inside the
          // sub-agent's nested message array.
          op:
              | { kind: 'text-append'; delta: string }
              | { kind: 'reasoning-append'; delta: string }
              | { kind: 'part-added'; part: MessagePart }
              | {
                    kind: 'part-updated';
                    toolCallId: string;
                    patch: Partial<MessagePart>;
                }
              | { kind: 'sweep-unresolved'; reason: string };
      }
    // Other domains.
    | { kind: 'draft-patch'; actionId: string; patch: DraftPatch }
    | { kind: 'active-action'; activeActionId: string | undefined }
    | { kind: 'action-list-patch'; patch: ActionListPatch }
    | { kind: 'result-patch'; resultId: string; result: ActionExecution }
    | { kind: 'settings-patch'; patch: SettingsPatch }
    | { kind: 'ticket-opened'; ticket: Ticket }
    | { kind: 'ticket-resolved'; ticketId: string; decision: ConfirmationDecision }
    | { kind: 'ticket-expired'; ticketId: string }
    /**
     * Force-restart signal from Settings → Force restart. Every tab
     * receiving this (including the writer, via self-delivery) reloads.
     */
    | { kind: 'runtime-restart' }
    /**
     * Tab opens an action and asks any peer that already has live state
     * for a snapshot. `requesterId` echoes back so the asker can filter
     * to responses meant for it.
     */
    | { kind: 'snapshot-request'; actionId: string; requesterId: string }
    /**
     * Peer's response with a current snapshot of session (and optional
     * draft) for an action. The requester replaces its mirror entries.
     */
    | {
          kind: 'snapshot-response';
          actionId: string;
          requesterId: string;
          session: ChatSession;
          draft?: ActionDraft;
      };

export const RUNTIME_CHANNEL = 'rh-runtime';

/** Re-export so callers needing DataSource don't have to import from
 * the actions layer twice. */
export type { Action, ActionKind, ActionVersion, DataSource, ActionExecution };
