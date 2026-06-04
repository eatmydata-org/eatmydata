import { For, Show, createSignal, type Component, type JSX } from 'solid-js';
import { A, useNavigate } from '@solidjs/router';
import { Button } from '@/registry/ui/button';
import { TopBar } from '@/components/top-bar';
import { Logo } from '@/components/brand';
import { DemoDialog } from '@/components/data-sources/demo-dialog';
import { createSourceFromFile } from '@/lib/data-sources/create-from-file';
import { useSettings } from '@/lib/runtime/client';
import { hasUsableProvider } from '@/lib/runtime/state/settings-types';
import type { DataSource } from '@/lib/data-sources/types';
import type { DemoFamily } from '@/lib/data-sources/about';

const GITHUB_URL = 'https://github.com/eatmydata-org/eatmydata';

const DEMO_PILLS: ReadonlyArray<{ family: DemoFamily; label: string; blurb: string }> = [
    { family: 'retail', label: 'Retail', blurb: 'Synthetic store: orders, products, customers' },
    { family: 'northwind', label: 'Northwind', blurb: 'Classic food-trading sample' },
    { family: 'adventureworks', label: 'AdventureWorks', blurb: 'Bike shop, normalised schema' },
];

const EXAMPLE_QUESTIONS = [
    'What tables are in this database?',
    'Which products are growing fastest this year?',
    'Show monthly revenue by region',
    'Find customers at risk of churning',
];

const Landing: Component = () => {
    const navigate = useNavigate();
    const settings = useSettings();
    const configured = () => hasUsableProvider(settings.providers);

    // Demo dialog, opened pre-selected from a pill.
    const [demoOpen, setDemoOpen] = createSignal(false);
    const [demoFamily, setDemoFamily] = createSignal<DemoFamily>('retail');
    const openDemo = (family: DemoFamily) => {
        setDemoFamily(family);
        setDemoOpen(true);
    };
    const handleDemoCreated = (_src: DataSource) => {
        navigate('/chat');
    };

    // Drag-drop / browse import of a single Excel or CSV file.
    const [dragging, setDragging] = createSignal(false);
    const [importing, setImporting] = createSignal(false);
    const [importError, setImportError] = createSignal<string | null>(null);

    const importFile = async (file: File) => {
        if (importing()) return;
        setImportError(null);
        setImporting(true);
        try {
            // Files are parsed and stored locally — never uploaded anywhere.
            await createSourceFromFile(file, 'persistent');
            navigate('/chat');
        } catch (e) {
            setImportError(e instanceof Error ? e.message : String(e));
        } finally {
            setImporting(false);
        }
    };

    const onDrop = (e: DragEvent) => {
        e.preventDefault();
        setDragging(false);
        const file = e.dataTransfer?.files?.[0];
        if (file) void importFile(file);
    };

    let fileInput: HTMLInputElement | undefined;

    return (
        <main class="h-svh flex flex-col bg-background text-foreground">
            <TopBar />

            <div class="flex-1 min-h-0 overflow-y-auto">
                <div class="mx-auto max-w-5xl px-4 py-12 flex flex-col gap-16">
                    {/* ───────────────────────── hero ───────────────────────── */}
                    <section class="flex flex-col items-center text-center gap-5">
                        <Logo class="h-28 w-auto" />
                        <h1 class="text-5xl font-bold tracking-tight lowercase">eatmydata.ai</h1>
                        <p class="text-xl text-foreground/90 max-w-2xl">
                            Chat with your data — it never leaves your computer.
                        </p>
                        <p class="text-sm text-muted-foreground max-w-2xl">
                            A private, local-first AI analyst. Your databases and analysis all run
                            and stored inside your own browser. No cloud. No tracking. No accounts.
                            Fully open-source and open for self-host.
                        </p>
                        <div class="flex flex-wrap items-center justify-center gap-2 mt-2">
                            <Button size="lg" onClick={() => openDemo('retail')}>
                                Try a demo database
                            </Button>
                            <Button size="lg" variant="outline" as={A} href="/chat">
                                Open the chat
                            </Button>
                        </div>
                    </section>

                    {/* ─────────────────────── our approach ───────────────────── */}
                    <section class="flex flex-col gap-6">
                        <SectionHeading
                            eyebrow="Our approach"
                            title="Your data stays yours"
                            subtitle="Everything happens on your machine. The parts that talk to a cloud are kept to an absolute minimum — and never see your private data."
                        />
                        <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                            <FeatureCard
                                icon={<LaptopIcon />}
                                title="Runs entirely locally"
                                body="The SQLite engine, file import, and analysis all execute in your browser, on your computer. Your data is never uploaded to any server or cloud."
                            />
                            <FeatureCard
                                icon={<EyeOffIcon />}
                                title="No tracking, ever"
                                body="No analytics, no telemetry, no accounts, no cookies following you around. We don't watch what you do or which questions you ask."
                            />
                            <FeatureCard
                                icon={<ShieldIcon />}
                                title="The AI never sees private data"
                                body="Before any question is sent to the model, personal and sensitive info — names, emails, IDs — is detected and stripped out in realtime, locally on your computer."
                            />
                            <FeatureCard
                                icon={<ChipIcon />}
                                title="Local AI models, soon"
                                body="Today the language model runs through your own provider key. Next, we're bringing on-device models so even the AI runs on your machine — fully offline."
                            />
                            <FeatureCard
                                icon={<CodeIcon />}
                                title="Open-source & traceable"
                                body="Every step the assistant takes is visible and inspectable — see the exact SQL it runs. The whole app is open-source, with nothing hidden."
                            />
                            <FeatureCard
                                icon={<ServerIcon />}
                                title="Self-host it"
                                body="It's just a static web app. Run it on your own infrastructure, on an air-gapped machine, or straight off your laptop."
                            />
                        </div>
                    </section>

                    {/* ───────────────────────── get started ──────────────────── */}
                    <section class="flex flex-col gap-6">
                        <SectionHeading
                            eyebrow="Get started"
                            title="Four steps to your first answer"
                        />
                        <div class="flex flex-col gap-4">
                            {/* Step 1 — provider */}
                            <Step
                                n={1}
                                title="Set up your AI provider"
                                aside={
                                    <Show
                                        when={configured()}
                                        fallback={
                                            <Button as={A} href="/settings" variant="default">
                                                Open Settings
                                            </Button>
                                        }
                                    >
                                        <span class="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-3 py-1 text-sm font-medium text-emerald-600 dark:text-emerald-400">
                                            <CheckIcon /> API key connected
                                        </span>
                                    </Show>
                                }
                            >
                                <p>
                                    We support{' '}
                                    <ExtLink href="https://openrouter.ai">OpenRouter</ExtLink> for
                                    now. We recommend trying the free OpenAI model there —{' '}
                                    <span class="font-medium text-foreground">
                                        GPT-OSS-120B (free)
                                    </span>
                                    .
                                </p>
                                <ol class="mt-2 flex flex-col gap-1.5 text-sm text-muted-foreground list-decimal pl-5">
                                    <li>
                                        Create a free account at{' '}
                                        <ExtLink href="https://openrouter.ai">
                                            openrouter.ai
                                        </ExtLink>
                                        .
                                    </li>
                                    <li>
                                        Generate a key at{' '}
                                        <ExtLink href="https://openrouter.ai/keys">
                                            openrouter.ai/keys
                                        </ExtLink>
                                        .
                                    </li>
                                    <li>
                                        Paste it into{' '}
                                        <A
                                            href="/settings"
                                            class="underline underline-offset-2 hover:text-foreground"
                                        >
                                            Settings → Provider
                                        </A>
                                        .
                                    </li>
                                </ol>
                                <p class="mt-2 text-xs text-muted-foreground">
                                    🔒 Your API key is stored locally in your browser and is never
                                    uploaded to any cloud — it's sent only to OpenRouter when you
                                    ask a question.
                                </p>
                            </Step>

                            {/* Step 2 — demo */}
                            <Step
                                n={2}
                                title="Open a demo database"
                                aside={
                                    <span class="text-sm text-muted-foreground">
                                        downloaded once, stored on disk
                                    </span>
                                }
                            >
                                <p>
                                    No data of your own yet? Start with a ready-made sample — pick
                                    one and we'll load it as a data source.
                                </p>
                                <div class="mt-3 flex flex-wrap gap-2">
                                    <For each={DEMO_PILLS}>
                                        {(d) => (
                                            <button
                                                type="button"
                                                onClick={() => openDemo(d.family)}
                                                class="group flex flex-col items-start gap-0.5 rounded-lg border bg-background px-3.5 py-2 text-left transition-colors hover:border-primary/50 hover:bg-accent"
                                            >
                                                <span class="text-sm font-semibold">{d.label}</span>
                                                <span class="text-xs text-muted-foreground">
                                                    {d.blurb}
                                                </span>
                                            </button>
                                        )}
                                    </For>
                                </div>
                            </Step>

                            {/* Step 3 — import */}
                            <Step
                                n={3}
                                title="Or drag in your own data"
                                aside={
                                    <span class="text-sm text-muted-foreground">Excel or CSV</span>
                                }
                            >
                                <p>
                                    Drop an Excel or CSV file below. It's parsed locally and{' '}
                                    <span class="font-medium text-foreground">
                                        never uploaded anywhere
                                    </span>
                                    .
                                </p>
                                <div
                                    role="button"
                                    tabindex="0"
                                    aria-label="Drop a file or browse"
                                    onClick={() => fileInput?.click()}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter' || e.key === ' ') fileInput?.click();
                                    }}
                                    onDragOver={(e) => {
                                        e.preventDefault();
                                        setDragging(true);
                                    }}
                                    onDragLeave={() => setDragging(false)}
                                    onDrop={onDrop}
                                    class={
                                        'mt-3 flex flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed px-4 py-8 text-center transition-colors ' +
                                        (dragging()
                                            ? 'border-primary bg-accent'
                                            : 'border-border hover:border-primary/50 hover:bg-accent/50')
                                    }
                                >
                                    <Show
                                        when={!importing()}
                                        fallback={
                                            <span class="text-sm text-muted-foreground">
                                                Importing…
                                            </span>
                                        }
                                    >
                                        <UploadIcon />
                                        <span class="text-sm font-medium">
                                            Drag &amp; drop a file here
                                        </span>
                                        <span class="text-xs text-muted-foreground">
                                            or click to browse — .xlsx, .xls, .csv
                                        </span>
                                    </Show>
                                </div>
                                <input
                                    ref={fileInput}
                                    type="file"
                                    accept=".xlsx,.xls,.csv"
                                    class="hidden"
                                    onChange={(e) => {
                                        const file = e.currentTarget.files?.[0];
                                        e.currentTarget.value = '';
                                        if (file) void importFile(file);
                                    }}
                                />
                                <Show when={importError()}>
                                    <div class="mt-2 rounded border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
                                        {importError()}
                                    </div>
                                </Show>
                            </Step>

                            {/* Step 4 — explore */}
                            <Step
                                n={4}
                                title="Explore and ask questions"
                                aside={
                                    <Button as={A} href="/chat">
                                        Open the chat →
                                    </Button>
                                }
                            >
                                <p>
                                    Ask questions in plain language. The assistant proposes a plan,
                                    you approve it, then it explores your database with bounded,
                                    read-only queries. Try things like:
                                </p>
                                <div class="mt-3 flex flex-wrap gap-2">
                                    <For each={EXAMPLE_QUESTIONS}>
                                        {(q) => (
                                            <A
                                                href="/chat"
                                                class="rounded-full border bg-background px-3 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:bg-accent hover:text-foreground"
                                            >
                                                {q}
                                            </A>
                                        )}
                                    </For>
                                </div>
                            </Step>
                        </div>
                    </section>

                    {/* ───────────────────────── footer ───────────────────────── */}
                    <footer class="flex flex-col items-center gap-3 border-t pt-8 pb-4 text-center">
                        <div class="flex items-center gap-2 text-foreground/80">
                            <Logo class="h-6 w-auto" />
                            <span class="font-semibold lowercase tracking-tight">eatmydata</span>
                        </div>
                        <p class="text-xs text-muted-foreground">
                            Open source · Self-hostable · Runs entirely in your browser
                        </p>
                        <ExtLink href={GITHUB_URL}>View on GitHub</ExtLink>
                    </footer>
                </div>
            </div>

            <DemoDialog
                open={demoOpen()}
                onOpenChange={setDemoOpen}
                onCreated={handleDemoCreated}
                initialFamily={demoFamily()}
            />
        </main>
    );
};

// ───────────────────────────── building blocks ─────────────────────────────

const SectionHeading: Component<{
    eyebrow: string;
    title: string;
    subtitle?: string;
}> = (props) => (
    <div class="flex flex-col gap-1">
        <span class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {props.eyebrow}
        </span>
        <h2 class="text-2xl font-semibold tracking-tight">{props.title}</h2>
        <Show when={props.subtitle}>
            <p class="max-w-2xl text-sm text-muted-foreground">{props.subtitle}</p>
        </Show>
    </div>
);

const FeatureCard: Component<{
    icon: JSX.Element;
    title: string;
    body: string;
}> = (props) => (
    <div class="flex flex-col gap-2 rounded-lg border bg-card/30 p-4">
        <div class="flex size-9 items-center justify-center rounded-md bg-primary/10 text-primary">
            {props.icon}
        </div>
        <h3 class="text-sm font-semibold">{props.title}</h3>
        <p class="text-sm text-muted-foreground">{props.body}</p>
    </div>
);

const Step: Component<{
    n: number;
    title: string;
    aside?: JSX.Element;
    children: JSX.Element;
}> = (props) => (
    <div class="flex flex-col gap-3 rounded-lg border bg-card/30 p-5 sm:flex-row sm:items-start sm:gap-4">
        <div class="flex size-8 flex-none items-center justify-center rounded-full bg-primary font-semibold text-primary-foreground">
            {props.n}
        </div>
        <div class="flex-1 min-w-0">
            <div class="flex flex-wrap items-start justify-between gap-3">
                <h3 class="text-lg font-semibold">{props.title}</h3>
                <Show when={props.aside}>
                    <div class="flex-none">{props.aside}</div>
                </Show>
            </div>
            <div class="mt-1.5 text-sm text-foreground/80">{props.children}</div>
        </div>
    </div>
);

const ExtLink: Component<{ href: string; children: JSX.Element }> = (props) => (
    <a
        href={props.href}
        target="_blank"
        rel="noopener noreferrer"
        class="font-medium text-primary underline underline-offset-2 hover:opacity-80"
    >
        {props.children}
    </a>
);

// ───────────────────────────── icons (inline svg) ──────────────────────────

const iconProps = {
    xmlns: 'http://www.w3.org/2000/svg',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round' as const,
    'stroke-linejoin': 'round' as const,
    'aria-hidden': true,
    class: 'size-5',
};

const LaptopIcon = () => (
    <svg {...iconProps}>
        <rect x="3" y="4" width="18" height="12" rx="2" />
        <path d="M2 20h20" />
    </svg>
);

const EyeOffIcon = () => (
    <svg {...iconProps}>
        <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
        <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
        <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
        <line x1="2" y1="2" x2="22" y2="22" />
    </svg>
);

const ShieldIcon = () => (
    <svg {...iconProps}>
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10" />
        <path d="m9 12 2 2 4-4" />
    </svg>
);

const ChipIcon = () => (
    <svg {...iconProps}>
        <rect x="6" y="6" width="12" height="12" rx="2" />
        <path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2" />
    </svg>
);

const CodeIcon = () => (
    <svg {...iconProps}>
        <polyline points="16 18 22 12 16 6" />
        <polyline points="8 6 2 12 8 18" />
    </svg>
);

const ServerIcon = () => (
    <svg {...iconProps}>
        <rect x="2" y="3" width="20" height="8" rx="2" />
        <rect x="2" y="13" width="20" height="8" rx="2" />
        <line x1="6" y1="7" x2="6.01" y2="7" />
        <line x1="6" y1="17" x2="6.01" y2="17" />
    </svg>
);

const UploadIcon = () => (
    <svg {...iconProps} class="size-6 text-muted-foreground">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="17 8 12 3 7 8" />
        <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
);

const CheckIcon = () => (
    <svg {...iconProps} class="size-4">
        <polyline points="20 6 9 17 4 12" />
    </svg>
);

export default Landing;
