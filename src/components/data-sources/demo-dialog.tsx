import {
    For,
    Show,
    createEffect,
    createMemo,
    createSignal,
    on,
    onCleanup,
    type Component,
} from 'solid-js';
import { SolidMarkdown } from 'solid-markdown';
import remarkGfm from 'remark-gfm';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/registry/ui/dialog';
import { Button } from '@/registry/ui/button';
import {
    DEMOS_BY_FAMILY,
    DEMO_ABOUT,
    type DemoAbout,
    type DemoFamily,
    type DemoSpec,
} from '@/lib/data-sources/about';
import { createDemoSource, type DemoProgress } from '@/lib/data-sources/demo-source';
import type { DataSource } from '@/lib/data-sources/types';

type Props = {
    open: boolean;
    onOpenChange(open: boolean): void;
    /** Called when a demo source has been downloaded + materialised in OPFS. */
    onCreated(source: DataSource): void;
    /** Pre-select this family each time the dialog opens (e.g. landing pills). */
    initialFamily?: DemoFamily;
};

const FAMILY_ORDER: ReadonlyArray<{ family: DemoFamily; label: string }> = [
    { family: 'retail', label: 'Retail demo' },
    { family: 'northwind', label: 'Northwind' },
    { family: 'adventureworks', label: 'AdventureWorks LT' },
    { family: 'contoso', label: 'Contoso 100K' },
];

function defaultSpecFor(family: DemoFamily): DemoSpec {
    if (family === 'retail') return 'retail-m';
    return family;
}

function formatBytes(n: number): string {
    if (!Number.isFinite(n) || n <= 0) return '—';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatRows(n: number): string {
    if (n >= 1_000_000) return `~${(n / 1_000_000).toFixed(1)} M rows`;
    if (n >= 1_000) return `~${Math.round(n / 1_000)} k rows`;
    return `${n} rows`;
}

export const DemoDialog: Component<Props> = (props) => {
    const [family, setFamily] = createSignal<DemoFamily>('retail');
    const [spec, setSpec] = createSignal<DemoSpec>('retail-m');
    const [busy, setBusy] = createSignal(false);
    const [progress, setProgress] = createSignal<DemoProgress | null>(null);
    const [error, setError] = createSignal<string | null>(null);

    let abortCtrl: AbortController | null = null;
    onCleanup(() => abortCtrl?.abort());

    const about = createMemo<DemoAbout>(() => DEMO_ABOUT[spec()]);
    const [nameOverride, setNameOverride] = createSignal<string | null>(null);
    const effectiveName = (): string => nameOverride() ?? about().title;

    const selectFamily = (f: DemoFamily) => {
        setFamily(f);
        setSpec(defaultSpecFor(f));
        setNameOverride(null);
    };

    // Honour an initial family each time the dialog is opened.
    createEffect(
        on(
            () => props.open,
            (open) => {
                if (open && props.initialFamily) selectFamily(props.initialFamily);
            },
        ),
    );

    const selectSpec = (s: DemoSpec) => {
        setSpec(s);
        setNameOverride(null);
    };

    const cancel = () => {
        abortCtrl?.abort();
        if (!busy()) props.onOpenChange(false);
    };

    const submit = async () => {
        setError(null);
        setBusy(true);
        setProgress({ loaded: 0, total: about().fileSizeBytesApprox });
        abortCtrl = new AbortController();
        try {
            const src = await createDemoSource(spec(), effectiveName(), {
                onProgress: (p) => setProgress({ ...p }),
                signal: abortCtrl.signal,
            });
            props.onCreated(src);
            props.onOpenChange(false);
        } catch (e) {
            if (abortCtrl?.signal.aborted) {
                setError('Cancelled.');
            } else {
                setError(e instanceof Error ? e.message : String(e));
            }
        } finally {
            setBusy(false);
            setProgress(null);
            abortCtrl = null;
        }
    };

    return (
        <Dialog open={props.open} onOpenChange={(o) => !busy() && props.onOpenChange(o)}>
            <DialogContent class="sm:max-w-[820px]">
                <DialogHeader>
                    <DialogTitle>Add demo data</DialogTitle>
                    <DialogDescription>
                        Pre-built sample datasets, downloaded once and stored on disk. Pick one to
                        add as a new data source.
                    </DialogDescription>
                </DialogHeader>

                <div class="grid grid-cols-[260px_1fr] gap-4 min-h-[420px]">
                    {/* Left: dataset picker */}
                    <ul class="flex flex-col gap-1 overflow-y-auto border rounded-md p-1">
                        <For each={FAMILY_ORDER}>
                            {(f) => (
                                <FamilyRow
                                    family={f.family}
                                    label={f.label}
                                    selected={family() === f.family}
                                    selectedSpec={spec()}
                                    onSelectFamily={() => selectFamily(f.family)}
                                    onSelectSpec={selectSpec}
                                />
                            )}
                        </For>
                    </ul>

                    {/* Right: About panel */}
                    <div class="flex flex-col min-h-0 border rounded-md p-3 overflow-y-auto">
                        <AboutPanel about={about()} />
                    </div>
                </div>

                {/* Bottom: name input + actions */}
                <div class="flex flex-col gap-2 mt-2">
                    <label class="flex flex-col gap-1 text-xs">
                        <span class="text-muted-foreground uppercase tracking-wide text-[10px]">
                            Source name
                        </span>
                        <input
                            type="text"
                            class="rounded border border-border bg-background px-2 py-1 text-sm"
                            value={effectiveName()}
                            disabled={busy()}
                            onInput={(e) => setNameOverride(e.currentTarget.value)}
                        />
                    </label>

                    <Show when={progress()}>{(p) => <ProgressBar value={p()} />}</Show>

                    <Show when={error()}>
                        <div class="rounded border border-destructive/40 bg-destructive/10 text-destructive text-xs px-2 py-1.5">
                            {error()}
                        </div>
                    </Show>

                    <div class="flex items-center justify-between gap-2 mt-1">
                        <span class="text-[11px] text-muted-foreground tabular-nums">
                            Download size: ~{formatBytes(about().fileSizeBytesApprox)} ·{' '}
                            {formatRows(about().rowCountApprox)}
                        </span>
                        <div class="flex gap-2">
                            <Button variant="ghost" onClick={cancel} disabled={false}>
                                {busy() ? 'Cancel download' : 'Cancel'}
                            </Button>
                            <Button
                                onClick={() => void submit()}
                                disabled={busy() || !effectiveName().trim()}
                            >
                                {busy() ? 'Downloading…' : 'Create'}
                            </Button>
                        </div>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
};

const FamilyRow: Component<{
    family: DemoFamily;
    label: string;
    selected: boolean;
    selectedSpec: DemoSpec;
    onSelectFamily(): void;
    onSelectSpec(spec: DemoSpec): void;
}> = (props) => {
    const variants = () => DEMOS_BY_FAMILY[props.family];

    return (
        <li>
            <button
                type="button"
                class={
                    'w-full text-left rounded px-2 py-1.5 text-sm transition-colors ' +
                    (props.selected ? 'bg-primary/10 text-primary font-semibold' : 'hover:bg-muted')
                }
                onClick={props.onSelectFamily}
            >
                {props.label}
            </button>
            <Show when={props.selected && props.family === 'retail'}>
                <div class="flex gap-1 mt-1 mb-1.5 pl-2">
                    <For each={variants()}>
                        {(v) => (
                            <button
                                type="button"
                                class={
                                    'flex-1 rounded border px-1.5 py-0.5 text-[11px] font-mono ' +
                                    (props.selectedSpec === v.id
                                        ? 'border-primary bg-primary/10 text-primary'
                                        : 'border-border hover:bg-muted')
                                }
                                onClick={(e) => {
                                    e.stopPropagation();
                                    props.onSelectSpec(v.id);
                                }}
                            >
                                {v.variant}
                            </button>
                        )}
                    </For>
                </div>
            </Show>
        </li>
    );
};

const AboutPanel: Component<{ about: DemoAbout }> = (props) => (
    <div class="flex flex-col gap-3 text-sm">
        <div>
            <h3 class="text-base font-semibold">{props.about.title}</h3>
            <p class="text-xs text-muted-foreground mt-0.5">{props.about.summary}</p>
        </div>

        <div class="prose prose-sm max-w-none text-foreground">
            <SolidMarkdown remarkPlugins={[remarkGfm]}>{props.about.description}</SolidMarkdown>
        </div>

        <Show when={props.about.hiddenPatterns?.length}>
            <details class="rounded border border-border bg-muted/40">
                <summary class="cursor-pointer px-2 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Hidden patterns to discover ({props.about.hiddenPatterns!.length})
                </summary>
                <div class="px-3 pb-3 pt-1 flex flex-col gap-2">
                    <For each={props.about.hiddenPatterns!}>
                        {(p) => (
                            <div class="text-xs">
                                <div class="font-semibold">
                                    {p.id}. {p.title}
                                </div>
                                <div class="prose prose-xs max-w-none mt-0.5 text-foreground">
                                    <SolidMarkdown remarkPlugins={[remarkGfm]}>
                                        {p.body}
                                    </SolidMarkdown>
                                </div>
                            </div>
                        )}
                    </For>
                </div>
            </details>
        </Show>

        <details class="rounded border border-border">
            <summary class="cursor-pointer px-2 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Tables ({props.about.tables.length})
            </summary>
            <ul class="px-3 pb-2 pt-1 text-xs space-y-0.5">
                <For each={props.about.tables}>
                    {(t) => (
                        <li class="flex items-baseline gap-2 font-mono">
                            <span class="font-semibold truncate">{t.name}</span>
                            <span class="text-muted-foreground tabular-nums">
                                {t.rows.toLocaleString()}
                            </span>
                            <Show when={t.note}>
                                <span class="text-muted-foreground text-[10px] truncate">
                                    — {t.note}
                                </span>
                            </Show>
                        </li>
                    )}
                </For>
            </ul>
        </details>

        <div class="text-[11px] text-muted-foreground border-t pt-2">
            <div>
                <span class="font-semibold">Source:</span> {props.about.source.origin}
            </div>
            <Show when={props.about.source.url}>
                <div class="truncate">
                    <a
                        href={props.about.source.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        class="underline hover:text-foreground"
                    >
                        {props.about.source.url}
                    </a>
                </div>
            </Show>
            <Show when={props.about.source.docsUrl}>
                <div class="truncate">
                    <span class="font-semibold">Docs:</span>{' '}
                    <a
                        href={props.about.source.docsUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        class="underline hover:text-foreground"
                    >
                        {props.about.source.docsUrl}
                    </a>
                </div>
            </Show>
            <div>
                <span class="font-semibold">License:</span> {props.about.source.license}
            </div>
        </div>
    </div>
);

const ProgressBar: Component<{ value: DemoProgress }> = (props) => {
    const pct = () => {
        const t = props.value.total;
        if (!t) return null;
        return Math.min(100, Math.round((props.value.loaded / t) * 100));
    };
    return (
        <div class="flex flex-col gap-1">
            <div class="h-1.5 rounded bg-muted overflow-hidden">
                <Show
                    when={pct() !== null}
                    fallback={<div class="h-full w-1/3 bg-primary/50 animate-pulse" />}
                >
                    <div
                        class="h-full bg-primary transition-[width] duration-100"
                        style={{ width: `${pct()}%` }}
                    />
                </Show>
            </div>
            <div class="text-[10px] text-muted-foreground tabular-nums flex justify-between">
                <span>
                    {formatBytes(props.value.loaded)}{' '}
                    <Show when={props.value.total > 0}>/ {formatBytes(props.value.total)}</Show>
                </span>
                <Show when={pct() !== null}>
                    <span>{pct()}%</span>
                </Show>
            </div>
        </div>
    );
};
