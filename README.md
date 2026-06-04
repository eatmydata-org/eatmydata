# eatmydata.ai

**Chat with your data locally.**

eatmydata.ai is an AI data analyst for business users
and simple data analytics, built with strong data privacy guarantees in mind.

**No backend** - no accounts, no shared db, no uploads.

**Realtime PII removal** - only obfuscated data sent to remote LLM, and never expose your real data to the LLM
agents writing queries or code _by design_.

**Fully open-source** - app code is fully available
for security reviews and for public use.

**The only cloud service it uses is an LLM provider** - which will change in the near future. We work with
OpenRouter, Google AI Studio, and OpenAI-compatible endpoints.

## Why this exists

"Chat with your data" tools are everywhere, and almost all of them work the same
way: you hand your database to someone else's cloud, their backend runs the
queries, and their model reads your rows. For a personal CSV that's mildly
uncomfortable. For a company's customer table, sales ledger, or anything with
names, emails, and IDs in it, it's a non-starter - the data is exactly the thing
you can't email to a third party.

eatmydata.ai is built on the opposite assumption: **the data never moves.** The
database engine, the file parsing, the analysis, and the storage all run inside
your browser. The only thing that ever crosses the network is the conversation
with the language model - and before that conversation happens, anything that
looks like personal or sensitive information is detected and stripped out
locally, so the model reasons about your _schema and shape_, never your actual
records.

That's the whole point: get the convenience of an AI analyst without giving up
custody of the data.

---

## How the privacy model works

Three things keep your data local, in order of how much you have to trust us
(spoiler: very little - it's all open source and inspectable):

1. **The database runs in your browser.** SQLite is compiled to WebAssembly
   ([wa-sqlite](https://github.com/rhashimoto/wa-sqlite)) and stored in the
   browser's private OPFS filesystem. Importing an Excel/CSV file or opening a
   demo database writes bytes to _your_ disk, not to a server. Queries execute
   on your machine.

2. **The model never sees raw data.** When the assistant needs to look at sample
   rows to understand your data, those samples pass through a local sanitizer
   first. A small on-device NER model (a TinyBERT, running via
   [transformers.js](https://github.com/huggingface/transformers.js)) flags
   names, emails, and IDs, and the sanitizer masks them before anything is sent
   to the LLM. Author-written SQL literals are passed through unmasked - those
   are values _you_ put in the query, so hiding them would protect nothing and
   just break the generated code.

3. **The AI provider is yours.** Today the language model runs through your own
   API key (OpenRouter, Google AI Studio, or any OpenAI-compatible endpoint).
   Your key lives in your browser and is sent only to the provider you chose.
   On-device models (via Chrome's built-in AI, and more to come) are wired in so
   that eventually even the reasoning can happen fully offline.

4. **No cookies, no accounts, no backend to call.** 100% self-hostable,
   and provided for free from EU and US regions in Google Cloud.

---

## The core tool: Actions

Everything the assistant produces is an **Action** - a reusable bundle of:

- one or more **SQL data sources** (the queries that pull the data), plus
- a **code step** that turns those query results into an answer: markdown prose,
  a data table, or an [ECharts](https://echarts.apache.org/) dashboard.

Chat exists only to help you create and refine Actions. When you ask a question,
the assistant proposes a plan, you approve it, and it explores your schema with
bounded, read-only queries before writing any code. Because an Action is a saved
artifact, you can re-run it, tweak it ("now break that down by region"), and
come back to it later - it's not a one-off chat message that scrolls away.

Under the hood the assistant is a small team of cooperating agents: an
**Orchestrator** that talks to you, a **Planner** that explores the schema and
drafts the SQL, and a **Coder** that writes the rendering step. The code step
runs in a sandboxed QuickJS WebAssembly interpreter, so generated code can't
touch the network or the rest of the page.

---

## What's in the box

- **Bring your own data** - drag in an `.xlsx`, `.xls`, or `.csv` and it's
  parsed and stored locally.
- **Demo databases** - ready-made sample datasets (a synthetic retail store,
  Northwind, AdventureWorks, Contoso) to try things out without your own data.
- **Multi-provider AI** - configure one or more LLM providers and keys; each
  agent can use a different model.
- **Real dashboards** - interactive ECharts visualizations, not just tables.
- **Excel export** - styled `.xlsx` output (bold headers, number formats) via a
  patched SheetJS.
- **Multi-tab safe** - open the app in several tabs at once; database access is
  coordinated at the storage layer so tabs don't corrupt each other's writes.

---

## Built with

| Part            | Tool                                                                   |
| --------------- | ---------------------------------------------------------------------- |
| UI              | [SolidJS](https://solidjs.com) + [Vite](https://vite.dev) + TypeScript |
| Components      | shadcn-solid (Kobalte + Tailwind v4)                                   |
| Database        | wa-sqlite over OPFS, one worker per tab                                |
| Code sandbox    | QuickJS compiled to WASM (via wasi-sdk)                                |
| Local PII model | TinyBERT NER via transformers.js / onnxruntime-web                     |
| LLM plumbing    | Vercel AI SDK + per-provider adapters                                  |
| Charts          | ECharts · **Tables** ag-grid · **Export/Import** SheetJS               |
| Storage         | OPFS (databases) + IndexedDB (settings, actions, results)              |

The browser-side WASM artifacts (the SQLite engine, the QuickJS sandbox, the PII
model) are built from vendored submodules with a shared wasi-sdk toolchain.

---

## Running locally

You'll need [pnpm](https://pnpm.io), a recent Node (22+), and CMake (for the
WASM builds). We plan to publish built artefacts in the future.

```bash
# 1. Clone with submodules (wa-sqlite, quickjs, sheetjs, demo datasets, …)
git submodule update --init --recursive    # or: make submodules-init

# 2. Install dependencies
pnpm install

# 3. Build the browser-side WASM artifacts (SQLite engine + sandbox)
make wa-sqlite      # SQLite engine, ~8s
make wasm           # QuickJS sandbox

# 4. (Optional) build the demo databases into public/demo/
make demo-data

# 5. Run the dev server
pnpm dev            # http://localhost:5173
```

To use the AI features, open **Settings** and paste in a provider API key - the
landing page walks you through it (OpenRouter has a free model to start with).
Your key is stored locally in the browser.

### Other commands

```bash
pnpm build          # production build → dist/ (a static site)
pnpm test           # unit tests (vitest)
pnpm lint           # SAST-oriented ESLint
pnpm scan:secrets   # static secret scanner (also runs pre-commit)
```

There's also an in-browser test bench at `/tests` for the things vitest can't
reach (workers, OPFS, multi-tab), plus standalone debug routes (`/wa-sqlite`,
`/pii`, `/sql`, `/qjs`, `/xlsx`).

---

## License

MIT - see [LICENSE](LICENSE). Open source, self-hostable, private and free to use!
