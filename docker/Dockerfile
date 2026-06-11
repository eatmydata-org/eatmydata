# syntax=docker/dockerfile:1.7
#
# Full, from-scratch production build of eatmydata.ai on a fresh Debian.
#
# Builds EVERYTHING the production bundle needs and nothing leaks to the host
# tree: the source is COPYed into the image, every heavy cache lives in a
# BuildKit cache mount (apt / pnpm store / cmake build dir / pip / HuggingFace),
# and only the chosen final stage is emitted.
#
#   make docker-dist    -> builds the `dist` stage and exports dist/production
#   make docker-image   -> builds the `server` stage (runnable nginx image)
#
# Pipeline (one stage each, so a single artefact can be `--target`ed in dev):
#   base    debian + toolchain (apt, node, pnpm)
#   deps    pnpm install        (cache: pnpm store)
#   wasm    make qjs wa-sqlite semantic   (cache: cmake build dir / wasi-sdk)
#   models  make models  -> the 3 production GGUFs   (cache: pip + HF)
#   onnx    optional `make onnx-models` (INCLUDE_ONNX=1)   (cache: pip + HF)
#   demo    make demo-data -> all demo .sqlite DBs   (cache: cmake build dir)
#   bundle  NODE_ENV=production pnpm build -> dist/production
#   dist    FROM scratch — just dist/production (export target)
#   server  FROM nginx   — serves dist/production
#
# Host arch is honoured (no emulation): wasi-sdk + node + wheels are pulled for
# the build platform (arm64 or amd64).

# ---------------------------------------------------------------------------
# base — fresh Debian + the whole host toolchain.
# ---------------------------------------------------------------------------
FROM debian:bookworm-slim AS base

ENV DEBIAN_FRONTEND=noninteractive
# Keep apt's downloaded .debs so the cache mount is actually useful.
RUN rm -f /etc/apt/apt.conf.d/docker-clean && \
    echo 'Binary::apt::APT::Keep-Downloaded-Packages "true";' \
      > /etc/apt/apt.conf.d/keep-cache

RUN --mount=type=cache,id=apt-cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=apt-lib,target=/var/lib/apt,sharing=locked \
    apt-get update && \
    apt-get install -y --no-install-recommends \
        ca-certificates curl git \
        build-essential make cmake pkg-config \
        python3 python3-venv python3-pip python3-dev \
        p7zip-full sqlite3 \
        xz-utils unzip

# Node (official static tarball — deterministic, no extra apt repo) + pnpm.
# pnpm 8 matches the committed lockfileVersion 6.0; install it via npm to avoid
# corepack signature flakiness.
ARG NODE_VERSION=22.12.0
ARG PNPM_VERSION=8.10.5
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      arm64) node_arch=arm64 ;; \
      amd64) node_arch=x64 ;; \
      *) echo "unsupported arch: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" -o /tmp/node.tar.xz; \
    tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1; \
    rm /tmp/node.tar.xz; \
    npm install -g "pnpm@${PNPM_VERSION}"; \
    node --version; pnpm --version

WORKDIR /app

# ---------------------------------------------------------------------------
# deps — install JS dependencies. The pnpm store is a cache mount, so re-runs
# don't re-download. HUSKY=0 skips git-hook install (there is no .git here).
# ---------------------------------------------------------------------------
FROM base AS deps
ENV HUSKY=0
# Copy the whole source up front: the `link:` deps (wa-sqlite, sheetjs) resolve
# into contrib/, so a package.json-only copy wouldn't install cleanly.
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir=/pnpm/store

# ---------------------------------------------------------------------------
# wasm — qjs.wasm, wa-sqlite.wasm (+ vector ext + folded-in semantic engine),
# semantic.wasm. wasi-sdk + the SQLite amalgamation download into build/, which
# is a cache mount (never in the layer), so the ~250 MB SDK is fetched once.
# ---------------------------------------------------------------------------
FROM deps AS wasm
RUN --mount=type=cache,id=cmake-build,target=/app/build \
    make qjs wa-sqlite semantic && \
    ls -l src/assets/wasm/

# ---------------------------------------------------------------------------
# models — the THREE production GGUFs the bundle imports via `new URL(...)`.
# Light venv (torch-cpu + transformers + gguf + model2vec); pip + HF caches are
# mounts. NOT the ONNX export — that's the optional `onnx` stage below.
# ---------------------------------------------------------------------------
FROM wasm AS models
RUN --mount=type=cache,id=pip,target=/root/.cache/pip \
    --mount=type=cache,id=hf,target=/root/.cache/huggingface \
    make models && \
    ls -l src/assets/models/

# ---------------------------------------------------------------------------
# onnx — OPTIONAL transformers.js ONNX comparison assets (/pii + /tests). Heavy
# (optimum + onnxruntime). Off by default; pass --build-arg INCLUDE_ONNX=1.
# ---------------------------------------------------------------------------
FROM models AS onnx
ARG INCLUDE_ONNX=0
RUN --mount=type=cache,id=pip,target=/root/.cache/pip \
    --mount=type=cache,id=hf,target=/root/.cache/huggingface \
    --mount=type=cache,id=cmake-build,target=/app/build \
    if [ "$INCLUDE_ONNX" = "1" ]; then \
        make onnx-models && ls -l src/assets/transformers/ ; \
    else \
        echo "skipping ONNX comparison assets (INCLUDE_ONNX=$INCLUDE_ONNX)"; \
    fi

# ---------------------------------------------------------------------------
# demo — all demo databases (retail xs/m/xl, northwind, adventureworks,
# contoso). The contoso CSV download caches under build/ (cmake-build mount).
# ---------------------------------------------------------------------------
FROM onnx AS demo
RUN --mount=type=cache,id=cmake-build,target=/app/build \
    make demo-data && \
    ls -lh src/assets/demo/

# ---------------------------------------------------------------------------
# bundle — tsc -b && vite build -> dist/production. NODE_ENV=production is set
# ONLY here (setting it earlier would make pnpm install skip devDependencies).
# ---------------------------------------------------------------------------
FROM demo AS bundle
RUN NODE_ENV=production NODE_OPTIONS=--max-old-space-size=4096 pnpm build && \
    test -f dist/production/index.html && \
    ls -1 dist/production/

# ---------------------------------------------------------------------------
# dist — export target. `--output type=local,dest=dist/production` writes only
# the bundle to the host; nothing else escapes the build.
# ---------------------------------------------------------------------------
FROM scratch AS dist
COPY --from=bundle /app/dist/production /

# ---------------------------------------------------------------------------
# server — small runnable image serving the bundle over HTTP.
# ---------------------------------------------------------------------------
FROM nginx:stable-alpine AS server
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=bundle /app/dist/production /usr/share/nginx/html
EXPOSE 80
