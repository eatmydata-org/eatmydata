#!/usr/bin/env bash
#
# Build src/assets/demo/contoso.sqlite from SQL BI's Contoso V2 100K release.
#
# Two upstream sources:
#   - contrib/contoso-data-generator-v2/scripts/sql/ — DDL scripts authored by
#     SQL BI for the schema (SQL Server flavour; we translate the common
#     subset to SQLite below).
#   - github.com/sql-bi/Contoso-Data-Generator-V2-Data/releases — the CSV
#     bundle is in a release rather than the repo tree, so the build script
#     fetches it from a pinned release tag at build time.
#
# Dependencies: a 7z-compatible extractor (`7zz` on macOS via `brew install
# sevenzip`, or `7z` from p7zip on Linux). If absent the script exits with
# a clear message — Contoso is opt-in.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GEN_SUBMODULE="$ROOT/contrib/contoso-data-generator-v2"
OUT_DIR="$ROOT/src/assets/demo"
OUT="$OUT_DIR/contoso.sqlite"

# Pin to a specific release tag so the artifact is reproducible.
RELEASE_TAG="ready-to-use-data-2024"
ASSET="csv-100k.7z"
ASSET_URL="https://github.com/sql-bi/Contoso-Data-Generator-V2-Data/releases/download/${RELEASE_TAG}/${ASSET}"

CACHE="$ROOT/build/contoso"
mkdir -p "$CACHE" "$OUT_DIR"

# Locate a 7z extractor. macOS: `brew install sevenzip` provides `7zz`.
# Linux: p7zip provides `7z`.
SEVENZ=""
for cand in 7zz 7z 7za; do
    if command -v "$cand" >/dev/null 2>&1; then
        SEVENZ="$cand"
        break
    fi
done
if [ -z "$SEVENZ" ]; then
    cat <<'EOF' >&2
[contoso] no 7z-compatible extractor on PATH.

The Contoso CSV release is .7z-compressed. Install one of:
  macOS:  brew install sevenzip
  Linux:  apt install p7zip-full   # or equivalent

Then re-run `make demo-contoso`. (Other demos build without this dep.)
EOF
    exit 1
fi

# Ensure the generator submodule (DDL scripts) is initialised.
if [ ! -d "$GEN_SUBMODULE/scripts/sql" ]; then
    echo "[contoso] submodule missing, initialising…"
    git -C "$ROOT" submodule update --init "$GEN_SUBMODULE"
fi

# Download CSV bundle if not cached.
ARCHIVE="$CACHE/$ASSET"
if [ ! -f "$ARCHIVE" ]; then
    echo "[contoso] downloading $ASSET (~9 MB)…"
    curl -L --fail -o "$ARCHIVE.tmp" "$ASSET_URL"
    mv "$ARCHIVE.tmp" "$ARCHIVE"
fi

EXTRACTED="$CACHE/csv-100k"
if [ ! -d "$EXTRACTED" ]; then
    echo "[contoso] extracting…"
    rm -rf "$EXTRACTED.tmp"
    mkdir -p "$EXTRACTED.tmp"
    "$SEVENZ" x -y -o"$EXTRACTED.tmp" "$ARCHIVE" >/dev/null
    mv "$EXTRACTED.tmp" "$EXTRACTED"
fi

# Locate the CSV files — the archive nests them one level deep, varying by
# release. Find them dynamically.
CSV_DIR=$(find "$EXTRACTED" -iname 'customer.csv' -print -quit | xargs -I{} dirname {})
if [ -z "$CSV_DIR" ] || [ ! -d "$CSV_DIR" ]; then
    echo "[contoso] could not locate CSVs inside extracted archive at $EXTRACTED" >&2
    exit 1
fi
echo "[contoso] CSVs at $CSV_DIR"

# Build the SQLite DB. The schema below is transcribed column-for-column from
# the actual CSV headers in the V2 100K release (verified against the files),
# NOT from the upstream MSSQL DDL — the two drifted (e.g. Store's column order
# differs, and the Orders fact is split into an order header `orders.csv` plus
# line items `orderrows.csv`). Keep these definitions in lock-step with the
# header rows; column order must match the CSV exactly since `.import` is
# positional.
rm -f "$OUT"
sqlite3 "$OUT" <<'SQL'
PRAGMA journal_mode = OFF;
PRAGMA synchronous  = OFF;
PRAGMA temp_store   = MEMORY;

-- Dimension tables (shared between the Sales and Orders facts).
CREATE TABLE Customer (
    CustomerKey            INTEGER PRIMARY KEY,
    GeoAreaKey             INTEGER,
    StartDT                TEXT,
    EndDT                  TEXT,
    Continent              TEXT,
    Gender                 TEXT,
    Title                  TEXT,
    GivenName              TEXT,
    MiddleInitial          TEXT,
    Surname                TEXT,
    StreetAddress          TEXT,
    City                   TEXT,
    State                  TEXT,
    StateFull              TEXT,
    ZipCode                TEXT,
    Country                TEXT,
    CountryFull            TEXT,
    Birthday               TEXT,
    Age                    INTEGER,
    Occupation             TEXT,
    Company                TEXT,
    Vehicle                TEXT,
    Latitude               REAL,
    Longitude              REAL
);
CREATE TABLE Store (
    StoreKey               INTEGER PRIMARY KEY,
    StoreCode              TEXT,
    GeoAreaKey             INTEGER,
    CountryCode            TEXT,
    CountryName            TEXT,
    State                  TEXT,
    OpenDate               TEXT,
    CloseDate              TEXT,
    Description            TEXT,
    SquareMeters           INTEGER,
    Status                 TEXT
);
CREATE TABLE Product (
    ProductKey             INTEGER PRIMARY KEY,
    ProductCode            TEXT,
    ProductName            TEXT,
    Manufacturer           TEXT,
    Brand                  TEXT,
    Color                  TEXT,
    WeightUnit             TEXT,
    Weight                 REAL,
    Cost                   REAL,
    Price                  REAL,
    CategoryKey            INTEGER,
    CategoryName           TEXT,
    SubCategoryKey         INTEGER,
    SubCategoryName        TEXT
);
CREATE TABLE Date (
    Date                   TEXT PRIMARY KEY,
    DateKey                INTEGER,
    Year                   INTEGER,
    YearQuarter            TEXT,
    YearQuarterNumber      INTEGER,
    Quarter                TEXT,
    YearMonth              TEXT,
    YearMonthShort         TEXT,
    YearMonthNumber        INTEGER,
    Month                  TEXT,
    MonthShort             TEXT,
    MonthNumber            INTEGER,
    DayofWeek              TEXT,
    DayofWeekShort         TEXT,
    DayofWeekNumber        INTEGER,
    WorkingDay             INTEGER,
    WorkingDayNumber       INTEGER
);
CREATE TABLE CurrencyExchange (
    Date                   TEXT,
    FromCurrency           TEXT,
    ToCurrency             TEXT,
    Exchange               REAL
);

-- Fact tables. Sales is fully denormalised (one row per order line). The
-- Orders fact is normalised across an order header + its line items.
CREATE TABLE Sales (
    OrderKey               INTEGER,
    LineNumber             INTEGER,
    OrderDate              TEXT,
    DeliveryDate           TEXT,
    CustomerKey            INTEGER,
    StoreKey               INTEGER,
    ProductKey             INTEGER,
    Quantity               INTEGER,
    UnitPrice              REAL,
    NetPrice               REAL,
    UnitCost               REAL,
    CurrencyCode           TEXT,
    ExchangeRate           REAL
);
CREATE TABLE Orders (
    OrderKey               INTEGER PRIMARY KEY,
    CustomerKey            INTEGER,
    StoreKey               INTEGER,
    OrderDate              TEXT,
    DeliveryDate           TEXT,
    CurrencyCode           TEXT
);
CREATE TABLE OrderRows (
    OrderKey               INTEGER,
    LineNumber             INTEGER,
    ProductKey             INTEGER,
    Quantity               INTEGER,
    UnitPrice              REAL,
    NetPrice               REAL,
    UnitCost               REAL
);
SQL

# Import each CSV. The release CSVs are comma-delimited UTF-8 with RFC-4180
# quoting (e.g. `"Contoso, Ltd"`) and a header row, so we use `.mode csv` (it
# both sets the comma delimiter and honours quotes) and `--skip 1` to drop the
# header — the tables already exist, so `.import` would otherwise load the
# header as a data row. Filenames are lowercase; table names are not.
import_csv() {
    local table="$1"
    local file="$CSV_DIR/$2"
    if [ ! -f "$file" ]; then
        echo "[contoso] skipping $table (no $file)"
        return
    fi
    sqlite3 "$OUT" <<SQL
.mode csv
.import --skip 1 "$file" $table
SQL
}

# table          csv file
import_csv Date             date.csv
import_csv CurrencyExchange currencyexchange.csv
import_csv Store            store.csv
import_csv Customer         customer.csv
import_csv Product          product.csv
import_csv Sales            sales.csv
import_csv Orders           orders.csv
import_csv OrderRows        orderrows.csv

# Add useful indexes after bulk load (much faster than during load).
sqlite3 "$OUT" <<'SQL'
CREATE INDEX IF NOT EXISTS idx_sales_orderdate     ON Sales(OrderDate);
CREATE INDEX IF NOT EXISTS idx_sales_customer      ON Sales(CustomerKey);
CREATE INDEX IF NOT EXISTS idx_sales_product       ON Sales(ProductKey);
CREATE INDEX IF NOT EXISTS idx_orders_orderdate    ON Orders(OrderDate);
CREATE INDEX IF NOT EXISTS idx_orders_customer     ON Orders(CustomerKey);
CREATE INDEX IF NOT EXISTS idx_orderrows_order     ON OrderRows(OrderKey);
CREATE INDEX IF NOT EXISTS idx_orderrows_product   ON OrderRows(ProductKey);
CREATE INDEX IF NOT EXISTS idx_customer_geo        ON Customer(GeoAreaKey);
CREATE INDEX IF NOT EXISTS idx_product_category    ON Product(CategoryKey);
ANALYZE;
SQL

integrity=$(sqlite3 "$OUT" "PRAGMA integrity_check;")
if [ "$integrity" != "ok" ]; then
    echo "[contoso] integrity_check failed: $integrity" >&2
    exit 1
fi
# Guard against a silent empty build (e.g. CSV format drift on a future
# release): the facts must have rows.
sales_rows=$(sqlite3 "$OUT" "SELECT COUNT(*) FROM Sales;")
orderrows=$(sqlite3 "$OUT" "SELECT COUNT(*) FROM OrderRows;")
if [ "$sales_rows" -eq 0 ] || [ "$orderrows" -eq 0 ]; then
    echo "[contoso] fact tables are empty (Sales=$sales_rows, OrderRows=$orderrows) — import likely failed" >&2
    exit 1
fi
size=$(du -h "$OUT" | cut -f1)
tables=$(sqlite3 "$OUT" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';")
echo "[contoso] wrote $OUT ($size, $tables tables, $sales_rows sales rows, $orderrows order rows)"

# Prebuild the semantic-search indexes (best-effort; needs `make transformers`).
# Non-fatal so a missing model / vector hiccup never aborts `make demo-data`.
pnpm exec tsx --tsconfig "$ROOT/tsconfig.node.json" "$ROOT/scripts/build-demo-index.ts" "$OUT" \
    || echo "[contoso] semantic index step failed; shipping unindexed"
