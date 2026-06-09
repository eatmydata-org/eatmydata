#!/usr/bin/env bash
#
# Build src/assets/demo/northwind.sqlite by copying the pre-built database
# from the contrib/northwind-sqlite3 submodule (jpwhite3/northwind-SQLite3).
#
# The upstream repo ships a complete .db file at dist/northwind.db, so all
# we do is ensure the submodule is initialised and copy it across.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUBMODULE="$ROOT/contrib/northwind-sqlite3"
SOURCE_DB="$SUBMODULE/dist/northwind.db"
OUT_DIR="$ROOT/src/assets/demo"
OUT="$OUT_DIR/northwind.sqlite"

if [ ! -f "$SOURCE_DB" ]; then
    echo "[northwind] submodule data missing, initialising…"
    git -C "$ROOT" submodule update --init "$SUBMODULE"
fi

mkdir -p "$OUT_DIR"
cp "$SOURCE_DB" "$OUT"

# Quick sanity check.
sqlite3 "$OUT" "PRAGMA integrity_check;" >/dev/null
size=$(du -h "$OUT" | cut -f1)
tables=$(sqlite3 "$OUT" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';")
echo "[northwind] wrote $OUT ($size, $tables tables)"

# Prebuild the semantic-search indexes (best-effort; needs `make transformers`).
# Non-fatal so a missing model / vector hiccup never aborts `make demo-data`.
pnpm exec tsx --tsconfig "$ROOT/tsconfig.node.json" "$ROOT/scripts/build-demo-index.ts" "$OUT" \
    || echo "[northwind] semantic index step failed; shipping unindexed"
