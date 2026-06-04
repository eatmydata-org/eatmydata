import {
    createEffect,
    createResource,
    createSignal,
    onMount,
    Show,
    Switch,
    Match,
    For,
    type Component,
} from 'solid-js';
import { createStore, produce, reconcile } from 'solid-js/store';
import { generateText } from 'ai';
import { Button } from '@/registry/ui/button';
import { TopBar } from '@/components/top-bar';
import {
    TextField,
    TextFieldInput,
    TextFieldLabel,
    TextFieldTextArea,
    TextFieldDescription,
} from '@/registry/ui/text-field';
import { Checkbox, CheckboxControl, CheckboxInput, CheckboxLabel } from '@/registry/ui/checkbox';
import {
    AGENT_MODEL_KEYS,
    modelKey,
    type ModelEntry,
    type ModelPricing,
    type ProviderInstance,
    type ProviderKind,
    type Settings,
} from '@/lib/runtime/state/settings-types';
import { ModelSelector } from '@/components/model-selector';
import { ConfirmDialog } from '@/components/data-sources/confirm-dialog';
import { agentLabel } from '@/lib/agent/labels';
import { getPiiAccessor } from '@/lib/pii/client';
import { runtime, useSettings } from '@/lib/runtime/client';
import { startChromeAiDownload, useChromeAiStatus } from '@/lib/runtime/chrome-ai-status';
import { createModel } from '@/lib/agent/models';
import { adapterFor, PROVIDER_ADAPTERS } from '@/lib/agent/providers';
import { toDecimalString } from '@/lib/format-number';
import { clearAllData } from '@/lib/clear-all-data';
import { buildActionsExportJson } from '@/lib/actions/export';
import { downloadBytes } from '@/lib/data-sources/export-table';

const GITHUB_URL = 'https://github.com/eatmydata-org/eatmydata';

// Shared width for every form control on the page so inputs, selects, and
// textareas line up. Kept narrow enough to stay scannable inside the
// max-w-3xl section column.
const CONTROL_WIDTH = 'w-full max-w-md';

const SettingsPage: Component = () => {
    return (
        <main class="h-svh flex flex-col bg-background text-foreground">
            <TopBar />

            <div class="flex-1 min-h-0 overflow-y-auto">
                <div class="mx-auto max-w-3xl px-4 py-6 flex flex-col gap-5">
                    <header class="flex items-center gap-2">
                        <h1 class="text-2xl font-semibold tracking-tight">Settings</h1>
                        <div class="ml-auto flex items-center gap-2">
                            <Button
                                as="a"
                                href={GITHUB_URL}
                                target="_blank"
                                rel="noopener"
                                variant="outline"
                            >
                                <GithubIcon />
                                <span class="ml-2">View on GitHub</span>
                            </Button>
                            <Button as="a" href={GITHUB_URL} target="_blank" rel="noopener">
                                <StarIcon />
                                <span class="ml-2">Star on GitHub</span>
                            </Button>
                        </div>
                    </header>
                    <ProvidersSection />
                    <AgentsSection />
                    <DataSourcesSection />
                    <PiiSection />
                    <PowerUserSection />
                    <DiagnosticsSection />
                    <MyDataSection />
                    <ResetSection />
                </div>
            </div>
        </main>
    );
};

const Section: Component<{
    title: string;
    description?: string;
    children: any;
}> = (props) => (
    <section class="flex flex-col gap-4 rounded-lg border bg-card/30 p-5">
        <div class="flex flex-col gap-1">
            <h2 class="text-2xl mb-1 font-semibold tracking-tight">{props.title}</h2>
            <Show when={props.description}>
                <p class="text-sm text-muted-foreground">{props.description}</p>
            </Show>
        </div>
        {props.children}
    </section>
);

type KeyTestState =
    | { kind: 'idle' }
    | { kind: 'running' }
    | { kind: 'ok'; label?: string; ms: number }
    | { kind: 'error'; message: string };

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/** Pick a fresh, unique provider id (also the registry prefix) for a kind. */
function uniqueProviderId(kind: ProviderKind, taken: string[]): string {
    const base =
        kind === 'google-ai-studio' ? 'google' : kind === 'openai-compatible' ? 'openai' : kind; // 'openrouter' | 'chrome-ai'
    if (!taken.includes(base)) return base;
    for (let i = 2; ; i++) {
        const cand = `${base}-${i}`;
        if (!taken.includes(cand)) return cand;
    }
}

/**
 * Patch the providers array and, in the SAME patch, snap `defaultModelId`
 * if this edit removed/disabled the model it pointed at. `patchSettings`
 * broadcasts the raw patch (not the merged result), so without folding the
 * snap in here the worker would re-home the default internally but the tab
 * mirror — and the id handed to `submit` — would keep the stale, now
 * unresolvable id.
 */
function commitProviders(providers: ProviderInstance[]): void {
    const patch: Partial<Settings> = { providers };
    const enabledModels = providers.filter((p) => p.enabled).flatMap((p) => p.models);
    const validIds = new Set(enabledModels.map((m) => m.id));
    if (!validIds.has(useSettings().defaultModelId) && enabledModels[0]) {
        patch.defaultModelId = enabledModels[0].id;
    }
    runtime.patchSettings(patch);
}

const ProvidersSection: Component = () => {
    const addProvider = (kind: ProviderKind) => {
        const adapter = adapterFor(kind);
        const existing = useSettings().providers;
        const id = uniqueProviderId(
            kind,
            existing.map((p) => p.id),
        );
        const next: ProviderInstance = {
            id,
            kind,
            label: existing.some((p) => p.kind === kind)
                ? `${adapter.label} (${id})`
                : adapter.label,
            enabled: true,
            models: [],
        };
        if (adapter.requiresApiKey) next.apiKey = '';
        commitProviders([...existing, next]);
    };

    return (
        <Section
            title="Providers"
            description="LLM backends. Add one or more providers, give each its API key (or base URL), and list the models it serves. Models are referenced everywhere as “provider:model”."
        >
            <For each={useSettings().providers}>{(p) => <ProviderCard provider={p} />}</For>
            <div class="flex flex-wrap items-center gap-2 pt-1">
                <span class="text-xs text-muted-foreground self-center">Add provider:</span>
                <For each={PROVIDER_ADAPTERS}>
                    {(a) => (
                        <Button variant="outline" size="sm" onClick={() => addProvider(a.kind)}>
                            + {a.label}
                        </Button>
                    )}
                </For>
            </div>
        </Section>
    );
};

const ProviderCard: Component<{ provider: ProviderInstance }> = (props) => {
    const adapter = () => adapterFor(props.provider.kind);
    const [showKey, setShowKey] = createSignal(false);
    const [conn, setConn] = createSignal<KeyTestState>({ kind: 'idle' });

    const patch = (patch: Partial<ProviderInstance>) => {
        commitProviders(
            useSettings().providers.map((p) =>
                p.id === props.provider.id ? { ...p, ...patch } : p,
            ),
        );
    };
    const remove = () => {
        commitProviders(useSettings().providers.filter((p) => p.id !== props.provider.id));
    };

    const testConnection = async () => {
        setConn({ kind: 'running' });
        const r = await adapter().testConnection(props.provider);
        setConn(
            r.ok ? { kind: 'ok', label: r.label, ms: r.ms } : { kind: 'error', message: r.message },
        );
    };

    return (
        <div class="rounded-lg border bg-background p-4 flex flex-col gap-3">
            <div class="flex flex-wrap items-center gap-2">
                <span class="font-mono text-[10px] uppercase rounded border px-1.5 py-0.5 bg-muted/60">
                    {adapter().label}
                </span>
                <code class="text-[10px] text-muted-foreground">{props.provider.id}:</code>
                <TextField class="flex-1 min-w-[8rem]">
                    <TextFieldInput
                        aria-label="Provider label"
                        value={props.provider.label}
                        onInput={(e) => patch({ label: e.currentTarget.value })}
                        class="h-8"
                    />
                </TextField>
                <Checkbox
                    class="flex items-center gap-2"
                    checked={props.provider.enabled}
                    onChange={(v) => patch({ enabled: v })}
                >
                    <CheckboxInput class="sr-only" />
                    <CheckboxControl />
                    <CheckboxLabel class="cursor-pointer text-xs">Enabled</CheckboxLabel>
                </Checkbox>
                <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Remove provider"
                    onClick={remove}
                >
                    <TrashIcon />
                </Button>
            </div>

            <Show when={adapter().requiresApiKey}>
                <TextField class={`gap-2 ${CONTROL_WIDTH}`}>
                    <TextFieldLabel>API key</TextFieldLabel>
                    <div class="flex w-full gap-2">
                        <TextFieldInput
                            type={showKey() ? 'text' : 'password'}
                            autocomplete="off"
                            spellcheck={false}
                            placeholder={
                                props.provider.kind === 'openrouter' ? 'sk-or-v1-…' : 'API key'
                            }
                            value={props.provider.apiKey ?? ''}
                            onInput={(e) => patch({ apiKey: e.currentTarget.value })}
                            class="font-mono flex-1 min-w-0"
                        />
                        <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            aria-label={showKey() ? 'Hide API key' : 'Show API key'}
                            onClick={() => setShowKey(!showKey())}
                        >
                            <Show when={showKey()} fallback={<EyeIcon />}>
                                <EyeOffIcon />
                            </Show>
                        </Button>
                    </div>
                </TextField>
            </Show>

            <Show when={adapter().baseURL !== 'none'}>
                <TextField class={`gap-2 ${CONTROL_WIDTH}`}>
                    <TextFieldLabel>
                        Base URL{adapter().baseURL === 'optional' ? ' (optional)' : ''}
                    </TextFieldLabel>
                    <TextFieldInput
                        autocomplete="off"
                        spellcheck={false}
                        placeholder="https://…/v1"
                        value={props.provider.baseURL ?? ''}
                        onInput={(e) => patch({ baseURL: e.currentTarget.value })}
                        class="font-mono"
                    />
                </TextField>
            </Show>

            <Show when={props.provider.kind === 'chrome-ai'}>
                <ChromeAiPanel />
            </Show>

            <Show when={props.provider.kind !== 'chrome-ai'}>
                <div>
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={testConnection}
                        disabled={conn().kind === 'running'}
                    >
                        <Show when={conn().kind === 'running'} fallback="Test connection">
                            <Spinner />
                            <span class="ml-2">Testing…</span>
                        </Show>
                    </Button>
                    <div class="mt-2">
                        <KeyTestResult state={conn()} />
                    </div>
                </div>
            </Show>

            <ModelsEditor provider={props.provider} />
        </div>
    );
};

const ChromeAiPanel: Component = () => {
    const status = useChromeAiStatus();
    const [downloadPct, setDownloadPct] = createSignal<number | null>(null);
    const [error, setError] = createSignal<string | null>(null);

    const download = async () => {
        setError(null);
        setDownloadPct(0);
        try {
            await startChromeAiDownload((loaded) =>
                setDownloadPct(Math.min(100, Math.round(loaded * 100))),
            );
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setDownloadPct(null);
        }
    };

    const statusInfo = (): { text: string; tone: 'ok' | 'warn' | 'muted' } => {
        switch (status()) {
            case 'available':
                return { text: 'Ready — on-device model available', tone: 'ok' };
            case 'downloadable':
                return {
                    text: 'Supported — needs a one-time on-device model download',
                    tone: 'warn',
                };
            case 'downloading':
                return { text: 'Downloading on-device model…', tone: 'warn' };
            case 'unavailable':
                return {
                    text: 'Browser supports it, but the model is unavailable on this device',
                    tone: 'warn',
                };
            case 'unknown':
                return { text: 'Checking…', tone: 'muted' };
            default:
                return {
                    text: 'Not available in this browser (needs a recent Chrome/Edge with the built-in model)',
                    tone: 'muted',
                };
        }
    };

    const toneClass = (tone: 'ok' | 'warn' | 'muted') =>
        tone === 'ok'
            ? 'text-emerald-600 dark:text-emerald-400'
            : tone === 'warn'
              ? 'text-amber-600 dark:text-amber-400'
              : 'text-muted-foreground';

    return (
        <div class="rounded-md border bg-card/40 px-3 py-3 flex flex-col gap-3 text-xs">
            <p class="text-muted-foreground">
                Runs entirely on-device via Chrome's built-in Gemini Nano (Prompt API) — free and
                private. Experimental: small model, no native function calling (tool calls are
                emulated), so complex multi-step actions may be unreliable.
            </p>
            <div class="flex items-center gap-2">
                <span class="text-muted-foreground">Status:</span>
                <span class={`font-medium ${toneClass(statusInfo().tone)}`}>
                    {statusInfo().text}
                </span>
            </div>
            <Show when={status() === 'downloadable' || status() === 'downloading'}>
                <div class="flex items-center gap-2">
                    <Button onClick={download} disabled={downloadPct() !== null}>
                        <Show when={downloadPct() !== null} fallback="Download model">
                            <Spinner />
                            <span class="ml-2">Downloading {downloadPct()}%</span>
                        </Show>
                    </Button>
                </div>
            </Show>
            <Show when={error()}>
                <p class="text-destructive font-mono whitespace-pre-wrap">{error()}</p>
            </Show>
        </div>
    );
};

// ---------------------------------------------------------------------------
// Per-provider model editor (table + JSON over a local draft)
// ---------------------------------------------------------------------------

// $/M token strings keep the table editable; converted to/from the
// per-token `ModelPricing` we store. `extra` round-trips cacheRead/reasoning
// (edited only via JSON) so a table save doesn't silently drop them.
type DraftRow = {
    key: string;
    modelId: string;
    label: string;
    promptM: string;
    completionM: string;
    extra?: { cacheRead?: number; reasoning?: number };
};

const uid = () => crypto.randomUUID().slice(0, 8);
const perM = (v: number | undefined): string => (v === undefined ? '' : toDecimalString(v * 1e6));

const toRows = (models: ModelEntry[]): DraftRow[] =>
    models.map((m) => ({
        key: uid(),
        modelId: m.modelId,
        label: m.label,
        promptM: perM(m.pricing?.prompt),
        completionM: perM(m.pricing?.completion),
        extra:
            m.pricing && (m.pricing.cacheRead !== undefined || m.pricing.reasoning !== undefined)
                ? { cacheRead: m.pricing.cacheRead, reasoning: m.pricing.reasoning }
                : undefined,
    }));

const rowsToModels = (rows: DraftRow[], providerId: string): ModelEntry[] =>
    rows
        .filter((r) => r.modelId.trim().length > 0)
        .map((r) => {
            const modelId = r.modelId.trim();
            const prompt = r.promptM.trim() === '' ? undefined : Number(r.promptM) / 1e6;
            const completion =
                r.completionM.trim() === '' ? undefined : Number(r.completionM) / 1e6;
            const entry: ModelEntry = {
                id: modelKey(providerId, modelId),
                modelId,
                label: r.label.trim() || modelId,
            };
            if (prompt !== undefined || completion !== undefined || r.extra) {
                const pricing: ModelPricing = {
                    prompt: Number.isFinite(prompt) ? (prompt as number) : 0,
                    completion: Number.isFinite(completion) ? (completion as number) : 0,
                };
                if (r.extra?.cacheRead !== undefined) pricing.cacheRead = r.extra.cacheRead;
                if (r.extra?.reasoning !== undefined) pricing.reasoning = r.extra.reasoning;
                entry.pricing = pricing;
            }
            return entry;
        });

const formatPricingBlock = (p: ModelPricing): string => {
    const fields = [
        `      "prompt": ${toDecimalString(p.prompt)}`,
        `      "completion": ${toDecimalString(p.completion)}`,
    ];
    if (p.cacheRead !== undefined)
        fields.push(`      "cacheRead": ${toDecimalString(p.cacheRead)}`);
    if (p.reasoning !== undefined)
        fields.push(`      "reasoning": ${toDecimalString(p.reasoning)}`);
    return `    "pricing": {\n${fields.join(',\n')}\n    }`;
};

// User-facing JSON carries modelId + label + (optional) pricing. The
// internal fully-qualified `id` is derived from the provider id + modelId.
// Custom serialization (rather than JSON.stringify) keeps per-token prices
// as plain decimals instead of `1e-7`.
const serializeModels = (models: ModelEntry[]): string => {
    if (models.length === 0) return '[]';
    const items = models.map((m) => {
        const lines = [
            `    "modelId": ${JSON.stringify(m.modelId)}`,
            `    "label": ${JSON.stringify(m.label)}`,
        ];
        if (m.pricing) lines.push(formatPricingBlock(m.pricing));
        return `  {\n${lines.join(',\n')}\n  }`;
    });
    return `[\n${items.join(',\n')}\n]`;
};

const parseModelsJson = (text: string, providerId: string): ModelEntry[] => {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error('Expected an array');
    return parsed.map((m: unknown) => {
        const o = m as Record<string, unknown>;
        if (
            !o ||
            typeof o !== 'object' ||
            typeof o.modelId !== 'string' ||
            typeof o.label !== 'string'
        ) {
            throw new Error('Each entry needs modelId, label (both strings)');
        }
        const entry: ModelEntry = {
            id: modelKey(providerId, o.modelId),
            modelId: o.modelId,
            label: o.label,
        };
        if (o.pricing !== undefined) {
            const p = o.pricing as Record<string, unknown>;
            if (
                typeof p !== 'object' ||
                p === null ||
                typeof p.prompt !== 'number' ||
                typeof p.completion !== 'number'
            ) {
                throw new Error(
                    'pricing must be an object with numeric prompt + completion fields',
                );
            }
            const pricing: ModelPricing = { prompt: p.prompt, completion: p.completion };
            if (typeof p.cacheRead === 'number') pricing.cacheRead = p.cacheRead;
            if (typeof p.reasoning === 'number') pricing.reasoning = p.reasoning;
            entry.pricing = pricing;
        }
        return entry;
    });
};

const ModelsEditor: Component<{ provider: ProviderInstance }> = (props) => {
    const adapter = () => adapterFor(props.provider.kind);
    const [mode, setMode] = createSignal<'table' | 'json'>('table');
    const [rows, setRows] = createStore<DraftRow[]>(toRows(props.provider.models));
    const [jsonText, setJsonText] = createSignal(serializeModels(props.provider.models));
    const [jsonError, setJsonError] = createSignal<string | null>(null);
    const [pricesBusy, setPricesBusy] = createSignal(false);
    const [pricesError, setPricesError] = createSignal<string | null>(null);

    // Tracks the last serialization we pushed so the resync effect can tell
    // "user hasn't edited" from "user is mid-edit" (same idea as the legacy
    // JSON editor). The committed provider models hydrate after mount and can
    // change cross-tab; resync only when the user hasn't diverged.
    let lastSync = serializeModels(props.provider.models);

    createEffect(() => {
        const next = serializeModels(props.provider.models);
        if (next === lastSync) return;
        const current = serializeModels(rowsToModels(rows, props.provider.id));
        if (current === lastSync) {
            setRows(reconcile(toRows(props.provider.models), { key: 'key' }));
            setJsonText(next);
        }
        lastSync = next;
    });

    const commit = (models: ModelEntry[]) => {
        commitProviders(
            useSettings().providers.map((p) => (p.id === props.provider.id ? { ...p, models } : p)),
        );
        const serialized = serializeModels(models);
        lastSync = serialized;
        setJsonText(serialized);
        setRows(reconcile(toRows(models), { key: 'key' }));
    };

    // Parse the active editor (table or JSON) into model entries. Throws on
    // invalid JSON; callers surface it via setJsonError.
    const draftModels = (): ModelEntry[] =>
        mode() === 'json'
            ? parseModelsJson(jsonText(), props.provider.id)
            : rowsToModels(rows, props.provider.id);

    // Fetch prices for these models and merge them in, dropping any stale
    // price whose model the source no longer knows. Shared by the explicit
    // "Download prices" button and the auto-apply-on-save path.
    const withFetchedPrices = async (models: ModelEntry[]): Promise<ModelEntry[]> => {
        const fetchPrices = adapter().fetchPrices;
        if (!fetchPrices) return models;
        const prices = await fetchPrices(
            props.provider,
            models.map((m) => m.modelId),
        );
        return models.map((m) => {
            const p = prices[m.modelId];
            return p ? { ...m, pricing: p } : { ...m, pricing: undefined };
        });
    };

    const save = async () => {
        let models: ModelEntry[];
        try {
            models = draftModels();
            setJsonError(null);
        } catch (e) {
            setJsonError(e instanceof Error ? e.message : String(e));
            return;
        }
        setPricesError(null);
        // Providers whose prices come from a committed map (Google) fill them
        // in on every save — no separate "Download prices" click needed.
        if (adapter().autoFetchPrices) {
            setPricesBusy(true);
            try {
                models = await withFetchedPrices(models);
            } catch (e) {
                console.error('[settings] auto price fetch on save failed:', e);
                setPricesError(e instanceof Error ? e.message : String(e));
            } finally {
                setPricesBusy(false);
            }
        }
        commit(models);
    };

    const switchMode = (next: 'table' | 'json') => {
        if (next === mode()) return;
        if (next === 'json') {
            // Carry pending table edits into the JSON view.
            setJsonText(serializeModels(rowsToModels(rows, props.provider.id)));
            setJsonError(null);
        } else {
            // Carry pending JSON edits into the table; stay in JSON on error.
            try {
                setRows(
                    reconcile(toRows(parseModelsJson(jsonText(), props.provider.id)), {
                        key: 'key',
                    }),
                );
                setJsonError(null);
            } catch (e) {
                setJsonError(e instanceof Error ? e.message : String(e));
                return;
            }
        }
        setMode(next);
    };

    const downloadPrices = async () => {
        if (!adapter().fetchPrices) return;
        let models: ModelEntry[];
        try {
            models = draftModels();
            setJsonError(null);
        } catch (e) {
            setJsonError(e instanceof Error ? e.message : String(e));
            return;
        }
        setPricesBusy(true);
        setPricesError(null);
        try {
            commit(await withFetchedPrices(models));
        } catch (e) {
            setPricesError(e instanceof Error ? e.message : String(e));
        } finally {
            setPricesBusy(false);
        }
    };

    const addRow = () =>
        setRows(rows.length, { key: uid(), modelId: '', label: '', promptM: '', completionM: '' });
    const deleteRow = (i: number) => setRows(produce((arr) => arr.splice(i, 1)));

    return (
        <div class="flex flex-col gap-2 rounded-md border bg-card/40 p-3">
            <div class="flex items-center gap-2">
                <span class="text-xs font-medium text-muted-foreground">Models</span>
                <div class="ml-auto inline-flex rounded-md border overflow-hidden">
                    <button
                        type="button"
                        class={`px-2 py-1 text-xs ${mode() === 'table' ? 'bg-muted font-medium' : 'bg-background'}`}
                        onClick={() => switchMode('table')}
                    >
                        Table
                    </button>
                    <button
                        type="button"
                        class={`px-2 py-1 text-xs border-l ${mode() === 'json' ? 'bg-muted font-medium' : 'bg-background'}`}
                        onClick={() => switchMode('json')}
                    >
                        JSON
                    </button>
                </div>
            </div>

            <Show
                when={mode() === 'table'}
                fallback={
                    <TextField class="w-full">
                        <TextFieldTextArea
                            rows={Math.min(16, Math.max(6, rows.length * 4 + 2))}
                            spellcheck={false}
                            class="w-full font-mono text-xs"
                            value={jsonText()}
                            onInput={(e) => setJsonText(e.currentTarget.value)}
                        />
                    </TextField>
                }
            >
                <div class="overflow-x-auto">
                    <table class="w-full text-xs">
                        <thead class="text-muted-foreground">
                            <tr class="text-left">
                                <th class="font-medium py-1 pr-2">Model id</th>
                                <th class="font-medium py-1 pr-2">Label</th>
                                <th class="font-medium py-1 pr-2 w-20">$/M in</th>
                                <th class="font-medium py-1 pr-2 w-20">$/M out</th>
                                <th class="w-8" />
                            </tr>
                        </thead>
                        <tbody>
                            <For each={rows}>
                                {(row, i) => (
                                    <tr>
                                        <td class="py-0.5 pr-2">
                                            <TextField>
                                                <TextFieldInput
                                                    aria-label="Model id"
                                                    value={row.modelId}
                                                    onInput={(e) =>
                                                        setRows(
                                                            i(),
                                                            'modelId',
                                                            e.currentTarget.value,
                                                        )
                                                    }
                                                    class="h-7 font-mono"
                                                />
                                            </TextField>
                                        </td>
                                        <td class="py-0.5 pr-2">
                                            <TextField>
                                                <TextFieldInput
                                                    aria-label="Label"
                                                    value={row.label}
                                                    onInput={(e) =>
                                                        setRows(i(), 'label', e.currentTarget.value)
                                                    }
                                                    class="h-7"
                                                />
                                            </TextField>
                                        </td>
                                        <td class="py-0.5 pr-2">
                                            <TextField>
                                                <TextFieldInput
                                                    aria-label="USD per million input tokens"
                                                    inputmode="decimal"
                                                    value={row.promptM}
                                                    onInput={(e) =>
                                                        setRows(
                                                            i(),
                                                            'promptM',
                                                            e.currentTarget.value,
                                                        )
                                                    }
                                                    class="h-7 font-mono"
                                                />
                                            </TextField>
                                        </td>
                                        <td class="py-0.5 pr-2">
                                            <TextField>
                                                <TextFieldInput
                                                    aria-label="USD per million output tokens"
                                                    inputmode="decimal"
                                                    value={row.completionM}
                                                    onInput={(e) =>
                                                        setRows(
                                                            i(),
                                                            'completionM',
                                                            e.currentTarget.value,
                                                        )
                                                    }
                                                    class="h-7 font-mono"
                                                />
                                            </TextField>
                                        </td>
                                        <td class="py-0.5">
                                            <Button
                                                type="button"
                                                variant="ghost"
                                                size="icon"
                                                aria-label="Delete model"
                                                onClick={() => deleteRow(i())}
                                            >
                                                <TrashIcon />
                                            </Button>
                                        </td>
                                    </tr>
                                )}
                            </For>
                        </tbody>
                    </table>
                    <Button type="button" variant="ghost" size="sm" class="mt-1" onClick={addRow}>
                        + Add model
                    </Button>
                </div>
            </Show>

            <Show when={jsonError()}>
                <p class="text-xs text-destructive">{jsonError()}</p>
            </Show>
            <Show when={pricesError()}>
                <p class="text-xs text-destructive">{pricesError()}</p>
            </Show>

            <div class="flex gap-2 flex-wrap mt-1">
                <Button size="sm" onClick={save} disabled={pricesBusy()}>
                    Save
                </Button>
                <Show when={adapter().canFetchPrices && !adapter().autoFetchPrices}>
                    <Button
                        size="sm"
                        variant="outline"
                        onClick={downloadPrices}
                        disabled={pricesBusy()}
                    >
                        <Show when={pricesBusy()} fallback="Download prices">
                            <Spinner />
                            <span class="ml-2">Updating…</span>
                        </Show>
                    </Button>
                </Show>
            </div>
        </div>
    );
};

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

type TestState =
    | { kind: 'idle' }
    | { kind: 'running' }
    | { kind: 'ok'; reply: string; ms: number }
    | { kind: 'error'; message: string };

const AgentsSection: Component = () => {
    const [testState, setTestState] = createSignal<TestState>({ kind: 'idle' });

    const runTest = async () => {
        setTestState({ kind: 'running' });
        const id = useSettings().defaultModelId;
        const t0 = performance.now();
        try {
            const { text } = await generateText({
                model: createModel(id),
                prompt: 'Respond with the single word "pong" — no punctuation, no quotes.',
            });
            setTestState({
                kind: 'ok',
                reply: text.trim().slice(0, 80) || '(empty reply)',
                ms: Math.round(performance.now() - t0),
            });
        } catch (e) {
            setTestState({
                kind: 'error',
                message: e instanceof Error ? e.message : String(e),
            });
        }
    };

    return (
        <Section
            title="Agents"
            description="Agents and the (provider + model) used per agent call."
        >
            <TextField class="gap-2 w-full">
                <TextFieldLabel>Default agent model</TextFieldLabel>
                <div class="flex w-full gap-2 items-start">
                    <ModelSelector
                        value={useSettings().defaultModelId}
                        onChange={(v) => runtime.patchSettings({ defaultModelId: v })}
                        triggerClass={CONTROL_WIDTH}
                    />
                    <Button
                        type="button"
                        variant="outline"
                        onClick={runTest}
                        disabled={testState().kind === 'running'}
                    >
                        <Show when={testState().kind === 'running'} fallback="Test">
                            <Spinner />
                            <span class="ml-2">Testing…</span>
                        </Show>
                    </Button>
                </div>
                <TextFieldDescription class="text-xs mt-1">
                    "Test" sends one short request using the default model to verify the model and
                    its provider key work.
                </TextFieldDescription>
                <TestResult state={testState()} />
            </TextField>

            <Checkbox
                class="flex items-center gap-2"
                checked={useSettings().useOneModelForAll}
                onChange={(v) => runtime.patchSettings({ useOneModelForAll: v })}
            >
                <CheckboxInput class="sr-only" />
                <CheckboxControl />
                <CheckboxLabel class="cursor-pointer">Use one model for all agents</CheckboxLabel>
            </Checkbox>

            <Show when={!useSettings().useOneModelForAll}>
                <For each={AGENT_MODEL_KEYS}>
                    {(id) => (
                        <TextField class={`gap-2 ${CONTROL_WIDTH}`}>
                            <TextFieldLabel>{agentLabel(id)}</TextFieldLabel>
                            <ModelSelector
                                value={
                                    useSettings().agentModels[id] ?? useSettings().defaultModelId
                                }
                                onChange={(v) =>
                                    runtime.patchSettings({
                                        agentModels: {
                                            ...useSettings().agentModels,
                                            [id]: v,
                                        },
                                    })
                                }
                            />
                        </TextField>
                    )}
                </For>
            </Show>
        </Section>
    );
};

const KeyTestResult: Component<{ state: KeyTestState }> = (props) => (
    <Switch>
        <Match when={props.state.kind === 'ok' ? props.state : undefined}>
            {(s) => (
                <div class="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs">
                    <span class="font-semibold text-emerald-700 dark:text-emerald-300">
                        ✓ Connected in {(s() as { ms: number }).ms} ms
                    </span>
                    <Show when={(s() as { label?: string }).label}>
                        {' '}
                        <span class="font-mono">({(s() as { label?: string }).label})</span>
                    </Show>
                </div>
            )}
        </Match>
        <Match when={props.state.kind === 'error' ? props.state : undefined}>
            {(s) => (
                <div class="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs font-mono whitespace-pre-wrap text-destructive">
                    {(s() as { message: string }).message}
                </div>
            )}
        </Match>
    </Switch>
);

const TestResult: Component<{ state: TestState }> = (props) => (
    <Switch>
        <Match when={props.state.kind === 'ok' ? props.state : undefined}>
            {(s) => (
                <div class="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs">
                    <span class="font-semibold text-emerald-700 dark:text-emerald-300">
                        ✓ Reply in {(s() as { ms: number }).ms} ms:
                    </span>{' '}
                    <span class="font-mono">{(s() as { reply: string }).reply}</span>
                </div>
            )}
        </Match>
        <Match when={props.state.kind === 'error' ? props.state : undefined}>
            {(s) => (
                <div class="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs font-mono whitespace-pre-wrap text-destructive">
                    {(s() as { message: string }).message}
                </div>
            )}
        </Match>
    </Switch>
);

const PiiSection: Component = () => {
    const accessor = getPiiAccessor();
    const [manifest] = createResource(() => accessor.getManifest());
    const [modelSize] = createResource(manifest, async (m) => {
        try {
            const res = await fetch(`/tiny-pii/${m.model_id}/${m.model_file}`, {
                method: 'HEAD',
                cache: 'no-store',
            });
            const len = res.headers.get('content-length');
            return len ? Number(len) : null;
        } catch {
            return null;
        }
    });
    const [warm, setWarm] = createSignal(false);
    const [downloading, setDownloading] = createSignal(false);
    const [downloadError, setDownloadError] = createSignal<string | null>(null);
    const [bootMs, setBootMs] = createSignal<number | null>(null);

    onMount(async () => {
        try {
            if (await accessor.isWarm()) {
                setWarm(true);
                setBootMs(await accessor.bootElapsedMs());
            }
        } catch (e) {
            console.error('[settings] PII accessor warm-state probe failed:', e);
        }
    });

    const download = async () => {
        setDownloading(true);
        setDownloadError(null);
        try {
            await accessor.warmup();
            setWarm(true);
            setBootMs(await accessor.bootElapsedMs());
        } catch (e) {
            setDownloadError(e instanceof Error ? e.message : String(e));
        } finally {
            setDownloading(false);
        }
    };

    const sizeLabel = () => {
        const bytes = modelSize();
        if (bytes == null) return '';
        const mb = bytes / (1024 * 1024);
        return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
    };

    return (
        <Section
            title="PII detection"
            description="Redact personal data from chat input before it leaves the browser. Runs entirely client-side via transformers.js + ONNX."
        >
            <Checkbox
                class="flex items-center gap-2"
                checked={useSettings().piiEnabled}
                onChange={(v) => runtime.patchSettings({ piiEnabled: v })}
            >
                <CheckboxInput class="sr-only" />
                <CheckboxControl />
                <CheckboxLabel class="cursor-pointer">Use PII detection in chats</CheckboxLabel>
            </Checkbox>

            <Show when={useSettings().piiEnabled}>
                <div class="rounded-md border bg-background px-3 py-3 flex flex-col gap-2 text-xs">
                    <div class="flex items-center gap-2">
                        <span class="text-muted-foreground">Model:</span>
                        <Show
                            when={manifest()}
                            fallback={
                                <span class="italic text-muted-foreground">loading manifest…</span>
                            }
                        >
                            {(m) => (
                                <a
                                    href={m().source_url}
                                    target="_blank"
                                    rel="noopener"
                                    class="font-mono hover:underline"
                                >
                                    {m().model_id}
                                </a>
                            )}
                        </Show>
                        <Show when={manifest()}>
                            <span class="font-mono rounded border px-1 py-0.5 text-[10px] uppercase bg-muted/60">
                                {manifest()!.dtype}
                            </span>
                        </Show>
                    </div>
                    <div class="flex items-center gap-2">
                        <Show
                            when={warm()}
                            fallback={
                                <Button onClick={download} disabled={downloading()}>
                                    <Show
                                        when={downloading()}
                                        fallback={
                                            <>
                                                Download
                                                <Show when={sizeLabel()}> {sizeLabel()}</Show>
                                            </>
                                        }
                                    >
                                        <Spinner /> Downloading…
                                    </Show>
                                </Button>
                            }
                        >
                            <span class="text-emerald-600 dark:text-emerald-400">✓ Loaded</span>
                            <Show when={bootMs()}>
                                <span class="text-muted-foreground">(boot {bootMs()} ms)</span>
                            </Show>
                        </Show>
                    </div>
                    <Show when={downloadError()}>
                        <p class="text-destructive font-mono whitespace-pre-wrap">
                            {downloadError()}
                        </p>
                    </Show>
                </div>
            </Show>
        </Section>
    );
};

const PowerUserSection: Component = () => {
    const subOptions: {
        key: keyof Settings;
        label: string;
        description: string;
    }[] = [
        {
            key: 'showSqlConsole',
            label: 'SQL console',
            description: 'Direct SQLite REPL on the seeded database.',
        },
        {
            key: 'showPiiTester',
            label: 'PII detector testing',
            description: 'Standalone PII playground at /pii.',
        },
        {
            key: 'showQjsTester',
            label: 'QuickJS testbed',
            description: 'QuickJS WASM evaluator playground at /qjs.',
        },
    ];

    return (
        <Section
            title="Power user mode"
            description="Surface advanced tools that are hidden by default."
        >
            <Checkbox
                class="flex items-center gap-2"
                checked={useSettings().powerUser}
                onChange={(v) => runtime.patchSettings({ powerUser: v })}
            >
                <CheckboxInput class="sr-only" />
                <CheckboxControl />
                <CheckboxLabel class="cursor-pointer">Enable power user mode</CheckboxLabel>
            </Checkbox>

            <Show when={useSettings().powerUser}>
                <div class="flex flex-col gap-4">
                    <For each={subOptions}>
                        {(opt) => (
                            <div class="flex flex-col gap-1">
                                <Checkbox
                                    class="flex items-center gap-2"
                                    checked={useSettings()[opt.key] as unknown as boolean}
                                    onChange={(v) => runtime.patchSettings({ [opt.key]: v })}
                                >
                                    <CheckboxInput class="sr-only" />
                                    <CheckboxControl />
                                    <CheckboxLabel class="cursor-pointer">
                                        {opt.label}
                                    </CheckboxLabel>
                                </Checkbox>
                                <p class="text-xs text-muted-foreground pl-6">{opt.description}</p>
                            </div>
                        )}
                    </For>
                </div>
            </Show>
        </Section>
    );
};

const DataSourcesSection: Component = () => {
    return (
        <Section
            title="Data sources"
            description="Storage mode for new data sources. This is an app-wide setting — every new source created from now on uses this mode. Existing sources keep whatever storage they were created with; changing this setting does NOT migrate them."
        >
            <fieldset class="flex flex-col gap-1 text-xs">
                <For
                    each={[
                        {
                            value: 'memory' as const,
                            label: 'In memory',
                            hint: 'Lives in the SharedWorker; lost when the last tab closes.',
                        },
                        {
                            value: 'temp' as const,
                            label: 'Temp',
                            hint: 'OPFS file kept while the worker is alive; purged on fresh boot.',
                        },
                        {
                            value: 'persistent' as const,
                            label: 'Persistent (recommended)',
                            hint: 'OPFS file, survives reloads and restarts.',
                        },
                    ]}
                >
                    {(opt) => (
                        <label class="flex items-start gap-2 rounded border border-border px-2 py-1.5 hover:bg-muted/40 cursor-pointer">
                            <input
                                type="radio"
                                name="defaultDataSourcePersistence"
                                class="accent-foreground mt-1"
                                value={opt.value}
                                checked={useSettings().defaultDataSourcePersistence === opt.value}
                                onChange={() =>
                                    runtime.patchSettings({
                                        defaultDataSourcePersistence: opt.value,
                                    })
                                }
                            />
                            <span>
                                <span class="text-sm font-medium">{opt.label}</span>
                                <span class="block text-xs text-muted-foreground">{opt.hint}</span>
                            </span>
                        </label>
                    )}
                </For>
            </fieldset>
        </Section>
    );
};

const DiagnosticsSection: Component = () => {
    const [restarting, setRestarting] = createSignal(false);

    const handleRestart = async () => {
        if (
            !confirm(
                'Force restart all workers? Every open tab of this app will reload. Any in-flight chat response will be lost.',
            )
        )
            return;
        setRestarting(true);
        try {
            // Fire-and-forget — the worker broadcasts a runtime-restart
            // event and then closes itself, so this tab's reload is
            // triggered by the broadcast handler in runtime/client.ts.
            await runtime.forceRestart();
        } catch {
            // The RPC may reject because the worker self-closes; the
            // reload still happens via the broadcast. Ignore.
        }
    };

    return (
        <Section
            title="Diagnostics"
            description="Reload all background processes and application tabs."
        >
            <div class="flex items-center gap-2">
                <Button variant="outline" onClick={handleRestart} disabled={restarting()}>
                    <Show when={restarting()} fallback="Force reload all">
                        <Spinner />
                        <span class="ml-2">Restarting…</span>
                    </Show>
                </Button>
            </div>
        </Section>
    );
};

const MyDataSection: Component = () => {
    const [confirmOpen, setConfirmOpen] = createSignal(false);
    const [deleting, setDeleting] = createSignal(false);
    const [deleteError, setDeleteError] = createSignal<string | null>(null);
    const [deleted, setDeleted] = createSignal(false);
    const [downloading, setDownloading] = createSignal(false);
    const [downloadError, setDownloadError] = createSignal<string | null>(null);

    const openConfirm = () => {
        setDeleteError(null);
        setDeleted(false);
        setConfirmOpen(true);
    };

    const runDelete = async () => {
        if (deleting()) return;
        setDeleting(true);
        setDeleteError(null);
        try {
            await clearAllData();
            setConfirmOpen(false);
            setDeleted(true);
        } catch (e) {
            setDeleteError(e instanceof Error ? e.message : String(e));
        } finally {
            setDeleting(false);
        }
    };

    const downloadActions = async () => {
        if (downloading()) return;
        setDownloading(true);
        setDownloadError(null);
        try {
            const json = await buildActionsExportJson();
            const bytes = new TextEncoder().encode(json);
            // 2026-06-03T14-30-00 — colons aren't legal in filenames on
            // Windows, so flatten the ISO timestamp's separators.
            const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
            downloadBytes(bytes, `analyst-actions-${stamp}.json`, 'application/json');
        } catch (e) {
            setDownloadError(e instanceof Error ? e.message : String(e));
        } finally {
            setDownloading(false);
        }
    };

    return (
        <Section
            title="My data"
            description="Everything Analyst stores lives only in this browser: your data sources (the SQLite databases and tables, whether held in OPFS or in memory) and your full action history (saved actions, their versions, and every run and result). Deleting wipes all of it permanently and cannot be undone. Your settings and API key are not touched — use “Reset settings” below for those."
        >
            <div class="flex flex-wrap items-center gap-2">
                <Button variant="destructive" onClick={openConfirm}>
                    Delete all my data
                </Button>
                <Button variant="outline" onClick={downloadActions} disabled={downloading()}>
                    <Show when={downloading()} fallback="Download all actions">
                        <Spinner />
                        <span class="ml-2">Preparing…</span>
                    </Show>
                </Button>
                <span class="text-xs text-muted-foreground">Deleting is irreversible.</span>
            </div>

            <Show when={downloadError()}>
                <p class="text-xs text-destructive font-mono whitespace-pre-wrap">
                    {downloadError()}
                </p>
            </Show>
            <Show when={deleted()}>
                <p class="text-xs text-emerald-600 dark:text-emerald-400">
                    ✓ All data sources and action history deleted.
                </p>
            </Show>

            <ConfirmDialog
                open={confirmOpen()}
                onOpenChange={setConfirmOpen}
                title="Delete all my data?"
                description="This permanently deletes every data source (all SQLite databases and tables, in OPFS and in memory) and your entire action history — saved actions, versions, and run results. This cannot be undone."
                confirmLabel={deleting() ? 'Deleting…' : 'Delete everything'}
                tone="destructive"
                closeOnConfirm={false}
                onConfirm={runDelete}
                body={
                    deleteError() ? (
                        <p class="text-destructive font-mono whitespace-pre-wrap">
                            {deleteError()}
                        </p>
                    ) : undefined
                }
            />
        </Section>
    );
};

const ResetSection: Component = () => (
    <Section
        title="Reset settings"
        description="Wipe every setting on this page back to its default. Clears your API keys."
    >
        <div class="flex items-center gap-2">
            <Button
                variant="destructive"
                onClick={() => {
                    if (confirm('Reset all settings to defaults? Your API keys will be cleared.'))
                        runtime.resetSettings();
                }}
            >
                Reset to defaults
            </Button>
            <span class="text-xs text-muted-foreground">This is irreversible.</span>
        </div>
    </Section>
);

const EyeIcon = () => (
    <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="size-4"
    >
        <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z" />
        <circle cx="12" cy="12" r="3" />
    </svg>
);

const EyeOffIcon = () => (
    <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="size-4"
    >
        <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
        <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
        <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
        <line x1="2" y1="2" x2="22" y2="22" />
    </svg>
);

const TrashIcon = () => (
    <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="size-4"
    >
        <path d="M3 6h18" />
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
);

const Spinner = () => (
    <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="size-3.5 animate-spin"
    >
        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
);

const GithubIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="size-4">
        <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.92.58.11.79-.25.79-.55 0-.27-.01-1.16-.02-2.1-3.2.7-3.87-1.36-3.87-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.76 2.7 1.25 3.36.96.1-.74.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.18-3.1-.12-.29-.51-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11.1 11.1 0 0 1 5.79 0c2.21-1.49 3.18-1.18 3.18-1.18.63 1.59.23 2.76.11 3.05.74.81 1.18 1.84 1.18 3.1 0 4.42-2.69 5.4-5.25 5.69.41.35.78 1.04.78 2.1 0 1.51-.01 2.73-.01 3.1 0 .3.21.66.8.55C20.21 21.39 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5z" />
    </svg>
);

const StarIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="size-4">
        <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
    </svg>
);

export default SettingsPage;
