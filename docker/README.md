# Docker build

Full, reproducible, from-scratch production build on a fresh Debian. Builds the
WASM artefacts (qjs, wa-sqlite + vector ext, semantic engine), the three
production model GGUFs, and all demo databases, then bundles everything with
Vite into `dist/production`.

Nothing leaks to the host tree: the source is COPYed into the image, all caches
(apt, pnpm store, the CMake `build/` dir incl. the wasi-sdk download, pip,
HuggingFace) live in **BuildKit cache mounts**, and only the selected final
stage is emitted.

## Usage

```sh
# a) Export the production bundle to ./dist/production (and nothing else):
make docker-dist

# b) Build a runnable nginx image serving the bundle, then run it:
make docker-image
docker run --rm -p 8080:80 eatmydata-web:latest
#   open http://localhost:8080
```

Re-runs reuse the cache mounts, so the wasi-sdk, pnpm store, pip wheels and HF
checkpoints are downloaded only once.

## Options

- `INCLUDE_ONNX=1` — also build the transformers.js **ONNX comparison assets**
  (`make onnx-models`) into the bundle. These feed only the `/pii` "compare vs
  ONNX" button and the `/tests` NER-parity cases; the main app never uses them,
  so they are off by default.

    ```sh
    make docker-dist  INCLUDE_ONNX=1
    make docker-image INCLUDE_ONNX=1
    ```

- `WEB_IMAGE=name:tag` — image tag for `docker-image` (default
  `eatmydata-web:latest`).
- `NODE_VERSION` / `PNPM_VERSION` — pinned in `docker/Dockerfile` build args.

## Runtime configuration (no rebuild)

The app's default configuration — the provider/model catalog **and the rest of
the default `Settings`** (default model, per-agent models, feature flags, default
data-source persistence) — is read **at runtime** from a single un-hashed file,
`/config/app-config.json`, so a deployer can change any of it (or pre-seed an API
key) **without rebuilding**. Two layers:

1. **Bundled default** — the catalog compiled into the JS at build time (the
   `@app-config` file: `app-config.dev.json` under dev, `app-config.prod.json`
   for a production build). Always present; the fallback.
2. **Runtime override** — `/config/app-config.json`. When present and
   well-formed it **wins** over the bundled default.

A small **blocking bootstrap in `index.html` loads `/config/app-config.json`
before the app bundle runs** and stashes it on a global; the config manager
(`src/lib/runtime/state/app-config-runtime.ts`) then resolves synchronously —
runtime override if defined, else bundled. So the catalog is in place on the
very first paint (no flicker). The file is served `no-store`, so a remount or
hand-edit takes effect on the next reload. A returning user's own in-app changes
(stored in the browser) still win over the deployed catalog's defaults.

> **Host gate:** the bootstrap is **skipped on the official `*.eatmydata.ai`
> host** — there the app uses the bundled catalog only. Every other origin (your
> Docker host, a custom domain, `localhost`) loads `/config/app-config.json`. So
> this section applies to **your** deploy; the public site ships no `/config/` at
> all (`deploy/deploy.sh` skips it).

### Override by mounting a volume (Docker)

```sh
docker run --rm -p 8080:80 \
  -v "$PWD/my-app-config.json:/usr/share/nginx/html/config/app-config.json:ro" \
  eatmydata-web:latest
```

### Override by editing the static deploy

The exported `dist/production/` (from `make docker-dist`) contains
`config/app-config.json`. On any static host, edit it in place:

```sh
$EDITOR dist/production/config/app-config.json
```

## Configuration file reference

`config/app-config.json` (and the bundled `@app-config` default) share one
shape.

### AI providers

A provider's `kind` selects the backend. The four allowed kinds:

| `kind`              | Backend                             | Auth required          | Notes                                                                                                    |
| ------------------- | ----------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------- |
| `openrouter`        | [OpenRouter](https://openrouter.ai) | `apiKey`               | One key, hundreds of models. `modelId` is the OpenRouter slug, e.g. `openai/gpt-oss-120b:free`.          |
| `google-ai-studio`  | Google AI Studio (Gemini)           | `apiKey`               | `modelId` e.g. `gemini-2.5-flash`. Pricing comes from a committed map.                                   |
| `openai-compatible` | Any OpenAI-compatible HTTP endpoint | `baseURL` (+ `apiKey`) | Ollama / vLLM / LM Studio / Together / Groq / … Set `baseURL`; add `apiKey` if the endpoint requires it. |
| `chrome-ai`         | Chrome on-device (Gemini Nano)      | none (keyless)         | Runs in the browser, no network. Only `gemini-nano`.                                                     |

Every model is referenced application-wide as a **fully-qualified id**
`"<providerId>:<modelId>"` (split on the FIRST colon, so a `modelId` may itself
contain `:`, e.g. `openrouter:openai/gpt-oss-120b:free`). `defaultModelId` uses
this form.

### `config/app-config.json`

Full shape:

```jsonc
{
    // Optional. Fully-qualified id used when an agent has no explicit pick.
    // Defaults to the first enabled model if omitted/invalid.
    "defaultModelId": "openrouter:google/gemini-3.1-flash-lite",

    // Required. The providers offered in the app.
    "providers": [
        {
            "id": "openrouter", // required, unique — also the fqid prefix
            "kind": "openrouter", // required — one of the four kinds above
            "label": "OpenRouter", // required — shown in the UI
            "enabled": true, // optional, default true
            "baseURL": "https://…/v1", // required for openai-compatible; optional override otherwise
            "apiKey": "", // optional — leave "" to enter it in-app, OR set it here to
            //   pre-seed a key for a self-hosted deploy (it is served to every
            //   browser that can reach the site; the committed catalogs ship "" so
            //   the secret scanner stays clean). A user's in-app key still wins.
            "models": [
                // required
                {
                    "modelId": "openai/gpt-oss-120b:free", // required — provider-native id (may contain ":")
                    "label": "GPT-OSS 120B (free)", // required
                    "pricing": {
                        // optional — USD per token; auto-refreshed at boot
                        "prompt": 0, //   (OpenRouter from its API, Google from a committed map)
                        "completion": 0,
                        "cacheRead": 0, // optional
                        "reasoning": 0, // optional
                    },
                },
            ],
        },
    ],

    // The rest of the default Settings (all optional — each falls back to the
    // built-in default if omitted). The config IS the default Settings; a
    // returning user's own in-app change still wins over these.
    "agentModels": { "orchestrator": "", "planner": "", "coder": "" }, // per-agent model fqids ("" → defaultModelId)
    "piiEnabled": true, // on-device PII filtering
    "powerUser": false, // reveal power-user UI (the dev catalog ships true)
    "showSqlConsole": false,
    "showPiiTester": false, // the /pii route surface
    "showEmbeddingsTester": false, // the /embeddings route surface
    "showQjsTester": false,
    "defaultDataSourcePersistence": "persistent", // "memory" | "temp" | "persistent"
}
```

Field summary:

| Path                   | Type                                        | Req. | Meaning                                              |
| ---------------------- | ------------------------------------------- | ---- | ---------------------------------------------------- |
| `defaultModelId`       | fqid string                                 | no   | Fallback model for any agent without a pick.         |
| `providers[]`          | array                                       | yes  | Configured providers.                                |
| `providers[].id`       | string                                      | yes  | Unique id; the prefix in `<id>:<modelId>` fqids.     |
| `providers[].kind`     | one of the 4 kinds                          | yes  | Backend type.                                        |
| `providers[].label`    | string                                      | yes  | Display name.                                        |
| `providers[].enabled`  | boolean                                     | no   | Default `true`. Disabled providers are hidden.       |
| `providers[].baseURL`  | string                                      | \*   | **Required for `openai-compatible`**; else optional. |
| `providers[].apiKey`   | string                                      | no   | Pre-seed a key, or leave `""` to enter it in-app.    |
| `providers[].models[]` | array                                       | yes  | Models offered by this provider.                     |
| `…models[].modelId`    | string                                      | yes  | Provider-native model id.                            |
| `…models[].label`      | string                                      | yes  | Display name.                                        |
| `…models[].pricing`    | `{prompt,completion,cacheRead?,reasoning?}` | no   | USD per token; auto-refreshed at boot.               |

The config also supplies the rest of the default **Settings** (all optional;
each falls back to its built-in default; a returning user's own in-app change
wins):

| Path                           | Type                                  | Meaning                                                |
| ------------------------------ | ------------------------------------- | ------------------------------------------------------ |
| `agentModels`                  | `{ orchestrator?, planner?, coder? }` | Per-agent default model fqids (else `defaultModelId`). |
| `piiEnabled`                   | boolean (default `true`)              | On-device PII NER filtering.                           |
| `powerUser`                    | boolean (dev `true`, prod `false`)    | Power-user UI.                                         |
| `showSqlConsole`               | boolean (default `false`)             | SQL console panel.                                     |
| `showPiiTester`                | boolean (default `false`)             | `/pii` tester surface.                                 |
| `showEmbeddingsTester`         | boolean (default `false`)             | `/embeddings` tester surface.                          |
| `showQjsTester`                | boolean (default `false`)             | QuickJS sandbox tester surface.                        |
| `defaultDataSourcePersistence` | `"memory" \| "temp" \| "persistent"`  | Default persistence pre-selected on import.            |

> **`apiKeys` is not a config field** — it's user-persisted (in the browser). A
> deployer pre-seeds a key via a provider's `apiKey` (above).

### Settings persistence

A user's own settings persist to **localStorage** (read synchronously at boot, so
the first paint reflects them — no flicker). On upgrade from a build that stored
settings in IndexedDB, a one-time migration (`runMigrations()` in
`src/lib/runtime/state/migrations.ts`, run before first render) copies them to
localStorage and deletes the old IndexedDB store.

### Local dev

`vite serve` serves `/config/app-config.json` from the build-selected catalog
(`APP_CONFIG` env, else `app-config.dev.json`), so dev exercises the same path a
deployed build uses. Dev API keys via `.env.local` (`VITE_DEV_*`) continue to
work as before.

## Stages (for `--target` during development)

`base → deps → wasm → models → onnx → demo → bundle → {dist, server}`

```sh
# Build just up to a stage to debug it:
DOCKER_BUILDKIT=1 docker build -f docker/Dockerfile --target wasm -t emd:wasm .
```

## Notes

- The build runs on the host CPU architecture (no emulation); wasi-sdk, Node and
  the Python wheels are fetched for arm64 or amd64 accordingly.
- The production bundle is served with plain static hosting — no COOP/COEP
  headers required (OPFSCoopSyncVFS and the inference engines are
  single-threaded / SAB-free). See `docker/nginx.conf`.
