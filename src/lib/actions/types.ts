import type { ChatUsage, Message } from '@/lib/types';

export type DataSourceType = 'sql';

export type DataSource = {
    id: string;
    name: string;
    type: DataSourceType;
    query: string;
    semanticDescription: string;
    /** TypeScript declaration for the rows this source produces. */
    typeDeclaration: string;
    /**
     * @deprecated Sample rows are AGENT-RUNTIME ONLY. They are perturbed /
     * synthetic and must never be persisted on an Action or ActionVersion —
     * doing so makes the panel show synthetic rows as if they were real
     * results after reload. Field kept optional only to read legacy rows
     * already in IDB; new writes must omit it.
     */
    sampleData?: never;
};

export type ActionOutputFormat = 'markdown' | 'html' | 'json' | 'echarts' | 'blocks';

/**
 * Wire-tag discriminants the sandbox emits for the composable block model.
 * The Coder builds blocks via the `md()` / `chart()` / `table()` globals and
 * composes them with `present(...)`, which sets `__output` to a
 * `{ __kind: 'blocks', blocks: [...] }` wrapper. These are plain JSON objects
 * so they persist to IDB unchanged.
 */
export const BLOCK_KIND = 'block' as const;
export const BLOCKS_KIND = 'blocks' as const;

/**
 * Renderer-side normalized block — what `toBlocks()` produces and
 * `ResultBlocks` consumes. The wire tags carry a `type` field; normalization
 * maps it to `kind` and derives missing table columns. Every `table` block
 * renders in the interactive AG-Grid (small results auto-size to content,
 * large ones get a bounded, virtualized box) — there is no inline/markdown
 * table path.
 */
export type ResultBlock =
    | { kind: 'markdown'; text: string }
    | { kind: 'chart'; option: Record<string, unknown> }
    | {
          kind: 'table';
          columns: string[];
          rows: Array<Record<string, unknown>>;
          title?: string;
          caption?: string;
      };

/**
 * Coder finalization mode for an Action / ActionVersion.
 *
 *   - `code`     — `code` is JavaScript that assigns its answer to `__output`.
 *                  This is the legacy (and default) shape.
 *   - `markdown` — `code` is a markdown TEMPLATE with `${expr}` JS interpolations
 *                  against the data-source globals. The executor wraps it as
 *                  `__output = \`<template>\`;` and runs it through the same
 *                  QuickJS sandbox — there is only ONE evaluation engine.
 *
 * Field is optional for backward compat with rows persisted before this
 * discriminator existed; readers treat `undefined` as `'code'`.
 */
export type ActionKind = 'code' | 'markdown';

export type Action = {
    id: string;
    /**
     * Human-readable English title (e.g. "Top customers by revenue"), not an
     * identifier-style name. Set to "New Action" when the row is first
     * persisted (on the user's first message), then overwritten by the LLM
     * via the `work_on_action` tool once it picks a real title.
     */
    name: string;
    description: string;
    dataSources: DataSource[];
    /**
     * Either JS source (when `kind` is `'code'` or absent) or a markdown
     * template with `${expr}` interpolations (when `kind` is `'markdown'`).
     * The executor branches on `kind` to decide how to feed this into the
     * sandbox.
     */
    code: string | null;
    /** Finalization mode; missing means `'code'`. See `ActionKind`. */
    kind?: ActionKind;
    /**
     * Live conversation log for this action. Continuously updated at the end
     * of every chat turn (when `inflightId` flips back to null). Empty for
     * actions persisted before this field became live (read defensively).
     */
    chatLog: Message[];
    createdAt: number;
    updatedAt: number;
    /**
     * Pointer to the head ActionVersion: the version the user is currently
     * viewing. Iterations advance this; revert sets it to an older one.
     * Optional for backward compat with actions persisted before versioning
     * existed.
     */
    currentVersionId?: string;
    /**
     * Data source this Action queries against. Resolves to one of the rows
     * in the `data_sources` IDB store. Optional for backward compat: legacy
     * actions fall back to the default in-memory SQLite DB.
     */
    dataSourceId?: string;
    /**
     * Lifetime token + USD totals for this Action's chat. Persisted at the
     * end of every turn so a reload restores the running cost. Optional for
     * backward compat with rows persisted before this field existed.
     */
    usage?: ChatUsage;
    /**
     * A candidate iteration awaiting the user's thumbs-up/down review,
     * persisted so a window reload (or a tab that never ran the loop) can
     * still render it on the Action panel AND commit/reject it — the live
     * draft's `pendingReview` (in `ActionDraft`) is otherwise in-memory only.
     * Set when the review card opens; cleared on commit (it becomes an
     * `ActionVersion`) or reject. Absent on rows persisted before this field.
     */
    pendingReview?: PersistedPendingReview;
};

/**
 * Durable snapshot of an in-review candidate (the in-memory counterpart is
 * `ActionDraft.pendingReview`). Carries everything `commitReviewCandidate`
 * needs to materialize a version without the orchestrator loop, plus what the
 * panel needs to render the candidate after reload. `resultId` points at the
 * `ActionExecution` already in the results store (optional: hydration falls
 * back to the action's latest result when missing).
 */
export type PersistedPendingReview = {
    actionName: string;
    intent: string;
    code: string;
    kind?: ActionKind;
    /** Full snapshot — never includes `sampleData` (see `DataSource`). */
    dataSources: DataSource[];
    baseVersionId?: string;
    resultId?: string;
};

/**
 * A single accepted iteration of an Action: a snapshot of {code, dataSources}
 * plus the intent that produced it. The user navigates between these via the
 * panel timeline.
 *
 * Versions are deduped per-action by `contentHash` (stable hash of code +
 * data-source queries) — re-executing the identical params re-uses the same
 * row and only adds a new ActionExecution.
 */
export type ActionVersion = {
    id: string;
    actionId: string;
    contentHash: string;
    intent: string;
    /**
     * Either JS source (when `kind` is `'code'` or absent) or a markdown
     * template with `${expr}` interpolations (when `kind` is `'markdown'`).
     */
    code: string;
    /** Finalization mode; missing means `'code'`. See `ActionKind`. */
    kind?: ActionKind;
    /** Full snapshot — queries can be edited later, refs would rot. */
    dataSources: DataSource[];
    /** The version this one branched from. Undefined for the root. */
    parentVersionId?: string;
    createdAt: number;
};
