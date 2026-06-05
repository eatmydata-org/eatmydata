#!/usr/bin/make

.PHONY: submodules-init quickjs-update shadcn-solid-update wasm wasm-clean wa-sqlite wa-sqlite-clean wa-sqlite-reset tiny-pii tiny-pii-clean sheetjs sheetjs-update sheetjs-clean sheetjs-reset \
        demo-data demo-data-clean demo-retail demo-retail-xs demo-retail-m demo-retail-xl demo-northwind demo-adventureworks demo-contoso \
        gemini-prices

user-init:
	git config user.name "Support Admin"
	git config user.email "support@eatmydata.ai"
	git config user.signingkey 313CA6276EA778F2
	git config commit.gpgsign true

submodules-init:
	git submodule update --init --recursive

quickjs-update:
	git submodule update --remote contrib/quickjs
	@echo "quickjs bumped to $$(git -C contrib/quickjs describe --tags --always). Review and commit the pointer."

shadcn-solid-update:
	git submodule update --remote contrib/shadcn-solid
	@echo "shadcn-solid bumped to $$(git -C contrib/shadcn-solid describe --tags --always). Review and commit the pointer."

# Build public/qjs.wasm via wasi-sdk (downloaded on first run into build/).
qjs:
	cmake -S . -B build
	cmake --build build --target qjs-wasm

qjs-clean:
	rm -rf build src/assets/qjs.wasm

# Build public/wa-sqlite.wasm via wasi-sdk. Patches contrib/wa-sqlite/src
# in place (see wasm/wa-sqlite/patches/0001-wasi-sdk-build.patch) and
# downloads the sqlite amalgamation on first run.
wa-sqlite:
	cmake -S . -B build
	cmake --build build --target wa-sqlite

wa-sqlite-clean:
	rm -f src/assets/wa-sqlite.wasm build/wa-sqlite-patch.stamp

# Escape hatch: throw away the in-place patch and return contrib/wa-sqlite
# to vanilla v1.1.1. Useful before regenerating the patch.
wa-sqlite-reset:
	cd contrib/wa-sqlite && git checkout -- src/ && git clean -fd src/
	rm -f build/wa-sqlite-patch.stamp

# Convert mozilla-ai/tiny-pii-tinyBERT-general-4L-312D to ONNX for
# transformers.js. Output lands in wasm/tiny-pii/build/deploy/.
tiny-pii:
	cmake -S . -B build
	cmake --build build --target tiny-pii

tiny-pii-clean:
	cmake --build build --target tiny-pii-clean 2>/dev/null || \
	  rm -rf wasm/tiny-pii/build wasm/tiny-pii/export wasm/tiny-pii/.venv src/assets/tiny-pii/*

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

sheetjs-update:
	git submodule update --remote contrib/sheetjs
	@echo "sheetjs bumped to $$(git -C contrib/sheetjs describe --tags --always). Review and commit the pointer."

sheetjs-clean:
	$(MAKE) -C contrib/sheetjs clean 2>/dev/null || true

# Build the pre-seeded .sqlite files served from /public/demo/ by the Data
# Sources page. Output is gitignored — committing 100s of MB into the repo
# would be unkind.
demo-data: demo-retail demo-northwind demo-adventureworks demo-contoso

demo-retail: demo-retail-xs demo-retail-m demo-retail-xl

demo-retail-xs:
	@mkdir -p public/demo
	node --experimental-strip-types --no-warnings scripts/build-demo-retail.ts \
	    --variant xs --out public/demo/retail-xs.sqlite

demo-retail-m:
	@mkdir -p public/demo
	node --experimental-strip-types --no-warnings scripts/build-demo-retail.ts \
	    --variant m --out public/demo/retail-m.sqlite

demo-retail-xl:
	@mkdir -p public/demo
	node --experimental-strip-types --no-warnings scripts/build-demo-retail.ts \
	    --variant xl --out public/demo/retail-xl.sqlite

demo-northwind:
	bash scripts/build-demo-northwind.sh

demo-adventureworks:
	bash scripts/build-demo-adventureworks.sh

# Contoso is opt-in — needs a 7z extractor (`brew install sevenzip`).
# The other demos build without it.
demo-contoso:
	bash scripts/build-demo-contoso.sh

demo-data-clean:
	rm -rf public/demo build/contoso

# Regenerate the committed Gemini static price map from a pre-downloaded
# pricing page. Google has no pricing API, so this uses the `claude` CLI as
# a prompt-based extractor. Pass the saved HTML via HTML=<path>:
#   curl -sL https://ai.google.dev/gemini-api/docs/pricing -o /tmp/gemini.html
#   make gemini-prices HTML=/tmp/gemini.html
gemini-prices:
	@test -n "$(HTML)" || { echo "Usage: make gemini-prices HTML=<path-to-saved-pricing.html>"; exit 1; }
	node --experimental-strip-types --no-warnings scripts/extract-gemini-prices.ts --html "$(HTML)"

