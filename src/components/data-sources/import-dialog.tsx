import { For, Show, createMemo, createSignal, type Component } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import { Button } from '@/registry/ui/button';
import { Badge } from '@/registry/ui/badge';
import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogDescription,
} from '@/registry/ui/dialog';
import type { DataSource } from '@/lib/data-sources/types';
import {
    importBatch,
    stageFile,
    type ConflictResolution,
    type ImportJob,
    type ImportJobOutcome,
} from '@/lib/data-sources/import';
import { toSnakeCase } from '@/lib/data-sources/identifier';

type Props = {
    open: boolean;
    onOpenChange(open: boolean): void;
    source: DataSource;
    existingTableNames: ReadonlyArray<string>;
    /** Pre-selected target table — invoked from "Re-import…" on a table page. */
    pinnedTable?: string;
    onCommitted(outcomes: ImportJobOutcome[]): void;
    /** Files dropped onto the page; consumed once by the dialog. */
    pendingFiles?: File[];
};

type StagedJob = ImportJob & {
    /** UI-side state: whether the user un-checked this row. */
    selected: boolean;
};

export const ImportDialog: Component<Props> = (props) => {
    const [jobs, setJobs] = createStore<{ items: StagedJob[] }>({ items: [] });
    const [reading, setReading] = createSignal(false);
    const [committing, setCommitting] = createSignal(false);
    const [progress, setProgress] = createSignal<{
        completed: number;
        total: number;
        current?: string;
        phase?: 'import' | 'index';
    }>({ completed: 0, total: 0 });
    const [outcomes, setOutcomes] = createSignal<ImportJobOutcome[] | null>(null);

    const batchTaken = (): Set<string> => {
        const s = new Set<string>();
        for (const j of jobs.items) s.add(j.tableName);
        return s;
    };

    const addFiles = async (files: File[]) => {
        if (files.length === 0) return;
        setReading(true);
        const taken = batchTaken();
        try {
            for (const file of files) {
                try {
                    const staged = await stageFile(file, props.existingTableNames, taken);
                    const items: StagedJob[] = staged.map((j) => {
                        // If a single file was opened from "Re-import…",
                        // pre-pin the conflict resolution to overwrite.
                        if (props.pinnedTable && j.tableName === props.pinnedTable) {
                            return {
                                ...j,
                                selected: true,
                                conflict: {
                                    existing: true,
                                    resolution: 'overwrite',
                                },
                            };
                        }
                        return { ...j, selected: true };
                    });
                    setJobs(
                        'items',
                        produce((list) => list.push(...items)),
                    );
                } catch (e) {
                    // Push a placeholder row so the user sees the error.
                    const message = e instanceof Error ? e.message : String(e);
                    setJobs(
                        'items',
                        produce((list) => list.push(makeErrorJob(file.name, message))),
                    );
                }
            }
        } finally {
            setReading(false);
        }
    };

    // Consume props.pendingFiles once on first open.
    let consumedPending = false;
    const maybeConsumePending = () => {
        if (consumedPending) return;
        if (!props.open) return;
        consumedPending = true;
        const f = props.pendingFiles;
        if (f && f.length > 0) void addFiles(f);
    };

    const onFileInput = (e: Event) => {
        const input = e.currentTarget as HTMLInputElement;
        const files = input.files ? Array.from(input.files) : [];
        input.value = '';
        void addFiles(files);
    };

    const updateRow = (stageId: string, patch: Partial<StagedJob>) => {
        setJobs(
            'items',
            (j) => j.stageId === stageId,
            produce((j) => Object.assign(j, patch)),
        );
    };

    const removeRow = (stageId: string) => {
        setJobs(
            'items',
            produce((list) => {
                const i = list.findIndex((j) => j.stageId === stageId);
                if (i >= 0) list.splice(i, 1);
            }),
        );
    };

    const renameRow = (stageId: string, rawName: string) => {
        const sanitized = toSnakeCase(rawName) || rawName;
        // Recompute conflict flag against existing tables.
        const conflict: StagedJob['conflict'] = props.existingTableNames.includes(sanitized)
            ? { existing: true as const, resolution: 'rename' }
            : undefined;
        updateRow(stageId, { tableName: sanitized, conflict });
    };

    const selectedJobs = (): StagedJob[] =>
        jobs.items.filter((j) => j.selected && j.columnNames.length > 0 && !isErrorJob(j));

    const submitDisabled = createMemo(() => committing() || selectedJobs().length === 0);

    const commit = async () => {
        const toRun = selectedJobs();
        if (toRun.length === 0) return;
        setCommitting(true);
        setProgress({ completed: 0, total: toRun.length });
        try {
            const results = await importBatch(
                props.source,
                toRun,
                props.existingTableNames,
                (tick) => setProgress(tick),
            );
            setOutcomes(results);
            props.onCommitted(results);
        } finally {
            setCommitting(false);
        }
    };

    const close = () => {
        // Reset state so reopening starts fresh.
        setJobs('items', []);
        setOutcomes(null);
        setProgress({ completed: 0, total: 0 });
        consumedPending = false;
        props.onOpenChange(false);
    };

    return (
        <Dialog
            open={props.open}
            onOpenChange={(o) => {
                // Don't let the popup close mid-import/index — stay open with
                // progress until the tables AND their search indexes are built.
                if (committing()) return;
                if (!o) close();
                else props.onOpenChange(true);
                maybeConsumePending();
            }}
        >
            <DialogContent class="max-w-3xl">
                <DialogHeader>
                    <DialogTitle>Import into "{props.source.name}"</DialogTitle>
                    <DialogDescription>
                        Drop CSV or XLSX files below. Each workbook sheet becomes its own table.
                    </DialogDescription>
                </DialogHeader>
                <Show
                    when={outcomes() === null}
                    fallback={<OutcomeSummary outcomes={outcomes()!} onClose={close} />}
                >
                    <FileDropZone onFiles={(fs) => void addFiles(fs)} reading={reading()} />
                    <input
                        type="file"
                        multiple
                        accept=".csv,.tsv,.xlsx,.xls"
                        onChange={onFileInput}
                        class="block text-xs text-muted-foreground"
                    />
                    <Show when={jobs.items.length > 0}>
                        <div class="border rounded-md max-h-[40svh] overflow-auto">
                            <table class="w-full text-xs">
                                <thead class="bg-muted text-muted-foreground uppercase tracking-wide text-[10px]">
                                    <tr>
                                        <th class="text-left px-2 py-1.5 w-6"></th>
                                        <th class="text-left px-2 py-1.5">File</th>
                                        <th class="text-left px-2 py-1.5">Table name</th>
                                        <th class="text-left px-2 py-1.5">Status</th>
                                        <th class="text-left px-2 py-1.5 w-6"></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    <For each={jobs.items}>
                                        {(job) => (
                                            <JobRow
                                                job={job}
                                                existingTableNames={props.existingTableNames}
                                                onToggle={(checked) =>
                                                    updateRow(job.stageId, {
                                                        selected: checked,
                                                    })
                                                }
                                                onRename={(name) => renameRow(job.stageId, name)}
                                                onResolution={(res) =>
                                                    updateRow(job.stageId, {
                                                        conflict: job.conflict
                                                            ? {
                                                                  existing: true,
                                                                  resolution: res,
                                                              }
                                                            : undefined,
                                                    })
                                                }
                                                onRemove={() => removeRow(job.stageId)}
                                            />
                                        )}
                                    </For>
                                </tbody>
                            </table>
                        </div>
                    </Show>
                    <Show when={committing()}>
                        <div class="text-xs text-muted-foreground">
                            <Show
                                when={progress().phase === 'index'}
                                fallback={
                                    <>
                                        Importing {progress().completed}/{progress().total}…
                                    </>
                                }
                            >
                                Building search index ({progress().completed}/{progress().total}{' '}
                                rows)…
                            </Show>{' '}
                            <Show when={progress().current}>
                                <span class="font-mono">{progress().current}</span>
                            </Show>
                        </div>
                    </Show>
                    <DialogFooter>
                        <Button variant="ghost" onClick={close} disabled={committing()}>
                            Cancel
                        </Button>
                        <Button onClick={() => void commit()} disabled={submitDisabled()}>
                            {committing()
                                ? 'Importing…'
                                : `Import ${selectedJobs().length} file${selectedJobs().length === 1 ? '' : 's'}`}
                        </Button>
                    </DialogFooter>
                </Show>
            </DialogContent>
        </Dialog>
    );
};

const FileDropZone: Component<{
    onFiles(files: File[]): void;
    reading: boolean;
}> = (props) => {
    const [hover, setHover] = createSignal(false);
    return (
        <div
            class={
                'border-2 border-dashed rounded-md py-6 px-4 text-center text-xs transition-colors ' +
                (hover()
                    ? 'border-primary bg-primary/5 text-foreground'
                    : 'border-border text-muted-foreground')
            }
            onDragOver={(e) => {
                e.preventDefault();
                setHover(true);
            }}
            onDragLeave={() => setHover(false)}
            onDrop={(e) => {
                e.preventDefault();
                setHover(false);
                if (!e.dataTransfer) return;
                const files = Array.from(e.dataTransfer.files);
                if (files.length > 0) props.onFiles(files);
            }}
        >
            {props.reading ? 'Reading files…' : 'Drop CSV / XLSX files here, or pick them below.'}
        </div>
    );
};

const JobRow: Component<{
    job: StagedJob;
    existingTableNames: ReadonlyArray<string>;
    onToggle(checked: boolean): void;
    onRename(name: string): void;
    onResolution(r: ConflictResolution): void;
    onRemove(): void;
}> = (props) => {
    const isError = createMemo(() => isErrorJob(props.job));
    return (
        <tr class="border-t border-border">
            <td class="px-2 py-1.5 align-top">
                <input
                    type="checkbox"
                    disabled={isError()}
                    checked={props.job.selected}
                    onChange={(e) => props.onToggle(e.currentTarget.checked)}
                />
            </td>
            <td class="px-2 py-1.5 align-top">
                <div class="font-mono text-foreground break-all">{props.job.originLabel}</div>
                <Show when={!isError()}>
                    <div class="text-[10px] text-muted-foreground mt-0.5">
                        {props.job.columnNames.length} cols ·{' '}
                        {props.job.rows.length.toLocaleString()} rows
                    </div>
                </Show>
            </td>
            <td class="px-2 py-1.5 align-top">
                <Show when={!isError()} fallback={<span>—</span>}>
                    <input
                        type="text"
                        class="rounded border border-border bg-background px-2 py-0.5 font-mono text-xs w-44"
                        value={props.job.tableName}
                        onChange={(e) => props.onRename(e.currentTarget.value.trim())}
                    />
                </Show>
            </td>
            <td class="px-2 py-1.5 align-top">
                <Show
                    when={!isError()}
                    fallback={
                        <Badge variant="destructive" class="font-mono text-[10px]">
                            {props.job.originalHeaders[0] ?? 'parse error'}
                        </Badge>
                    }
                >
                    <Show
                        when={props.job.conflict}
                        fallback={
                            <Badge variant="secondary" class="text-[10px] font-mono">
                                new
                            </Badge>
                        }
                    >
                        <div class="flex items-center gap-1.5">
                            <Badge
                                variant="outline"
                                class="text-[10px] font-mono border-amber-500/60 text-amber-600 dark:text-amber-400"
                            >
                                exists
                            </Badge>
                            <select
                                class="rounded border border-border bg-background px-1.5 py-0.5 text-[11px]"
                                value={props.job.conflict?.resolution ?? 'rename'}
                                onChange={(e) =>
                                    props.onResolution(e.currentTarget.value as ConflictResolution)
                                }
                            >
                                <option value="overwrite">overwrite</option>
                                <option value="rename">rename to …_N</option>
                                <option value="skip">skip</option>
                            </select>
                        </div>
                    </Show>
                </Show>
            </td>
            <td class="px-2 py-1.5 align-top">
                <button
                    type="button"
                    class="text-muted-foreground hover:text-destructive text-sm"
                    onClick={props.onRemove}
                    aria-label="Remove"
                >
                    ×
                </button>
            </td>
        </tr>
    );
};

const OutcomeSummary: Component<{
    outcomes: ImportJobOutcome[];
    onClose(): void;
}> = (props) => (
    <div class="flex flex-col gap-3">
        <div class="border rounded-md max-h-[40svh] overflow-auto">
            <table class="w-full text-xs">
                <thead class="bg-muted text-muted-foreground uppercase tracking-wide text-[10px]">
                    <tr>
                        <th class="text-left px-2 py-1.5">Table</th>
                        <th class="text-left px-2 py-1.5">Status</th>
                        <th class="text-left px-2 py-1.5">Rows</th>
                    </tr>
                </thead>
                <tbody>
                    <For each={props.outcomes}>
                        {(o) => (
                            <tr class="border-t border-border">
                                <td class="px-2 py-1.5 font-mono">{o.finalTableName}</td>
                                <td class="px-2 py-1.5">
                                    <Badge
                                        variant={
                                            o.status === 'failed'
                                                ? 'destructive'
                                                : o.status === 'skipped'
                                                  ? 'outline'
                                                  : 'secondary'
                                        }
                                        class="text-[10px] font-mono"
                                    >
                                        {o.status}
                                    </Badge>
                                    <Show when={o.error}>
                                        <div class="text-[10px] text-destructive mt-0.5 font-mono">
                                            {o.error}
                                        </div>
                                    </Show>
                                </td>
                                <td class="px-2 py-1.5 tabular-nums">
                                    {o.rowCount.toLocaleString()}
                                </td>
                            </tr>
                        )}
                    </For>
                </tbody>
            </table>
        </div>
        <DialogFooter>
            <Button onClick={props.onClose}>Close</Button>
        </DialogFooter>
    </div>
);

function makeErrorJob(fileName: string, message: string): StagedJob {
    return {
        stageId: crypto.randomUUID(),
        originLabel: fileName,
        tableName: '',
        sniffs: [],
        columnNames: [],
        originalHeaders: [message],
        rows: [],
        selected: false,
    };
}

function isErrorJob(j: StagedJob): boolean {
    return j.columnNames.length === 0;
}
