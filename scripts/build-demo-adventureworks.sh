#!/usr/bin/env bash
#
# Build src/assets/demo/adventureworks.sqlite by copying the pre-built database
# from contrib/adventureworks-sqlite (martinandersen3d/AdventureWorks-for-SQLite).
#
# Upstream ships AdventureWorks-sqlite.db (~3 MB) containing the LT subset:
# Customer, Product, Sales* tables. Smaller than the full AdventureWorks
# OLTP schema but representative enough for demos and stays well under our
# 200 MB ceiling.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUBMODULE="$ROOT/contrib/adventureworks-sqlite"
SOURCE_DB="$SUBMODULE/AdventureWorks-sqlite.db"
OUT_DIR="$ROOT/src/assets/demo"
OUT="$OUT_DIR/adventureworks.sqlite"

if [ ! -f "$SOURCE_DB" ]; then
    echo "[adventureworks] submodule data missing, initialising…"
    git -C "$ROOT" submodule update --init "$SUBMODULE"
fi

mkdir -p "$OUT_DIR"
cp "$SOURCE_DB" "$OUT"

sqlite3 "$OUT" "PRAGMA integrity_check;" >/dev/null
size=$(du -h "$OUT" | cut -f1)
tables=$(sqlite3 "$OUT" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';")
echo "[adventureworks] wrote $OUT ($size, $tables tables)"

# Semantic-search indexes are NOT prebuilt — the browser builds them at import
# time (autoIndexAfterImport), cheap with the Model2Vec static embedder.
