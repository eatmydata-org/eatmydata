import { buildOrchestratorPrompt } from '../prompt';
import { resolveAgentModelId } from '../models';
import { askUserSchema, orchestratorTools, workOnActionSchema } from '../tools';
import { requestConfirmation } from '../confirmation';
import type { AgentDefinition, AgentRunCtx, ToolExecutor } from '../agent-def';
import type { Action, ActionKind, DataSource } from '@/lib/actions/types';
import type { SavedDataSourcePreview } from '@/lib/types';
import { executeAction } from '@/lib/actions/executor';
import { commitReviewCandidate } from '@/lib/actions/commit-review';
import { putResult } from '@/lib/runtime/state/results';
import {
    activeAction,
    attachPendingResult,
    attachResult,
    beginDraft,
    clearPendingReview,
    finalizeVersion,
    pushDataSources,
    pushPendingReview,
    setInflight,
} from '@/lib/runtime/state/drafts';

const askUserExecutor: ToolExecutor = async (input, ctx) => {
    const parsed = askUserSchema.parse(input);
    // F5 defensive default: the prompt says `question` is required, but a
    // model that omits it would have thrown Zod previously and left the
    // turn dead (see log1.txt's final dead-loop). Now we synthesize a
    // generic fallback and surface a console.warn so the upstream prompt
    // can be sharpened if this keeps happening.
    const question = parsed.question?.trim() || 'How would you like to proceed?';
    if (!parsed.question?.trim()) {
        console.warn(
            '[ask_user] model omitted `question` field — using fallback (F5 regression guard)',
        );
    }
    const decision = await requestConfirmation({
        controls: ctx.controls,
        stepId: ctx.stepId,
        toolCallId: ctx.toolCallId,
        rendererId: 'user-question',
        payload: {
            question,
            options: parsed.options,
            allowFreeText: parsed.allowFreeText,
        },
        agent: 'orchestrator',
    });
    if (!decision.approved) {
        return {
            ok: false,
            error: 'User dismissed the question without picking an option. Wait for the user to send a new message before continuing.',
        };
    }
    const response = decision.response as
        | { choiceId: string | null; freeText: string | null }
        | undefined;
    return {
        ok: true,
        value: {
            choiceId: response?.choiceId ?? null,
            freeText: response?.freeText ?? null,
        },
    };
};

function previewToDataSource(p: SavedDataSourcePreview): DataSource {
    // sampleColumns/sampleRows are intentionally NOT copied: samples are
    // agent-runtime only (perturbed/synthetic), and persisting them on the
    // Action made the Action panel show synthetic rows as if they were real
    // results after reload.
    return {
        id: crypto.randomUUID(),
        name: p.name,
        type: 'sql',
        query: p.query,
        semanticDescription: p.semanticDescription,
        typeDeclaration: p.typeDeclaration,
    };
}

/**
 * F3 iteration loop: outcomes a single planner→coder→review cycle can
 * produce. The chat-side `workOnActionExecutor` (further down) wraps a
 * while-loop over `iterateOnAction` and translates these into either a
 * tool success or tool failure for the chat orchestrator — the
 * `'rejected'` and `'aborted'` variants stay internal to the runtime.
 */
/**
 * Card payload that goes onto the chat as an `action-failed` part when
 * an iteration's outcome ends a turn (terminal failure OR iteration
 * loop exhausted). Carrying this on the outcome (instead of emitting
 * the card inside `iterateOnAction`) lets the outer loop suppress
 * intermediate failure cards from interim iterations — the user only
 * sees a banner once the turn actually ends in failure.
 */
type IterationFailureCard = {
    reason:
        | 'planner-error'
        | 'planner-empty'
        | 'planner-aborted'
        | 'coder-error'
        | 'coder-empty'
        | 'coder-aborted'
        | 'persistence-error';
    detail?: string;
};

type IterationOutcome =
    | { kind: 'approved'; toolResult: import('../agent-def').ToolExecutorResult }
    | { kind: 'rejected'; feedback: string }
    | { kind: 'aborted'; reason: string; card: IterationFailureCard }
    | {
          kind: 'failed';
          toolResult: import('../agent-def').ToolExecutorResult;
          /**
           * `card` is optional so user-initiated cancels (the user
           * dismissed the review without feedback) terminate cleanly
           * without dropping a red banner on top of their own action —
           * they already know what happened.
           */
          card?: IterationFailureCard;
      };

const MAX_ITERATIONS = 6;

/**
 * F4 stable-id helper. Two preview lists are "matching" when they
 * carry the same `(name, query)` pairs in the same order — which is
 * how the planner expresses "no source change" on a REPLAN that
 * decided the existing set already answers the new intent.
 *
 * Strict equality (not set membership) on purpose: a Planner that
 * reorders the array is signalling intent and we should treat the
 * sources as new.
 */
function previewsMatch(a: SavedDataSourcePreview[], b: SavedDataSourcePreview[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i]!.name !== b[i]!.name) return false;
        if (a[i]!.query !== b[i]!.query) return false;
    }
    return true;
}

/**
 * Run one planner→coder→user-review cycle. Returns a structured
 * outcome the caller can either bubble out as a tool result or feed
 * back into the next iteration with augmented intent. Replaces the
 * previous code path that returned a `{ status: 'rejected-with-feedback' }`
 * shape to the chat model — that shape and the FORBIDDEN prompt block
 * that depended on it are gone in F3.
 */
async function iterateOnAction(
    parsed: ReturnType<typeof workOnActionSchema.parse>,
    ctx: import('../agent-def').AgentRunCtx,
): Promise<IterationOutcome> {
    const current = activeAction();

    // Seed the live draft early so the panel renders immediately. We prefer
    // an existing draft id over minting a new uuid so that a "first-message"
    // stub (created by chat-view before any tool runs) keeps its identity.
    const draftId = current?.action?.id ?? current?.id ?? crypto.randomUUID();
    const versions = current?.versions ?? [];
    // baseVersion is the version we're iterating off — used as the
    // `parentVersionId` when committing. Defaults to the currently
    // focused version (or the head) when one exists.
    const baseVersion =
        versions.find((v) => v.id === current?.currentVersionId) ?? versions[versions.length - 1];

    // Snapshot the previous draft state BEFORE `beginDraft` wipes it.
    // When the user rejected a candidate and the orchestrator calls
    // `work_on_action` again with `mode: 'create_new'` (because the new
    // intent needs columns the existing sources can't produce), the
    // Planner needs to know what's already there — without that context
    // it cold-starts against the schema and often gives up. We capture
    // both the prior previews and the rejected code so the Planner can
    // extend rather than start over.
    const priorPreviews: SavedDataSourcePreview[] =
        current && current.dataSources.length > 0 ? current.dataSources.map((d) => ({ ...d })) : [];
    const priorCode = current?.code;

    // F1 guard: preserve the existing user-visible actionName across
    // iteration. If the chat model forgets to pass the prior name
    // verbatim on a follow-up `work_on_action` call (the model in
    // log1.txt sometimes invents a new title or sends the stub
    // "New Action"), keep what was already there. Only adopt
    // `parsed.name` when the existing draft has no real name yet.
    // `beginDraft` itself also guards against incoming "New Action"
    // overwrites — defence in depth.
    const existingName = current?.actionName?.trim();
    const effectiveName =
        existingName && existingName !== 'New Action' ? existingName : parsed.name;
    beginDraft({
        id: draftId,
        actionName: effectiveName,
        intent: parsed.intent,
        baseAction: current?.action,
        baseVersion,
        versions,
    });

    let previews: SavedDataSourcePreview[];
    // F4: always run the Planner. When `priorPreviews` exists the
    // Planner runs in REPLAN mode (seeded with the existing draft set);
    // its onIdleTurn already short-circuits to a no-op hand-off if the
    // existing set already covers the new intent. When the Planner
    // returns previews byte-identical to `priorPreviews`, the runtime
    // reuses the committed action's DataSource ids — keeping the
    // Coder's code rebindings stable.
    {
        const plannerInstruction = buildPlannerKickoffInstruction(
            parsed.intent,
            priorPreviews,
            priorCode,
        );
        const plannerResult = await ctx.spawn('planner', {
            instruction: plannerInstruction,
            context: {
                actionName: effectiveName,
                draftId,
                dataSourceId: current?.action?.dataSourceId,
                existingPreviews: priorPreviews,
            },
        });
        if (!plannerResult.ok) {
            setInflight(draftId, false);
            return {
                kind: 'failed',
                card: {
                    reason: 'planner-error',
                    detail: plannerResult.error,
                },
                toolResult: {
                    ok: false,
                    error: `FAILED: data source planning errored (${plannerResult.error}). The action was NOT created. Do NOT retry by exploring the schema yourself. Tell the user the action was not created and use \`ask_user\` to offer concrete next steps (e.g. refine the intent, narrow the scope, switch data source).`,
                },
            };
        }
        // F2 typed ABORT: the Planner can decline with text starting
        // with `ABORT:` per its prompt; the loop's spawnSubAgent
        // promotes that into `{ kind: 'aborted', reason }`. Treat as a
        // distinct outcome from an empty-but-non-aborted run.
        const plannerData = plannerResult.data as
            | SavedDataSourcePreview[]
            | { kind: 'aborted'; reason: string }
            | undefined;
        if (plannerData && !Array.isArray(plannerData) && plannerData.kind === 'aborted') {
            setInflight(draftId, false);
            return {
                kind: 'aborted',
                reason: plannerData.reason,
                card: {
                    reason: 'planner-aborted',
                    detail: `Planner ABORTed: ${plannerData.reason}`,
                },
            };
        }
        previews = Array.isArray(plannerData) ? plannerData : [];
        if (previews.length === 0) {
            setInflight(draftId, false);
            return {
                kind: 'failed',
                card: { reason: 'planner-empty' },
                toolResult: {
                    ok: false,
                    error: 'FAILED: no data sources were drafted. The action was NOT created. Do NOT retry by exploring the schema yourself. Tell the user the action was not created and use `ask_user` to propose 2-3 alternative angles (e.g. different scope, different breakdown, different focus).',
                },
            };
        }
        pushDataSources(draftId, previews);
    }

    // F4: when the Planner returned an unchanged set, reuse the
    // committed action's DataSource array so ids stay stable across
    // iterations (URLs / external refs continue to resolve). On any
    // schema change — new source, modified SQL, dropped source — we
    // rebuild the array; the Coder's code references previews by
    // `name`, so name-stable changes don't break it, but ids must
    // belong to the live set.
    const unchanged = current?.action !== undefined && previewsMatch(previews, priorPreviews);
    const dataSources: DataSource[] = unchanged
        ? current!.action!.dataSources
        : previews.map(previewToDataSource);
    // Propagate the resolved display name onto the persisted Action too.
    // `beginDraft` above already moved `effectiveName` into the live draft,
    // but the spread of `current.action` would otherwise carry the OLD
    // `name` into IDB — leaving the draft top-bar renamed while the sidebar
    // (which reads `action.name`) and any reload kept the stale title.
    // Using `effectiveName` (not `parsed.name`) keeps the F1 guard intact so
    // a follow-up call that forgets the prior name can't clobber it.
    const baseAction: Omit<Action, 'code' | 'kind' | 'updatedAt'> = current?.action
        ? { ...current.action, dataSources, name: effectiveName }
        : {
              id: draftId,
              name: parsed.name,
              description: parsed.description,
              dataSources,
              chatLog: ctx.controls.getMessagesSnapshot(),
              createdAt: Date.now(),
              dataSourceId: current?.action?.dataSourceId,
          };

    // Previous code for the Coder kickoff. The Planner-emitted previews
    // may share names with prior previews; the Coder edits the previous
    // code minimally to fit the (possibly extended) source set.
    const previousCode = priorCode;

    const coderResult = await spawnCoder(ctx, {
        intent: parsed.intent,
        previews,
        previousCode,
        draftId,
    });
    if (!coderResult.ok) {
        setInflight(draftId, false);
        clearPendingReview(draftId);
        return {
            kind: 'failed',
            card: {
                reason: 'coder-error',
                detail: coderResult.error,
            },
            toolResult: {
                ok: false,
                error: `FAILED: the analysis step errored (${coderResult.error}). The action was NOT created. Tell the user the analysis step did not complete and use \`ask_user\` to offer concrete alternatives (e.g. different output shape, different focus).`,
            },
        };
    }
    const coderOutput = coderResult.data as
        | { kind: 'code'; code: string }
        | { kind: 'markdown'; template: string }
        | { kind: 'aborted'; reason: string }
        | undefined;
    if (coderOutput?.kind === 'aborted') {
        // F2 typed ABORT: the Coder said it cannot answer with the
        // available data sources. F3's iteration loop reads this and
        // tries one more pass with the abort reason merged into the
        // next intent (forcing a Planner replan).
        setInflight(draftId, false);
        clearPendingReview(draftId);
        return {
            kind: 'aborted',
            reason: coderOutput.reason,
            card: {
                reason: 'coder-aborted',
                detail: `Coder ABORTed: ${coderOutput.reason}`,
            },
        };
    }
    if (!coderOutput || (coderOutput.kind === 'code' ? !coderOutput.code : !coderOutput.template)) {
        setInflight(draftId, false);
        clearPendingReview(draftId);
        // Surface the Coder's last assistant text — that's where stream
        // errors (`[stream error: …]`), refusals, or explanatory prose end
        // up when the model returns without calling a finalize tool.
        // Without this, "no code step was finalized" hides whether the
        // model refused, hit a rate limit, or just drifted off the tool
        // path.
        const lastText = (coderResult.summary ?? '').trim();
        const detail = lastText
            ? `coder finished without calling run_in_sandbox / save_markdown_action. Last assistant text:\n${lastText}`
            : 'coder finished without producing any text or finalization call.';
        return {
            kind: 'failed',
            card: { reason: 'coder-empty', detail },
            toolResult: {
                ok: false,
                error: `FAILED: no code step was finalized. The action was NOT created. ${detail} Tell the user the analysis step did not complete and use \`ask_user\` to offer concrete alternatives (e.g. different output shape, different focus).`,
            },
        };
    }

    const finalKind: ActionKind = coderOutput.kind;
    const finalCode = coderOutput.kind === 'markdown' ? coderOutput.template : coderOutput.code;

    // Build a candidate Action — NOT persisted. executeAction reads only
    // from the passed object, so this is safe.
    const candidate: Action = {
        ...baseAction,
        code: finalCode,
        kind: finalKind,
        updatedAt: Date.now(),
    };

    // Seed the review slot before execution so the panel can render the
    // candidate's code immediately (result fills in shortly).
    pushPendingReview(draftId, {
        code: finalCode,
        codeKind: finalKind,
        dataSources,
        intent: parsed.intent,
        baseVersionId: baseVersion?.id,
    });

    // Execute against a structured-cloned action so executeAction cannot
    // see (or mutate through) any references the agent still holds. Same
    // reason as the materializeVersion clone: the live draft state shares
    // these arrays/objects, and a defensive copy keeps the executor's view
    // independent of what the agent does next.
    const execResult = await executeAction(structuredClone(candidate));
    // Draft executions have no versionId yet — the field is filled in
    // only on commit (thumbs-up). putResult ensures the panel can fetch
    // the result by id if it needs to.
    await putResult(execResult);
    attachPendingResult(draftId, execResult);
    attachResult(draftId, execResult);

    // Ask the user.
    const decision = await requestConfirmation({
        controls: ctx.controls,
        stepId: ctx.stepId,
        toolCallId: ctx.toolCallId,
        rendererId: 'analysis-review',
        payload: {
            actionName: effectiveName,
            iteration: 1,
            resultError: execResult.error,
        },
        agent: 'orchestrator',
    });

    if (decision.approved) {
        // Commit: materialize a version + persist the action. Shared with the
        // host's orphaned-commit path (`commitReview`) so a thumbs-up on a
        // reloaded tab produces the identical version + result backfill.
        let committed: Awaited<ReturnType<typeof commitReviewCandidate>>;
        try {
            committed = await commitReviewCandidate({
                action: candidate,
                actionName: effectiveName,
                intent: parsed.intent,
                code: finalCode,
                kind: finalKind,
                dataSources,
                baseVersionId: baseVersion?.id,
                // Backfilling versionId + awaiting putResult inside matters:
                // without it a quick reload after approval could land before
                // the result row reached IDB — the saved Action then opened
                // with no chart at all.
                result: execResult,
            });
        } catch (e) {
            setInflight(draftId, false);
            clearPendingReview(draftId);
            const detail = e instanceof Error ? e.message : String(e);
            return {
                kind: 'failed',
                card: { reason: 'persistence-error', detail },
                toolResult: {
                    ok: false,
                    error: `FAILED: could not save the action (${detail}). The action was NOT created. Tell the user the save step failed and use \`ask_user\` to ask whether they want to retry.`,
                },
            };
        }
        const { version, finalAction, versionIndex } = committed;
        attachResult(draftId, execResult);
        finalizeVersion(draftId, version, finalAction);
        clearPendingReview(draftId);

        ctx.controls.addPart(ctx.stepId, {
            kind: 'action-result-link',
            resultId: execResult.id,
            actionName: finalAction.name,
            versionIndex,
            createdAt: Date.now(),
        });

        return {
            kind: 'approved',
            toolResult: {
                ok: true,
                value: {
                    actionId: finalAction.id,
                    versionId: version.id,
                    dataSourceCount: dataSources.length,
                    // `iterated` flag survives for the chat orchestrator's
                    // summary message — true when this run committed on
                    // top of an existing draft with the same source set
                    // (i.e. the Planner decided no source change was
                    // needed and the Coder edited the code in place).
                    iterated: unchanged,
                    executed: true,
                    resultId: execResult.id,
                    hadError: Boolean(execResult.error),
                },
            },
        };
    }

    // Rejected (thumbs-down). The decision itself carries no feedback — we
    // ask the user to explain what's wrong in the main chat composer. The
    // agent loop parks on this second confirmation; chat-view's composer
    // resolves it with the typed text as `freeText` (see chat-view's
    // `pendingChatInput`). Keep the pending review + inflight state up
    // so the draft stays on the Action panel while the user types.
    const feedbackDecision = await requestConfirmation({
        controls: ctx.controls,
        stepId: ctx.stepId,
        toolCallId: `${ctx.toolCallId}__feedback`,
        rendererId: 'analysis-review-feedback',
        payload: { actionName: effectiveName },
        agent: 'orchestrator',
    });
    const response = feedbackDecision.response as { freeText?: string | null } | undefined;
    const feedback = response?.freeText?.trim();
    setInflight(draftId, false);
    clearPendingReview(draftId);

    if (!feedback) {
        // No card for user-cancel: the user explicitly closed the
        // review without feedback, so they already know what happened.
        // A red banner on top of their own dismissal would be noise.
        return {
            kind: 'failed',
            toolResult: {
                ok: false,
                error: 'User canceled the analysis review without providing feedback. The action was NOT created. Tell the user the action was not saved and use `ask_user` to ask whether they want to refine the intent.',
            },
        };
    }

    // Echo the user's explanation as a normal chat balloon, positioned right
    // after the feedback prompt and before the re-run's cards — so the input
    // they typed into the composer is visible in the timeline like any other
    // message.
    ctx.controls.addPart(ctx.stepId, {
        kind: 'user-note',
        id: crypto.randomUUID().slice(0, 8),
        text: feedback,
    });

    // F3: hand the feedback back to the iteration loop. The chat
    // model never sees this — `workOnActionExecutor` augments the
    // intent and re-runs `iterateOnAction` with a Planner replan.
    return { kind: 'rejected', feedback };
}

/**
 * The chat-side tool. Drives `iterateOnAction` in a bounded loop and
 * surfaces only the terminal outcomes (approved / failed) to the chat
 * orchestrator. `'rejected'` and `'aborted'` stay internal: the loop
 * augments the intent and re-runs.
 */
const workOnActionExecutor: ToolExecutor = async (input, ctx) => {
    let currentInput = workOnActionSchema.parse(input);
    let attemptedReplan = false;
    /**
     * Card payload from the LAST terminal-class outcome (failed or
     * aborted-then-out-of-retries). We don't emit cards from intermediate
     * iterations because the loop is going to try again — surfacing a
     * banner only to retry seconds later is confusing. The terminal
     * card is added once below, just before returning to the chat
     * orchestrator.
     */
    let terminalCard: IterationFailureCard | undefined;
    const emitTerminalCard = () => {
        if (!terminalCard) return;
        ctx.controls.addPart(ctx.stepId, {
            kind: 'action-failed',
            reason: terminalCard.reason,
            intent: currentInput.intent,
            actionName: currentInput.name,
            ...(terminalCard.detail ? { detail: terminalCard.detail } : {}),
            createdAt: Date.now(),
        });
    };
    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
        const outcome = await iterateOnAction(currentInput, ctx);
        if (outcome.kind === 'approved') return outcome.toolResult;
        if (outcome.kind === 'failed') {
            terminalCard = outcome.card;
            emitTerminalCard();
            return outcome.toolResult;
        }
        if (outcome.kind === 'rejected') {
            // Merge user feedback into the next iteration's intent.
            // F4: no mode field anymore — the Planner always runs and
            // decides whether to add/replace/keep sources.
            currentInput = {
                ...currentInput,
                intent: `${currentInput.intent}\n\nUser feedback on the previous attempt: ${outcome.feedback}`,
            };
            attemptedReplan = true;
            continue;
        }
        // 'aborted' — the Planner or Coder said the current sources
        // cannot answer this intent. Augment the intent with the abort
        // reason and try once more; if a replan was ALREADY tried this
        // turn, give up to avoid burning iterations on something the
        // schema genuinely can't support.
        if (attemptedReplan) {
            terminalCard = outcome.card;
            emitTerminalCard();
            return {
                ok: false,
                error: `ABORTED: ${outcome.reason}. The action was NOT created after an attempted replan. Tell the user what's missing and use \`ask_user\` to propose a different angle or scope.`,
            };
        }
        currentInput = {
            ...currentInput,
            intent: `${currentInput.intent}\n\n(Previous attempt aborted: ${outcome.reason}. Try a different angle or surface the limitation in your data-source set.)`,
        };
        attemptedReplan = true;
    }
    emitTerminalCard();
    return {
        ok: false,
        error: `FAILED: exhausted ${MAX_ITERATIONS} iteration attempts without an approved candidate. Tell the user the analysis could not be built and use \`ask_user\` to propose a different angle or scope.`,
    };
};

type CoderSpawnArgs = {
    intent: string;
    previews: SavedDataSourcePreview[];
    previousCode: string | undefined;
    draftId: string;
};

async function spawnCoder(
    ctx: AgentRunCtx,
    args: CoderSpawnArgs,
): Promise<Awaited<ReturnType<AgentRunCtx['spawn']>>> {
    const instruction = buildCoderKickoffInstruction(args.intent, args.previews, args.previousCode);
    return ctx.spawn('coder', {
        instruction,
        context: {
            dataSources: args.previews,
            intent: args.intent,
            draftId: args.draftId,
            previousCode: args.previousCode,
        },
    });
}

export function orchestratorAgent(): AgentDefinition {
    return {
        id: 'orchestrator',
        name: 'Orchestrator',
        systemPrompt: buildOrchestratorPrompt,
        modelId: resolveAgentModelId('orchestrator'),
        tools: orchestratorTools,
        toolExecutors: {
            work_on_action: workOnActionExecutor,
            ask_user: askUserExecutor,
        },
    };
}

/**
 * Build the kickoff instruction the Planner sees as its first user
 * message. On a fresh start it's just the intent; on a replan (the
 * orchestrator re-calling `work_on_action` with `mode: 'create_new'`
 * after a rejection) it also lists the existing data sources and the
 * previous code so the Planner can extend the set, reuse names where
 * the SQL is unchanged, and avoid cold-starting the schema exploration.
 */
export function buildPlannerKickoffInstruction(
    intent: string,
    existingPreviews: SavedDataSourcePreview[],
    previousCode: string | undefined,
): string {
    if (existingPreviews.length === 0) {
        return intent;
    }
    const manifest = existingPreviews
        .map((p, i) => {
            const cols = p.sampleColumns.length
                ? p.sampleColumns.join(', ')
                : '(no columns recorded)';
            return `${i + 1}. \`${p.name}\` — ${p.semanticDescription || '(no description)'}
   columns: ${cols}
   SQL: ${oneLineSql(p.query)}`;
        })
        .join('\n\n');
    const codeBlock = previousCode
        ? `\n\nPrevious code step (what the Coder rendered against those sources):\n\`\`\`ts\n${previousCode}\n\`\`\``
        : '';
    return `User intent: ${intent}

This is a REPLAN against an existing draft. The previous Planner run produced these data sources and the Coder built a candidate against them, but the user rejected it and asked for something the existing sources cannot answer (a new column / breakdown / dimension / metric / entity).

Existing data sources:

${manifest}${codeBlock}

Your job: produce the SET of sources that answers the NEW intent. You may
  - keep an existing source unchanged (re-save it with the same name and query — the runtime dedupes by name),
  - replace an existing source with a new query (re-save with the same name and a different query),
  - add new sources for whatever the new intent introduces,
  - drop a source by NOT re-saving it (only sources you save are handed off to the Coder).

Reuse names where the underlying SQL is unchanged so the Coder's previous code keeps working. Do NOT explain the rejection back to the user — just call the schema-exploration tools and \`save_data_source\` for the final set, then respond with text to hand off.`;
}

function oneLineSql(sql: string): string {
    return sql.replace(/\s+/g, ' ').trim();
}

export function buildCoderKickoffInstruction(
    intent: string,
    previews: SavedDataSourcePreview[],
    previousCode: string | undefined,
): string {
    const manifest = previews
        .map((p, i) => {
            const sampleRows = p.sampleRows.slice(0, 3);
            const sampleLines =
                sampleRows.length === 0
                    ? '     (no sample rows — the SQL returned zero rows; ask the user if the action should be re-planned)'
                    : sampleRows.map((r) => `     ${safeJson(r)}`).join('\n');
            return `${i + 1}. \`${p.name}\` (array of row objects) — ${p.semanticDescription || '(no description)'}
   columns: ${p.sampleColumns.join(', ')}
   sample row count (sanitized): ${p.sampleRows.length}${p.truncated ? ' (truncated)' : ''}
   first sample rows (PERTURBED — shape only; category names are synthetic aliases, frequencies are flattened, numerics are noised+clamped, columns shuffled independently; never reason about values, frequencies, or row-level associations):
${sampleLines}
   TypeScript declaration:
     ${p.typeDeclaration.replace(/\n/g, '\n     ')}`;
        })
        .join('\n\n');
    const previousBlock = previousCode
        ? `\n\nPrevious code for this action — edit it minimally to address the new intent rather than rewriting from scratch:\n\`\`\`ts\n${previousCode}\n\`\`\`\n`
        : '';
    return `User intent: ${intent}

Available data sources (each is bound on globalThis under the given name as an array of row objects):

${manifest}${previousBlock}

Write TypeScript or JavaScript that uses these data sources to answer the user's question. Assign the final value to \`__output\` and the runtime infers how to render it from the shape (string → markdown; ECharts option object → single chart; ARRAY of ECharts option objects → multi-card dashboard; other object/array → JSON). If the user is asking for a chart/dashboard/visualization, build an ECharts option object and use the \`validate_echarts\` tool to check it before calling \`run_in_sandbox\`. PREFER multiple charts (assign an array) when the data has more than one story — different metrics with different scales/units, different aggregations, or different breakdowns of the same dataset. Each card stays focused; the renderer auto-links cards that share categories or axis names. Otherwise produce a markdown string. The values you see above are PERTURBED samples — synthetic category aliases, flattened frequencies, noised+clamped numerics, independently shuffled columns. Use them to confirm SHAPE only; never treat values, vocabularies, frequencies, or row-level associations as ground truth. Your code will later be re-run against the real result rows of these queries.`;
}

function safeJson(x: unknown): string {
    try {
        return JSON.stringify(x);
    } catch {
        return '[unserializable]';
    }
}
