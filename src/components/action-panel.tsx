import { For, Show, createMemo, createSignal, type Component } from 'solid-js';
import {
    activeAction,
    focusVersion,
    type ActionDraft,
    type CodeStatus,
} from '@/lib/actions/action-live-store';
import type { ActionVersion } from '@/lib/actions/types';
import type { ActionExecution, ActionKind, DraftViewing } from '@/lib/runtime/api';
import { runtime } from '@/lib/runtime/client';
import { Button } from '@/registry/ui/button';
import { ActionResultView } from './action-result-view';
import { DataSourceCard } from './data-source-card';

/**
 * Right-side panel that mirrors the action the user is working on. Always
 * mounted (non-closable) — shows an empty placeholder when no action is
 * active, then populates progressively:
 *   1) a small toolbar (re-run / open in new window) above the result
 *   2) result (the primary thing the user wants to see)
 *   3) version timeline strip (visible if any versions exist) — includes a
 *      `draft` pill while a candidate is under thumbs-up review
 *   4) data sources list (streams in from the Planner or seeded from a
 *      previous version when iterating)
 *   5) code preview (validating / rejected status while a draft validates)
 *
 * The panel reads from action-live-store; it does NOT own state.
 */
export const ActionPanel: Component = () => {
    const draft = () => activeAction();

    return (
        <div class="h-full flex flex-col border-l bg-background min-h-0">
            <div class="flex-1 min-h-0 overflow-y-auto">
                <Show when={draft()} fallback={<EmptyState />}>
                    <PanelBody draft={draft()!} />
                </Show>
            </div>
        </div>
    );
};

const EmptyState: Component = () => (
    <div class="h-full flex items-center justify-center px-6 text-center">
        <div class="max-w-xs flex flex-col items-center gap-2 text-muted-foreground">
            <div class="size-10 rounded-md border border-dashed grid place-items-center">
                <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.5"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    class="size-5"
                >
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <line x1="9" y1="9" x2="15" y2="9" />
                    <line x1="9" y1="13" x2="15" y2="13" />
                    <line x1="9" y1="17" x2="13" y2="17" />
                </svg>
            </div>
            <p class="text-xs">No action yet. Send a message to build one.</p>
        </div>
    </div>
);

/**
 * Which slot the panel is displaying — derived from `draft.viewing` with
 * a fallback to draft (when pendingReview exists) or to the current
 * committed version otherwise. `viewing` is also where data sources +
 * code preview source from, since the draft data may diverge from the
 * committed version's.
 */
function resolveViewing(draft: ActionDraft): DraftViewing {
    if (draft.viewing) return draft.viewing;
    if (draft.pendingReview) return { kind: 'draft' };
    if (draft.currentVersionId) return { kind: 'version', id: draft.currentVersionId };
    return { kind: 'draft' };
}

const PanelBody: Component<{ draft: ActionDraft }> = (props) => {
    const draft = () => props.draft;
    const viewing = createMemo<DraftViewing>(() => resolveViewing(draft()));
    const displayedResult = createMemo(() => pickResult(draft(), viewing()));
    return (
        <div class="flex flex-col gap-4 px-4 py-3">
            <Show when={displayedResult()}>
                <PanelToolbar draft={draft()} result={displayedResult()!} />
            </Show>

            <ResultSection draft={draft()} viewing={viewing()} />

            <Show when={draft().versions.length > 0 || draft().pendingReview}>
                <VersionTimeline draft={draft()} viewing={viewing()} />
            </Show>

            <DataSourcesSection draft={draft()} />

            <Show when={pickCode(draft(), viewing())}>
                <CodeSection draft={draft()} viewing={viewing()} />
            </Show>
        </div>
    );
};

/**
 * Compact two-button toolbar above the result: re-run the action's current
 * version and open the displayed result in a standalone window. Replaces
 * the old panel header.
 */
const PanelToolbar: Component<{
    draft: ActionDraft;
    result: ActionExecution;
}> = (props) => {
    const [rerunning, setRerunning] = createSignal(false);
    const handleRerun = async () => {
        const id = props.draft.action?.id;
        if (!id || rerunning()) return;
        setRerunning(true);
        try {
            await runtime.rerunAction(id);
        } catch (e) {
            console.warn('[ActionPanel] rerunAction failed', e);
        } finally {
            setRerunning(false);
        }
    };
    return (
        <div class="flex items-center gap-2">
            <Button
                size="sm"
                variant="secondary"
                onClick={handleRerun}
                disabled={rerunning() || !props.draft.action}
            >
                {rerunning() ? 'Re-running…' : '↻ Re-run'}
            </Button>
            <Button
                as="a"
                size="sm"
                variant="ghost"
                href={`/result/${props.result.id}`}
                target="_blank"
                rel="noreferrer"
            >
                Open in new window ↗
            </Button>
        </div>
    );
};

const VersionTimeline: Component<{
    draft: ActionDraft;
    viewing: DraftViewing;
}> = (props) => {
    const latestVersionId = () => props.draft.versions[props.draft.versions.length - 1]?.id;

    const handleVersionClick = async (v: ActionVersion) => {
        if (!props.draft.action) return;
        // No-op if already showing this version's last result.
        const alreadyViewing =
            props.viewing.kind === 'version' &&
            props.viewing.id === v.id &&
            props.draft.latestResult?.versionId === v.id;
        if (alreadyViewing) return;
        // Switching versions loads the version's STORED result from IDB
        // (instant) — re-executing is the explicit "Re-run" button, not a
        // side effect of clicking a pill. While a candidate is under review the
        // click is a non-committing preview (currentVersionId/base stay intact);
        // otherwise it focuses the version (persists the pointer, no updatedAt
        // bump). Both surface the stored result via the runtime.
        try {
            if (props.draft.pendingReview) {
                await runtime.previewVersion(props.draft.action.id, v.id);
            } else {
                await focusVersion(props.draft.action.id, v.id);
            }
        } catch (e) {
            console.warn('[ActionPanel] version switch failed', e);
        }
    };

    const handleDraftClick = async () => {
        if (!props.draft.action || !props.draft.pendingReview) return;
        if (props.viewing.kind === 'draft') return;
        await runtime.setViewing(props.draft.action.id, { kind: 'draft' });
    };

    return (
        <div class="flex flex-col gap-2">
            <div class="text-[10px] uppercase tracking-wider text-muted-foreground">Versions</div>
            <div class="flex gap-1 overflow-x-auto pb-1">
                <For each={props.draft.versions}>
                    {(v, i) => {
                        const active = () =>
                            props.viewing.kind === 'version' && props.viewing.id === v.id;
                        const isLatest = () => latestVersionId() === v.id;
                        return (
                            <button
                                type="button"
                                onClick={() => handleVersionClick(v)}
                                class={
                                    'flex items-center gap-1 px-2 py-1 rounded text-[11px] font-mono whitespace-nowrap border ' +
                                    (active()
                                        ? 'bg-primary text-primary-foreground border-primary'
                                        : 'bg-muted text-muted-foreground border-transparent hover:border-muted-foreground/30')
                                }
                                title={v.intent}
                            >
                                <span>v{i() + 1}</span>
                                <Show when={isLatest()}>
                                    <span class="px-1 py-px rounded bg-blue-500 text-white text-[9px] font-semibold uppercase tracking-wider">
                                        latest
                                    </span>
                                </Show>
                            </button>
                        );
                    }}
                </For>
                <Show when={props.draft.pendingReview}>
                    <DraftPill active={props.viewing.kind === 'draft'} onClick={handleDraftClick} />
                </Show>
            </div>
        </div>
    );
};

const DraftPill: Component<{
    active: boolean;
    onClick: () => void;
}> = (props) => (
    <button
        type="button"
        onClick={props.onClick}
        class={
            'flex items-center gap-1 px-2 py-1 rounded text-[11px] font-mono whitespace-nowrap border ' +
            (props.active
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-muted text-muted-foreground border-transparent hover:border-muted-foreground/30')
        }
        title="Candidate under review"
    >
        <span>draft</span>
        <span class="px-1 py-px rounded bg-amber-500 text-white text-[9px] font-semibold uppercase tracking-wider">
            draft
        </span>
    </button>
);

const DataSourcesSection: Component<{ draft: ActionDraft }> = (props) => {
    return (
        <section class="flex flex-col gap-2">
            <div class="text-[10px] uppercase tracking-wider text-muted-foreground">
                Data sources ({props.draft.dataSources.length})
            </div>
            <Show
                when={props.draft.dataSources.length > 0}
                fallback={
                    <div class="text-xs italic text-muted-foreground">
                        {props.draft.inflight ? 'Planner is drafting…' : 'No data sources.'}
                    </div>
                }
            >
                <div class="flex flex-col gap-2">
                    <For each={props.draft.dataSources}>{(d) => <DataSourceCard ds={d} />}</For>
                </div>
            </Show>
        </section>
    );
};

/** Resolve the code + kind to display for the current viewing slot. */
function pickCode(
    draft: ActionDraft,
    viewing: DraftViewing,
): { code: string; kind: ActionKind | undefined } | undefined {
    if (viewing.kind === 'draft') {
        const pr = draft.pendingReview;
        if (pr) return { code: pr.code, kind: pr.codeKind };
        if (draft.code) return { code: draft.code, kind: draft.codeKind };
        return undefined;
    }
    const v = draft.versions.find((x) => x.id === viewing.id);
    if (v) return { code: v.code, kind: v.kind };
    if (draft.code) return { code: draft.code, kind: draft.codeKind };
    return undefined;
}

const CodeSection: Component<{
    draft: ActionDraft;
    viewing: DraftViewing;
}> = (props) => {
    const picked = createMemo(() => pickCode(props.draft, props.viewing));
    const isMarkdown = () => picked()?.kind === 'markdown';
    const label = () => (isMarkdown() ? 'Markdown template' : 'Code');
    const summary = () => (isMarkdown() ? 'show template' : 'show code');
    // Show the running status badge only on the draft slot — committed
    // versions are by definition 'approved' and the badge would be noise.
    const showStatus = () => props.viewing.kind === 'draft';
    return (
        <section class="flex flex-col gap-2">
            <div class="flex items-center gap-2">
                <div class="text-[10px] uppercase tracking-wider text-muted-foreground">
                    {label()}
                </div>
                <Show when={showStatus()}>
                    <CodeStatusBadge status={props.draft.codeStatus} />
                </Show>
            </div>
            <details class="text-xs">
                <summary class="cursor-pointer text-muted-foreground">{summary()}</summary>
                <pre class="mt-1 max-h-64 overflow-auto rounded bg-muted/40 p-2 font-mono text-[11px] whitespace-pre-wrap break-words">
                    {picked()?.code}
                </pre>
            </details>
        </section>
    );
};

const CodeStatusBadge: Component<{ status?: CodeStatus }> = (props) => {
    // 'approved' is the steady state and reads as noise — surface only the
    // transient validating / rejected states.
    return (
        <Show when={props.status && props.status !== 'approved'}>
            <span
                class={
                    'text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ' +
                    (props.status === 'rejected'
                        ? 'bg-destructive/15 text-destructive'
                        : 'bg-muted text-muted-foreground')
                }
            >
                {props.status}
            </span>
        </Show>
    );
};

/**
 * Pick the result to render for the current viewing slot.
 * - draft view → the candidate's executeAction output (held on
 *   pendingReview)
 * - version view → the latest committed-version execution (latestResult,
 *   which is repointed when the user clicks a version pill)
 */
function pickResult(draft: ActionDraft, viewing: DraftViewing): ActionExecution | undefined {
    if (viewing.kind === 'draft') {
        return draft.pendingReview?.result ?? draft.latestResult;
    }
    if (draft.latestResult?.versionId === viewing.id) {
        return draft.latestResult;
    }
    return undefined;
}

const ResultSection: Component<{
    draft: ActionDraft;
    viewing: DraftViewing;
}> = (props) => {
    const result = createMemo(() => pickResult(props.draft, props.viewing));
    return (
        <Show
            when={result()}
            fallback={
                <div class="text-xs italic text-muted-foreground">
                    {props.draft.inflight ? 'Running…' : 'No execution yet.'}
                </div>
            }
        >
            <section class="flex flex-col gap-2">
                <div class="text-[10px] uppercase tracking-wider text-muted-foreground">Output</div>
                <ActionResultView result={result()!} />
            </section>
        </Show>
    );
};
