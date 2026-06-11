# eatmydata.ai

Answer questions from your data without uploading it anywhere.

No cloud, no subscriptions, no privacy concerns.

Host it yourself - free, open-source, MIT licensed, no backend.

We support OpenRouter (from app), and any LLM provider from Vercel AI SDK list (configured in app JSON);

## Workflow

1. Connect OpenRouter account;
2. Upload your data from spreadsheets or csv;
3. Ask question and get answer FAST;
4. See it on charts or in spreadsheet;
5. Goto 3

Slice, dice, filter, relate, correlate, extrapolate, we can do it all.

Just explain your needs in plain English, and work on result step by step together pairing with AI.

## Why we built it

For fast throwaway data analysis or queries from questions in English.

We firmly believe that **time from idea to answer matters** and often we need a tool to explore data within next 5 minutes.

We hate every minute spent debugging SQL, charts, BI and Excel formulas as well as Jupyter notebooks.

## Why we _really_ built it

It's a testbed for various data exploration patterns and tools. We use experience learned
here in other projects. We also use this repo to try bespoke AI kernels optimized for WASM SIMD,
or to implement papers to code, or to support missed functionality in open-source software.
At the end of the day, we use this software ourselves for personal throwaway data analysis.

Some of the libraries used in this project are specific forks or missing links
in upstream. For example, `xlsx` is a great library but lacks styles support (implemented here),
and sqlite vector extension implementing TurboQuant (`sqliteai/sqlite-vector`) is prohibitely licensed, so we had to implement our own MIT-licensed from scratch.

# What do we have here

## Text-to-SQL-to-Presentation

Basically we generate dashboards or tables by writing one or more SQL queries for your data, and putting it on dashboards.

AI decides which queries to write, and which dashboards to build. We provide it with dev tools, secure access to your data without exposing it to prompts, with semantic indexes and validation at every step for self-correction.

This is not a benchmarked text-to-SQL, however we have a couple of cards in the sleeve
to make it accurate - semantic indexing, schema exploration agent and PII filtering.

## Architecture

Everything is bundled in a backend-free web app:

- An `{orchestrator - sql_planner - coder}` loop that produces a Saved Action (`N` queries + code + `M` outputs). Pairing it with `gemini- flash-2.5-lite` is a lot of fun for close-to-zero cost.

- **Sync OPFS** local **sqlite** database in **DedicatedWorker** (`OPFSCoopSyncVFS` + **Web Locks**)

- Bundled **NER PII engine** + **semantic indexing**.

- MIT-licensed **TurboQuant extension for sqlite**, compatible with sync calling pattern, and bundled with **inference engine**:

```
-- select top 20 products semantically related to shoes
SELECT t.* FROM vector_search('product', 'name', 'shoes', 20) AS t;
```

- MIT-licensed lightweight and WASM-optimized **inference engine for NER and embeddings generation**:
    - LLM-authored SIMD with correctness and performance checked against ONNX Runtime.
    - Up to 1.7x inference speedup compared to ONNX;
    - ~38x smaller WASM binary (~0.34 MB vs ONNX Runtime's ~13 MB).

- from-scratch **Model2Vec static embedder** (distilled from BGE, in the same engine) powers production semantic indexing — a token-table lookup + mean pooling, no transformer forward pass, ~3,500x faster than the BERT encoder, so indexes are built in-browser at import time instead of being shipped pre-built.

- **QuickJS for strict AI code sandboxing**
    - WASM sandbox without network/file/host access;
    - AI-generated JS code that does last-step data processing and assembling of
      the dashboard declaration from multiple SQL sources;

- **Apache ECharts** for charts with all bells and whistles;

- **AG Grid** for responsive virtual grids;

- **XLSX Community with Styles patch** for excel import and export;

- **SolidJS** for superglue that exposes all this goodness to a user through the UI.

## Semantic indexing and NER

We use small models that fit in-browser processing, in `GGUF` format. The converters from HuggingFace models are included. Models are bundled with the app.

| Purpose                    | Model                                                                                                                                                                        |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Embeddings (production)    | [Model2Vec](https://github.com/MinishLab/model2vec) static embedder distilled from [BAAI/bge-base-en-v1.5](https://huggingface.co/BAAI/bge-base-en-v1.5) — 256-dim, f32 GGUF |
| Embeddings (high-accuracy) | [BAAI/bge-small-en-v1.5](https://huggingface.co/BAAI/bge-small-en-v1.5) quantized + GGUF                                                                                     |
| NER                        | [gravitee-io/bert-small-pii-detection](https://huggingface.co/gravitee-io/bert-small-pii-detection) quantized + GGUF                                                         |

**Production semantic search runs a from-scratch Model2Vec static embedder** distilled from BGE: tokenize → gather one static vector per subword token → mean-pool → L2-normalize. There is no transformer forward pass, so it embeds at **~88,000 texts/sec (~3,500x the BERT encoder's ~25/s)** — embedding stops being the indexing bottleneck, which is why indexes are built in-browser at import time rather than shipped pre-built. On short product/column text it reaches ~99% of the full BGE encoder's retrieval quality (MAP@10 0.976 vs 0.987). The `model2vec` Python library is used offline only, to distill the static table; nothing of it ships. The choice is a single compile-time constant (`SEMANTIC_EMBEDDER`), so the bge-small BERT encoder below is one flip away as a high-accuracy alternative.

The BGE-small BERT encoder is still bundled — as that selectable high-accuracy embedder and as the backbone shared with NER. For it (and NER) we use an AI-coded inference engine optimized for these models, with WASM SIMD kernels. The accuracy was validated against ONNX. We outperform the ONNX WASM build by 1.5x - 1.7x, with a ~38x smaller engine binary (~0.34 MB vs ONNX Runtime's ~13 MB).

We mainly needed single-threaded inference for
sqlite integration, NER addition was done just to reduce
init time, bundle size and for proof-of-concept.

## Data privacy

We employ a number of techniques to ensure that data stored in sqlite is never exposed
to remote LLM, and user input that eventually sent to LLM is filtered of any PII.

We won't claim we hide all your data, but we put a reasonably high effort to do so:

- inputs are NER-filtered, blocked, and gated for user confirmation in all input forms;
- high-cardinality data is checked and redacted for PII automatically;
- straight PII is redacted regardless of statistical properties;
- for numerical and shape data, counts, distributions and values are completely hidden or rescaled in LLM tool call answers;

## Demo data

We provide some synthetic data to showcase analysis results,
that we also use for internal testing.

Familiar to any Microsoft DBA or BI user:

- Microsoft Contoso, sqlite port;
- Microsoft AdventureWorks, sqlite port;
- Microsoft NorthWind Traders, sqlite port;
- Our own "ShoeRetailer" database in 3 sizes (xs, m, xl).

Databases can be loaded to your storage from "Data Sources"; semantic indexes are built
in-browser at load time (fast now thanks to the Model2Vec static embedder), enabling queries like
"show me all customer claims about sole defects" or "analyze revenue trends in our pet goods categories".

_TODO: start loading analysis examples bundled with demo db_

# Building

Everything is bundled and controlled by CMakeLists.txt + `make all`.

All WASM binaries are compiled by wasm-sdk, mainly because its so hard to make sense
of Emscripten support code around core WASI.

# Tests

There are:

- vitest tests;
- WASM extension tests;
- inference correctness tests vs ONNX Runtime;
- in-browser tests under `/tests` route;
- Chrome CDP startup Makefiel target (for AI-assisted issue reproduction and debugging)
- per-commit linting + sonarjs SAST;

# Misc

## Deployment

We deploy on static Google Cloud bucket in 2 regions (us/eu) + CDN. See `deploy.sh`.

It's just a static web app, can be deployed absolutely everywhere, including any
airgapped or corporate environment. We do not use trackers, Sentry or anything external that calls home.

## Plans

We plan to improve further:

- stronger data privacy guarantees;
- support for more complex dashboards layouts, drill-downs and drill-through's;
- re-run and send pre-cooked reports on schedule;
- load data from external sources, with clients for remote API's generated by AI (literally not included with app but AI-coded to your needs locally);
- domain-specific databases and analysis examples;
- Local RAG for reference queries and reports for business verticals;
- Multi-user collaborative work via simple S3 backend storage;
- Integrating some of the anaysis flows with our commercial product (vertical SaaS);
- and more!

## Reach out

support@eatmydata.ai <!-- secret-scan-allow -- project's own published support contact -->
