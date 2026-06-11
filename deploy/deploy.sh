#!/bin/bash
#
# Upload the production bundle to the GCS buckets behind eatmydata.ai.
#
# Layout (see vite.config.ts): every Vite-bundled output — JS entry + chunks,
# CSS, and the engine .wasm + bge-embed .gguf — is content-addressed under
# cache/ (cache/<hash>-<name>.<ext>; same bytes -> same URL across releases).
# The demo .sqlite databases and the transformers model/ort assets are copied
# verbatim under a top-level folder named by a checksum of their content. Both
# give rsync the same skip-if-unchanged property; index.html is the only
# un-hashed, per-release file.
#
# Directories are pushed with `rsync`, which compares each local file
# against the matching remote object (size + crc32c) and transfers ONLY
# what's missing or different. That gives us two things for free:
#   * An unchanged content-addressed folder transfers nothing — we don't
#     re-push ~420 MB of identical demo DBs + model on every deploy.
#   * A folder left half-uploaded by an interrupted run is completed on the
#     next run (the missing objects simply don't match yet), instead of
#     being mistaken for "done" and never finished.
#
# index.html is the un-hashed entry point: it references the cache/ chunk +
# asset URLs and the current content-addressed asset folders, so it must go
# live ONLY after everything it points at is uploaded. It is therefore
# deferred to the very last write, immediately before the CDN purge.
#
# The listed extensions are stored gzip-compressed (--gzip-in-flight; the
# only gzip flag `rsync` accepts — `cp` takes it too), matching how the
# bucket has always served them. NOTE: `.onnx` is deliberately NOT listed —
# the model is float weights that barely compress, and a gzip Content-
# Encoding would make the `modelSizeBytes()` HEAD probe report the
# transcoded size. It (and any other unlisted type) is uploaded raw.

set -euo pipefail

DIST=./dist/production
BUCKETS=(eatmydata-eu eatmydata-us)
GZIP_FLAGS=--gzip-in-flight=js,json,css,pbf,xlsx,svg,wasm,sqlite,mjs,map
INDEX=index.html

# Recursively sync a local directory into the bucket, uploading only objects
# that are missing or whose content differs.
gcs_sync() {
    local src=$1 dest=$2
    gcloud storage rsync -r ${GZIP_FLAGS} "$src" "$dest"
}

# Copy a single local file into the bucket, always overwriting.
gcs_copy() {
    local src=$1 dest=$2
    gcloud storage cp ${GZIP_FLAGS} "$src" "$dest"
}

if [[ ! -d "$DIST" ]]; then
    echo "error: $DIST not found — run 'NODE_ENV=production pnpm build' first" >&2
    exit 1
fi
if [[ ! -f "$DIST/$INDEX" ]]; then
    echo "error: $DIST/$INDEX missing — incomplete build?" >&2
    exit 1
fi

for bucket in "${BUCKETS[@]}"; do
    gcloud storage buckets update "gs://$bucket" --web-main-page-suffix="$INDEX"
done

# Every content folder + every root file EXCEPT index.html.
#
# `config/` is deliberately NOT shipped: the public eatmydata.ai site uses the
# config BUNDLED into the JS only (the index.html bootstrap skips the runtime
# /config load on *.eatmydata.ai — see index.html / app-config-runtime.ts), and
# the bucket has no /config path. The build still emits dist/production/config/ for
# self-hosted (Docker) deploys; we just don't upload it here.
for bucket in "${BUCKETS[@]}"; do
    for path in "$DIST"/*; do
        name=$(basename "$path")
        if [[ "$name" == "config" ]]; then
            echo "⏭  skipping config/ (bundled-only on eatmydata.ai)"
            continue
        fi
        if [[ -d "$path" ]]; then
            echo "⇄ $name/ → gs://$bucket"
            gcs_sync "$path" "gs://$bucket/$name"
        elif [[ "$name" != "$INDEX" ]]; then
            echo "↑ $name → gs://$bucket (overwrite)"
            gcs_copy "$path" "gs://$bucket/"
        fi
    done
done

# index.html last — after every asset it references is in place, and right
# before the cache purge.
for bucket in "${BUCKETS[@]}"; do
    echo "↑ $INDEX → gs://$bucket (overwrite, last)"
    gcs_copy "$DIST/$INDEX" "gs://$bucket/"
done

for bucket in "${BUCKETS[@]}"; do
    gcloud compute url-maps invalidate-cdn-cache --async "$bucket" --path "/" --host="eatmydata.ai"
done
