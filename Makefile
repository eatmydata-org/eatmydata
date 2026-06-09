#!/usr/bin/make

# Bare `make` builds the three wasm artifacts the app needs at runtime.
# transformers / sheetjs / demo-data are opt-in (heavy build deps) and stay
# out of `all` — invoke them explicitly.
.DEFAULT_GOAL := all

.PHONY: all clean
all: qjs wa-sqlite semantic

# Remove the wasm artifacts produced by `all`.
clean: qjs-clean wa-sqlite-clean semantic-clean

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------
.PHONY: user-init submodules-init

user-init:
	git config user.name "Support Admin"
	git config user.email "support@eatmydata.ai"
	git config user.signingkey 313CA6276EA778F2
	git config commit.gpgsign true

submodules-init:
	git submodule update --init --recursive

# Bump a vendored submodule to its remote tip and report the new pointer.
# The stem must match the contrib/ dir name, e.g.
#   make quickjs-update   make shadcn-solid-update   make sheetjs-update
%-update:
	git submodule update --remote contrib/$*
	@echo "contrib/$* bumped to $$(git -C contrib/$* describe --tags --always). Review and commit the pointer."

# ---------------------------------------------------------------------------
# WASM artifacts — all built via wasi-sdk (downloaded on first configure into
# build/). One shared configure + `cmake --build`; the make target name equals
# the cmake target name, except qjs → qjs-wasm. Per-artifact notes:
#   qjs        → src/assets/wasm/qjs.wasm    (QuickJS sandbox)
#   wa-sqlite  → src/assets/wasm/wa-sqlite.wasm — patches contrib/wa-sqlite/src
#                in place (wasm/wa-sqlite/patches/0001-wasi-sdk-build.patch),
#                downloads the sqlite amalgamation, and compiles in the in-tree
#                vector-search extension (wasm/sqlite-vector).
#   semantic   → src/assets/wasm/semantic.wasm — clean-room C BERT engine
#                driving bge-small embeddings AND bert-small-pii NER off a GGUF
#                whose geometry it reads at runtime (no ggml/ONNX).
#   transformers → src/assets/transformers/  — ONNX export of the same models
#                for transformers.js (see wasm/transformers/build.py MODELS).
# ---------------------------------------------------------------------------
.PHONY: qjs wa-sqlite semantic transformers
.PHONY: qjs-clean wa-sqlite-clean wa-sqlite-reset semantic-clean transformers-clean
.PHONY: vector-leakcheck semantic-unicode-data embed-model ner-model semantic-verify transformers-embed-bench

# Configure once; re-run when CMakeLists.txt changes (cmake's generated build
# system self-regenerates too, so this is belt-and-suspenders).
build/CMakeCache.txt: CMakeLists.txt
	cmake -S . -B build

qjs wa-sqlite semantic transformers: build/CMakeCache.txt
	cmake --build build --target $(patsubst qjs,qjs-wasm,$@)

qjs-clean:
	rm -rf build src/assets/qjs.wasm

wa-sqlite-clean:
	rm -f src/assets/wasm/wa-sqlite.wasm build/wa-sqlite-patch.stamp

semantic-clean:
	rm -f src/assets/wasm/semantic.wasm

transformers-clean:
	cmake --build build --target transformers-clean 2>/dev/null || \
	  rm -rf wasm/transformers/build wasm/transformers/.venv src/assets/transformers

# Escape hatch: throw away the in-place patch and return contrib/wa-sqlite
# to vanilla v1.1.1. Useful before regenerating the patch.
wa-sqlite-reset:
	cd contrib/wa-sqlite && git checkout -- src/ && git clean -fd src/
	rm -f build/wa-sqlite-patch.stamp

# Native memory-leak / use-after-free harness for the in-tree vector
# extension (wasm/sqlite-vector). Compiles the same C against the downloaded
# SQLite amalgamation with the system allocator + memory stats ON (the wasm
# build disables them), then runs every vector_search / quantize / scan /
# error path in a loop and asserts sqlite3_memory_used() returns to baseline.
# Built under AddressSanitizer to also catch use-after-free / overflow.
# Needs `make wa-sqlite` first (downloads the amalgamation). See
# wasm/sqlite-vector/test/leakcheck.c.
vector-leakcheck:
	@test -f build/sqlite-amalgamation/sqlite3.c || { echo "Run 'make wa-sqlite' first (it downloads the SQLite amalgamation)"; exit 1; }
	$(CC) -std=c11 -g -O1 -fsanitize=address -fno-omit-frame-pointer \
	    -DSQLITE_THREADSAFE=0 -DSQLITE_ENABLE_COLUMN_METADATA -DSQLITE_OMIT_LOAD_EXTENSION \
	    -I build/sqlite-amalgamation -I wasm/sqlite-vector/src \
	    build/sqlite-amalgamation/sqlite3.c \
	    wasm/sqlite-vector/src/vector.c \
	    wasm/sqlite-vector/src/vec-types.c \
	    wasm/sqlite-vector/src/vec-distance.c \
	    wasm/sqlite-vector/src/vec-config.c \
	    wasm/sqlite-vector/src/vec-quantize.c \
	    wasm/sqlite-vector/src/vec-scan.c \
	    wasm/sqlite-vector/test/leakcheck.c \
	    -lm -o build/vector-leakcheck
	# LeakSanitizer (detect_leaks) is unsupported on macOS — the harness's own
	# sqlite3_memory_used() delta is the portable leak gate; ASan still catches
	# use-after-free / overflow. On Linux, ASAN_OPTIONS=detect_leaks=1 adds an
	# LSan pass on top.
	ASAN_OPTIONS=detect_leaks=0 build/vector-leakcheck

# Regenerate wasm/semantic/src/unicode-data.c from UnicodeData.txt + Python's
# unicodedata (mirrors llama.cpp's gen-unicode-data.py so WPM tokenization
# matches 1:1). The output is committed; rerun only on a Unicode bump.
semantic-unicode-data:
	python3 wasm/semantic/tools/gen-unicode-data.py > wasm/semantic/src/unicode-data.c
	@echo "regenerated wasm/semantic/src/unicode-data.c"

# Fetch the bge-small-en-v1.5 (embedding) GGUF into src/assets/models/ (gitignored).
# Downloads a prebuilt community GGUF, or converts the HF checkpoint via llama.cpp.
embed-model:
	bash wasm/semantic/test/fetch-model.sh

# Convert gravitee-io/bert-small-pii-detection (token-classification) to a GGUF
# the semantic engine reads -> src/assets/models/bert-small-pii-detection-q8_0.gguf
# (gitignored). Offline against the HF cache, via the transformers venv. Run
# `make transformers` once first if the venv is absent.
ner-model:
	wasm/transformers/.venv/bin/python wasm/semantic/tools/convert-ner-gguf.py \
	  --outtype q8_0 --outfile src/assets/models/bert-small-pii-detection-q8_0.gguf

# Native verification gate: compile the SAME C sources natively (system cc, like
# vector-leakcheck), then compare embeddings (cosine) + token ids against
# llama.cpp on a fixed corpus + an NER smoke. Builds the llama.cpp oracle tools on
# first run. Needs the GGUF(s) (make embed-model / ner-model first).
semantic-verify:
	bash wasm/semantic/test/verify.sh

# Like `make transformers`, but also emits single-thread-CPU bench variants of
# the embeddings model (fp32 / fused-fp32 / q8 / fused-q8) alongside the
# production file, plus a `bench_variants` manifest list. Runs build.py directly
# with EMBED_BENCH=1 so it ALWAYS re-runs (the plain `transformers` target is
# gated by a CMake deploy sentinel and would skip a rebuild). The variants feed
# the embed-variants measurement at /tests; they are NOT used by any production
# path and the deploy tree is gitignored, so they never ship. Local/dev only.
transformers-embed-bench: build/CMakeCache.txt
	cmake --build build --target transformers-venv
	cd wasm/transformers && EMBED_BENCH=1 .venv/bin/python build.py

# ---------------------------------------------------------------------------
# SheetJS (xlsx) — opt-in; the committed xlsx.mjs works without this.
# ---------------------------------------------------------------------------
.PHONY: sheetjs sheetjs-reset sheetjs-clean

# Apply patches/sheetjs-styles.patch (adds opts.xlsxCss hooks + fixes
# get_cell_style dedup) and rebuild contrib/sheetjs/xlsx.mjs. Idempotent —
# skips the apply if the patch is already on disk or would conflict.
sheetjs:
	@cd contrib/sheetjs && git apply --check ../../patches/sheetjs-styles.patch 2>/dev/null \
	  && (git apply ../../patches/sheetjs-styles.patch && echo "applied patches/sheetjs-styles.patch") \
	  || echo "patches/sheetjs-styles.patch not applied (already applied or conflicts — check 'git -C contrib/sheetjs diff bits/')"
	$(MAKE) -C contrib/sheetjs

# Escape hatch: throw away patched bits/ and return contrib/sheetjs to vanilla
# v0.20.3. Use before re-running 'make sheetjs' if the patch went sideways.
sheetjs-reset:
	cd contrib/sheetjs && git checkout -- bits/ && git clean -fd bits/

sheetjs-clean:
	$(MAKE) -C contrib/sheetjs clean 2>/dev/null || true

# ---------------------------------------------------------------------------
# Demo data — pre-seeded .sqlite files served from src/assets/demo/ by the Data
# Sources page (the DEMO_ASSET_BASE that demo-source.ts fetches from — dev
# serves it under /src/assets/demo, builds copy it under /<hash>/demo via
# viteStaticCopy). Output is gitignored — committing 100s of MB would be unkind.
# ---------------------------------------------------------------------------
.PHONY: demo-data demo-data-clean demo-retail demo-northwind demo-adventureworks demo-contoso

demo-data: demo-retail demo-northwind demo-adventureworks demo-contoso

demo-retail: demo-retail-xs demo-retail-m demo-retail-xl

# make demo-retail-xs / -m / -xl
demo-retail-%:
	@mkdir -p src/assets/demo
	pnpm exec tsx --tsconfig tsconfig.node.json scripts/build-demo-retail.ts \
	    --variant $* --out src/assets/demo/retail-$*.sqlite

demo-northwind:
	bash scripts/build-demo-northwind.sh

demo-adventureworks:
	bash scripts/build-demo-adventureworks.sh

# requires 7z (on brew `sevenzip`)
demo-contoso:
	bash scripts/build-demo-contoso.sh

demo-data-clean:
	rm -rf src/assets/demo build/contoso

# ---------------------------------------------------------------------------
# Misc
# ---------------------------------------------------------------------------
.PHONY: gemini-prices remote-debug-browser

# Regenerate the committed Gemini static price map from a pre-downloaded
# pricing page. Google has no pricing API, so this uses the `claude` CLI as
# a prompt-based extractor. Pass the saved HTML via HTML=<path>:
#   curl -sL https://ai.google.dev/gemini-api/docs/pricing -o /tmp/gemini.html
#   make gemini-prices HTML=/tmp/gemini.html
gemini-prices:
	@test -n "$(HTML)" || { echo "Usage: make gemini-prices HTML=<path-to-saved-pricing.html>"; exit 1; }
	pnpm exec tsx --tsconfig tsconfig.node.json scripts/extract-gemini-prices.ts --html "$(HTML)"

remote-debug-browser:
	/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
		--remote-debugging-port=9222 \
		--remote-allow-origins=* \
		--user-data-dir=./chrome-debug-profile \
		"http://localhost:5173"
