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
    type JSX,
} from 'solid-js';
import { generateText } from 'ai';
import { Button } from '@/registry/ui/button';
import { TopBar } from '@/components/top-bar';
import { TextField, TextFieldInput, TextFieldLabel } from '@/registry/ui/text-field';
import { Checkbox, CheckboxControl, CheckboxInput, CheckboxLabel } from '@/registry/ui/checkbox';
import {
    AGENT_MODEL_KEYS,
    resolveAgentModel,
    type AgentModelKey,
    type ProviderInstance,
    type Settings,
} from '@/lib/runtime/state/settings-types';
import { ModelSelector } from '@/components/model-selector';
import { ConfirmDialog } from '@/components/data-sources/confirm-dialog';
import { agentLabel } from '@/lib/agent/labels';
import { getTransformersAccessor, type ModelKey } from '@/lib/transformers/client';
import { runtime, useSettings } from '@/lib/runtime/client';
import { startChromeAiDownload, useChromeAiStatus } from '@/lib/runtime/chrome-ai-status';
import { createModel } from '@/lib/agent/models';
import { adapterFor } from '@/lib/agent/providers';
import { clearAllData } from '@/lib/clear-all-data';
import { buildActionsExportJson } from '@/lib/actions/export';
import { downloadBytes } from '@/lib/data-sources/export-table';
import {
    beginOpenRouterOAuth,
    completeOpenRouterOAuth,
    consumeAuthCode,
    peekPendingOAuth,
} from '@/lib/agent/providers/openrouter-oauth';

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
                    <ApiKeysSection />
                    <AgentsSection />
                    <DataSourcesSection />
                    <TransformersSection />
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
    children: JSX.Element;
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

// ---------------------------------------------------------------------------
// Providers — API keys only (the provider/model catalog is build-time config)
// ---------------------------------------------------------------------------

// Per-provider state of the "Connect OpenRouter" OAuth round-trip. Keyed by
// provider id since several OpenRouter instances may be configured.
type ConnectState =
    | { kind: 'idle' }
    | { kind: 'connecting' }
    | { kind: 'done' }
    | { kind: 'error'; message: string };

const ApiKeysSection: Component = () => {
    // Only providers actually offered (enabled) get a key field. The set of
    // providers/models is fixed by the build-time `@app-config` catalog; model
    // pricing is refreshed automatically in the background (see
    // `primeModelPrices`), so there is no manual "Download prices" control.
    const offered = () => useSettings().providers.filter((p) => p.enabled);

    // OpenRouter OAuth: the "Connect" button redirects to openrouter.ai; on
    // return this page reloads with `?code=…`, which we exchange here for an
    // API key and write into `apiKeys`. State is per-provider so the right row
    // shows the spinner / error.
    const [connect, setConnect] = createSignal<Record<string, ConnectState>>({});
    const setConnectFor = (id: string, s: ConnectState) =>
        setConnect((prev) => ({ ...prev, [id]: s }));

    onMount(async () => {
        const code = consumeAuthCode();
        if (!code) return;
        const pending = peekPendingOAuth();
        if (!pending) {
            // A `?code=` with no stashed verifier: a stale/forged callback, or
            // sessionStorage was lost. Don't attempt an exchange that can't work.
            console.error('[settings] OpenRouter OAuth callback without a pending verifier');
            return;
        }
        setConnectFor(pending.providerId, { kind: 'connecting' });
        try {
            const { providerId, key } = await completeOpenRouterOAuth(code);
            runtime.patchSettings({
                apiKeys: { ...useSettings().apiKeys, [providerId]: key },
            });
            setConnectFor(providerId, { kind: 'done' });
        } catch (e) {
            console.error('[settings] OpenRouter OAuth exchange failed', e);
            setConnectFor(pending.providerId, {
                kind: 'error',
                message: e instanceof Error ? e.message : String(e),
            });
        }
    });

    const startConnect = async (id: string) => {
        setConnectFor(id, { kind: 'connecting' });
        try {
            // Navigates away; only returns (throwing) if the redirect setup fails.
            await beginOpenRouterOAuth(id);
        } catch (e) {
            console.error('[settings] OpenRouter OAuth start failed', e);
            setConnectFor(id, {
                kind: 'error',
                message: e instanceof Error ? e.message : String(e),
            });
        }
    };

    return (
        <Section
            title="Providers"
            description="API keys for the LLM backends configured for this build. The set of providers and models is fixed by the app config; here you supply each provider's key."
        >
            <For each={offered()}>
                {(p) => (
                    <ProviderKeyRow
                        provider={p}
                        connect={connect()[p.id] ?? { kind: 'idle' }}
                        onConnect={() => startConnect(p.id)}
                    />
                )}
            </For>
        </Section>
    );
};

const ProviderKeyRow: Component<{
    provider: ProviderInstance;
    connect: ConnectState;
    onConnect: () => void;
}> = (props) => {
    const adapter = () => adapterFor(props.provider.kind);
    const [showKey, setShowKey] = createSignal(false);

    // Keys are the only persisted provider state — patch the `apiKeys` map by
    // provider id. The catalog (id/kind/label/models) always comes from
    // `@app-config`; the merge overlays this key onto the matching provider.
    const patchKey = (apiKey: string) => {
        runtime.patchSettings({
            apiKeys: { ...useSettings().apiKeys, [props.provider.id]: apiKey },
        });
    };

    return (
        <div class="rounded-lg border bg-background p-4 flex flex-col gap-3">
            <div class="flex items-start justify-between gap-2">
                <span class="text-sm font-medium">{props.provider.label}</span>
                <span class="font-mono text-[10px] uppercase rounded border px-1.5 py-0.5 bg-muted/60">
                    {adapter().label}
                </span>
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
                            onInput={(e) => patchKey(e.currentTarget.value)}
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

            <Show when={props.provider.kind === 'openrouter'}>
                <OpenRouterConnect state={props.connect} onConnect={props.onConnect} />
            </Show>

            <Show when={props.provider.kind === 'chrome-ai'}>
                <ChromeAiPanel />
            </Show>
        </div>
    );
};

// "Connect OpenRouter" button: runs the OAuth PKCE flow so the user gets a key
// without creating/pasting one. The manual key field above still works.
const OpenRouterConnect: Component<{ state: ConnectState; onConnect: () => void }> = (props) => (
    <div class="flex items-center gap-2 flex-wrap">
        <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => props.onConnect()}
            disabled={props.state.kind === 'connecting'}
        >
            <Show when={props.state.kind === 'connecting'} fallback="Connect OpenRouter">
                <Spinner />
                <span class="ml-2">Connecting…</span>
            </Show>
        </Button>
        <Switch>
            <Match when={props.state.kind === 'done'}>
                <span class="text-xs font-medium text-emerald-600 dark:text-emerald-400">
                    ✓ Connected — key saved
                </span>
            </Match>
            <Match when={props.state.kind === 'error' ? props.state : undefined}>
                {(s) => (
                    <span
                        class="text-xs font-medium text-destructive truncate"
                        title={(s() as { message: string }).message}
                    >
                        ✗ {(s() as { message: string }).message}
                    </span>
                )}
            </Match>
        </Switch>
        <span class="text-xs text-muted-foreground basis-full">
            Authorize on openrouter.ai and we'll fill in the key automatically.
        </span>
    </div>
);

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

    const toneClass = (tone: 'ok' | 'warn' | 'muted') => {
        if (tone === 'ok') return 'text-emerald-600 dark:text-emerald-400';
        if (tone === 'warn') return 'text-amber-600 dark:text-amber-400';
        return 'text-muted-foreground';
    };

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
// Agents
// ---------------------------------------------------------------------------

type TestState =
    | { kind: 'idle' }
    | { kind: 'running' }
    | { kind: 'ok'; reply: string; ms: number }
    | { kind: 'error'; message: string };

const AgentsSection: Component = () => {
    // Per-agent test state, so each row reports next to its own "Test" button.
    const [tests, setTests] = createSignal<Partial<Record<AgentModelKey, TestState>>>({});
    const stateOf = (id: AgentModelKey): TestState => tests()[id] ?? { kind: 'idle' };

    const runTest = async (id: AgentModelKey) => {
        const s = useSettings();
        const modelId = resolveAgentModel(s.providers, s.agentModels, id);
        setTests((prev) => ({ ...prev, [id]: { kind: 'running' } }));
        const t0 = performance.now();
        try {
            const { text } = await generateText({
                model: createModel(modelId),
                prompt: 'Respond with the single word "pong" — no punctuation, no quotes.',
            });
            setTests((prev) => ({
                ...prev,
                [id]: {
                    kind: 'ok',
                    reply: text.trim().slice(0, 80) || '(empty reply)',
                    ms: Math.round(performance.now() - t0),
                },
            }));
        } catch (e) {
            setTests((prev) => ({
                ...prev,
                [id]: { kind: 'error', message: e instanceof Error ? e.message : String(e) },
            }));
        }
    };

    return (
        <Section
            title="Agents"
            description="The model each agent uses. New installs default to the app's default model; your choice is saved and overrides it — falling back to the default if that model is no longer available. The orchestrator is the primary agent (it runs chat)."
        >
            <For each={AGENT_MODEL_KEYS}>
                {(id) => (
                    <TextField class={`gap-2 ${CONTROL_WIDTH}`}>
                        <TextFieldLabel>{agentLabel(id)}</TextFieldLabel>
                        <div class="flex w-full gap-2 items-center">
                            <ModelSelector
                                value={resolveAgentModel(
                                    useSettings().providers,
                                    useSettings().agentModels,
                                    id,
                                )}
                                onChange={(v) =>
                                    runtime.patchSettings({
                                        agentModels: { ...useSettings().agentModels, [id]: v },
                                    })
                                }
                                triggerClass={CONTROL_WIDTH}
                            />
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => runTest(id)}
                                disabled={stateOf(id).kind === 'running'}
                            >
                                <Show when={stateOf(id).kind === 'running'} fallback="Test">
                                    <Spinner />
                                    <span class="ml-2">Testing…</span>
                                </Show>
                            </Button>
                            <TestResultInline state={stateOf(id)} />
                        </div>
                    </TextField>
                )}
            </For>
        </Section>
    );
};

// Compact, background-free test outcome shown to the right of the "Test"
// button: a colored icon + short text (full error on hover). The running state
// is conveyed by the button's own spinner, so nothing renders for it here.
const TestResultInline: Component<{ state: TestState }> = (props) => (
    <Switch>
        <Match when={props.state.kind === 'ok' ? props.state : undefined}>
            {(s) => (
                <span class="text-xs font-medium text-emerald-600 dark:text-emerald-400 whitespace-nowrap">
                    ✓ {(s() as { ms: number }).ms} ms
                </span>
            )}
        </Match>
        <Match when={props.state.kind === 'error' ? props.state : undefined}>
            {(s) => (
                <span
                    class="text-xs font-medium text-destructive truncate"
                    title={(s() as { message: string }).message}
                >
                    ✗ {(s() as { message: string }).message}
                </span>
            )}
        </Match>
    </Switch>
);

// One model's download/cache control: model link + dtype chip, a Download
// button showing the file size, and ✓Loaded / ✓Downloaded status. Keyed by
// `modelKey`, so the same row drives PII and embeddings independently. All
// probes route through the worker's keyed accessor methods (the size HEAD
// and cache probe hit the exact ASSET_BASE the model loads from, so they
// can't drift and 404).
const ModelDownloadRow: Component<{
    accessor: ReturnType<typeof getTransformersAccessor>;
    modelKey: ModelKey;
    label?: string;
}> = (props) => {
    const [info] = createResource(() => props.accessor.getModelInfo(props.modelKey));
    const [modelSize] = createResource(() => props.accessor.modelSizeBytes(props.modelKey));
    createEffect(() => {
        if (modelSize.error) {
            console.error(`[settings] ${props.modelKey} model size probe failed:`, modelSize.error);
        }
    });
    const [warm, setWarm] = createSignal(false);
    // Whether the weights are already in the browser HTTP cache (a prior
    // session downloaded them). Independent of `warm` — a fresh worker is
    // cold even when the bytes are cached. Drives hiding the Download button.
    const [cached, setCached] = createSignal(false);
    const [downloading, setDownloading] = createSignal(false);
    const [downloadError, setDownloadError] = createSignal<string | null>(null);
    const [bootMs, setBootMs] = createSignal<number | null>(null);

    onMount(async () => {
        try {
            if (await props.accessor.isWarm(props.modelKey)) {
                setWarm(true);
                setBootMs(await props.accessor.bootElapsedMs(props.modelKey));
                return;
            }
            setCached(await props.accessor.isCached(props.modelKey));
        } catch (e) {
            console.error(`[settings] ${props.modelKey} accessor warm/cache probe failed:`, e);
        }
    });

    const download = async () => {
        setDownloading(true);
        setDownloadError(null);
        try {
            await props.accessor.warmup(props.modelKey);
            setWarm(true);
            setBootMs(await props.accessor.bootElapsedMs(props.modelKey));
        } catch (e) {
            setDownloadError(e instanceof Error ? e.message : String(e));
        } finally {
            setDownloading(false);
        }
    };

    const sizeLabel = () => {
        // Reading an errored resource accessor rethrows in Solid; the
        // effect above already logs it, so degrade to no label here.
        if (modelSize.loading || modelSize.error) return '';
        const bytes = modelSize();
        if (bytes == null) return '';
        const mb = bytes / (1024 * 1024);
        return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
    };

    return (
        <div class="rounded-md border bg-background px-3 py-3 flex flex-col gap-2 text-xs">
            <Show when={props.label}>
                <div class="font-medium">{props.label}</div>
            </Show>
            <div class="flex items-center gap-2">
                <span class="text-muted-foreground">Model:</span>
                <Show
                    when={info()}
                    fallback={<span class="italic text-muted-foreground">loading manifest…</span>}
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
                <Show when={info()}>
                    <span class="font-mono rounded border px-1 py-0.5 text-[10px] uppercase bg-muted/60">
                        {info()!.dtype}
                    </span>
                </Show>
            </div>
            <div class="flex items-center gap-2">
                <Switch
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
                    <Match when={warm()}>
                        <span class="text-emerald-600 dark:text-emerald-400">✓ Loaded</span>
                        <Show when={bootMs()}>
                            <span class="text-muted-foreground">(boot {bootMs()} ms)</span>
                        </Show>
                    </Match>
                    <Match when={cached()}>
                        <span class="text-emerald-600 dark:text-emerald-400">✓ Downloaded</span>
                        <span class="text-muted-foreground">
                            Cached in this browser — loads instantly on next use.
                        </span>
                    </Match>
                </Switch>
            </div>
            <Show when={downloadError()}>
                <p class="text-destructive font-mono whitespace-pre-wrap">{downloadError()}</p>
            </Show>
        </div>
    );
};

const TransformersSection: Component = () => {
    const accessor = getTransformersAccessor();
    return (
        <Section
            title="On-device models"
            description="Models that run entirely in your browser via transformers.js + ONNX. Each is downloaded on demand and cached locally — nothing leaves the device."
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

            {/* PII model download/cache control, shown only when PII is enabled
                — its behavior is unchanged from the old PII detection panel. */}
            <Show when={useSettings().piiEnabled}>
                <ModelDownloadRow
                    accessor={accessor}
                    modelKey="pii"
                    label="PII detection (token-classification NER)"
                />
            </Show>

            {/* Semantic search indexes high-cardinality free-text columns
                automatically at import/seed (Model2Vec static embedder, loaded
                from static assets on first use) — no toggle, no manual step. */}
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
            key: 'showEmbeddingsTester',
            label: 'Embeddings testing',
            description: 'Embedding + cosine-similarity playground at /embeddings.',
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
                        <label class="flex items-start gap-2 rounded px-2 py-1.5 hover:bg-muted/40 cursor-pointer">
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
