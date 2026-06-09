#!/usr/bin/env bash
# Native verification gate for the `semantic` module.
#
# Compiles the SAME C sources natively (system cc, mirroring `make
# vector-leakcheck`) into sem-cli + embed-compare, then:
#   1. EMBEDDING bit-exactness — checks, on a fixed corpus, that the embedding
#      model's vectors match llama.cpp's llama-embedding and token ids match
#      llama-tokenize. This is also the REGRESSION GUARD for the runtime-geometry
#      refactor (the merged engine must stay 1:1 with the old bge-embed math).
#   2. NER smoke — if the token-classification GGUF is present, runs sem-cli --ner
#      and asserts it flags entities on a known-PII line (the full F1 quality gate
#      lives in vitest: src/lib/bert-ner/quality.test.ts).
#
# We trust the wasm build is 1:1 with this native build (identical C), so this is
# the whole native correctness gate.
#
# Embedding cosine thresholds (precision-aware):
#   * f16 / f32  -> 0.9999  (TRUE 1:1 math gate)
#   * q8_0       -> 0.999   (llama also quantizes activations; ~2e-3 apart)
#
# Get the embedding model with `make embed-model`; the NER model with `make
# ner-model`. Builds the llama.cpp oracle tools on first run. Exits non-zero on
# any mismatch.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SRC="$ROOT/wasm/semantic/src"
TEST="$ROOT/wasm/semantic/test"
BUILD="$ROOT/build/semantic"
MODELS_DIR="$ROOT/src/assets/models"
LLAMA="$ROOT/contrib/llama.cpp"
LLAMA_BUILD="$LLAMA/build"
CC="${CC:-cc}"
MAX_ABS="${MAX_ABS:-0.02}"

fail() { echo "ERROR: $*" >&2; exit 1; }

# Collect present embedding models (dtype:threshold). f16 first so the strict gate
# leads; q8_0 (shipped default) at its precision-appropriate bound.
MODELS=()
THRESH=()
for spec in "f16:0.9999" "f32:0.9999" "q8_0:0.999"; do
  dt="${spec%%:*}"; thr="${spec##*:}"
  path="$MODELS_DIR/bge-small-en-v1.5-$dt.gguf"
  if [ -f "$path" ]; then MODELS+=("$path"); THRESH+=("$thr"); fi
done
[ "${#MODELS[@]}" -gt 0 ] || fail "no embedding GGUF in $MODELS_DIR — run 'make embed-model' first"

mkdir -p "$BUILD"

echo "==> compiling sem-cli + embed-compare natively ($CC)"
# -O3 so the portable 4-accumulator dotf autovectorizes on the host too; the
# native build stays the scalar-fallback path (no -msimd128) and remains the math
# oracle vs llama.cpp.
"$CC" -std=c11 -O3 -Wall -Wextra -Wno-unused-parameter -I "$SRC" \
  "$SRC/gguf.c" "$SRC/unicode-data.c" "$SRC/tokenizer.c" "$SRC/model.c" "$SRC/semantic.c" \
  "$TEST/sem-cli.c" -lm -o "$BUILD/sem-cli" || fail "native build of sem-cli failed"
"$CC" -std=c11 -O2 -o "$BUILD/embed-compare" "$TEST/embed-compare.c" -lm \
  || fail "native build of embed-compare failed"

EMB="$LLAMA_BUILD/bin/llama-embedding"
TOK="$LLAMA_BUILD/bin/llama-tokenize"
if [ ! -x "$EMB" ] || [ ! -x "$TOK" ]; then
  echo "==> building llama.cpp oracle tools (first run; this is slow)"
  cmake -S "$LLAMA" -B "$LLAMA_BUILD" -DCMAKE_BUILD_TYPE=Release -DLLAMA_CURL=OFF \
    -DLLAMA_BUILD_SERVER=OFF >/dev/null 2>&1 || fail "llama.cpp cmake configure failed"
  cmake --build "$LLAMA_BUILD" --target llama-embedding llama-tokenize -j 8 \
    >/dev/null 2>&1 || fail "llama.cpp tools build failed"
fi

CLI="$BUILD/sem-cli"
CMP="$BUILD/embed-compare"

# A 256+ token paragraph (well under the 512 ctx, so neither side truncates).
LONG="$(printf 'Quarterly revenue exceeded forecasts as warehouse logistics, inventory turnover, and seasonal retail demand improved across many fiscal regions. %.0s' $(seq 1 18))"

CORPUS=(
  "hello world"
  "The quarterly revenue exceeded forecasts."
  "Represent this sentence for searching relevant passages: dogs"
  "café naïve résumé Zürich Москва 北京"
  "Mixed CASE, punctuation -- and numbers 12345.67!"
  "$LONG"
)

pass=0; fail=0
for mi in "${!MODELS[@]}"; do
  MODEL="${MODELS[$mi]}"; MIN_COS="${THRESH[$mi]}"
  echo "==> $(basename "$MODEL") — embeddings vs llama-embedding (cls + L2, cosine >= $MIN_COS)"
  for txt in "${CORPUS[@]}"; do
    "$CLI" "$MODEL" "$txt" > "$BUILD/a.txt" 2>/dev/null
    "$EMB" -m "$MODEL" -p "$txt" --pooling cls --embd-normalize 2 \
      --embd-output-format array 2>/dev/null > "$BUILD/b.txt"
    out="$("$CMP" "$BUILD/a.txt" "$BUILD/b.txt" "$MIN_COS" "$MAX_ABS")"
    short="$(printf '%.48s' "$txt")"
    if echo "$out" | grep -q PASS; then
      pass=$((pass+1)); echo "  PASS  [$short] ${out#dim=*  }"
    else
      fail=$((fail+1)); echo "  FAIL  [$short] $out"
    fi
  done
done

# Tokenization is dtype-independent (same vocab); check once against any model.
TMODEL="${MODELS[0]}"
echo "==> token ids vs llama-tokenize (exact match)"
for txt in "hello world" "café naïve résumé Zürich Москва 北京" "Mixed CASE, punctuation -- and numbers 12345.67!"; do
  mine="$("$CLI" --tokens "$TMODEL" "$txt")"
  theirs="$("$TOK" -m "$TMODEL" -p "$txt" 2>/dev/null \
    | grep -oE '^[[:space:]]*[0-9]+' | tr -d ' ' | tr '\n' ' ' | sed 's/ *$//')"
  short="$(printf '%.48s' "$txt")"
  if [ "$mine" = "$theirs" ]; then
    pass=$((pass+1)); echo "  PASS  [$short]"
  else
    fail=$((fail+1)); echo "  FAIL  [$short]"; echo "        mine:  $mine"; echo "        llama: $theirs"
  fi
done

# NER smoke (token-classification GGUF, if present). Full F1 is in vitest.
NER_MODEL=""
for dt in q8_0 f32 f16; do
  p="$MODELS_DIR/bert-small-pii-detection-$dt.gguf"
  if [ -f "$p" ]; then NER_MODEL="$p"; break; fi
done
if [ -n "$NER_MODEL" ]; then
  echo "==> $(basename "$NER_MODEL") — NER smoke (flags entities on known PII)"
  ner_text="My name is Alice Smith, email alice.smith@example.com, SSN 123-45-6789."
  nlines="$("$CLI" --ner "$NER_MODEL" "$ner_text" | awk '$1 != 0' | wc -l | tr -d ' ')"
  if [ "${nlines:-0}" -ge 3 ]; then
    pass=$((pass+1)); echo "  PASS  [$nlines non-O tokens]"
  else
    fail=$((fail+1)); echo "  FAIL  [only ${nlines:-0} non-O tokens]"
  fi
else
  echo "==> NER smoke skipped (no bert-small-pii-detection-*.gguf — run 'make ner-model')"
fi

echo "==================================================="
echo "semantic verify: $pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
echo "OK — semantic embeddings match llama.cpp (f16/f32 1:1 at 0.9999; q8_0 at 0.999); NER smoke ok"
