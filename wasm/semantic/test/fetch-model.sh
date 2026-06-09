#!/usr/bin/env bash
# Fetch the bge-small-en-v1.5 (embedding) GGUF weights into src/assets/models/
# (gitignored). The SAME file feeds the `semantic` engine's EMBED path and the
# llama.cpp oracle, so the verification is 1:1 regardless of where it came from.
# (The token-classification GGUF is built separately: `make ner-model`.)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
OUT_DIR="$ROOT/src/assets/models"
# Q8_0 is the shipped default: ~33 MB (vs ~67 MB F16), near-lossless, and matches
# the ONNX-q8 footprint. The engine also loads F16/F32 if you prefer those.
OUT="$OUT_DIR/bge-small-en-v1.5-q8_0.gguf"
REPO="CompendiumLabs/bge-small-en-v1.5-gguf"
FILE="bge-small-en-v1.5-q8_0.gguf"

mkdir -p "$OUT_DIR"
if [ -f "$OUT" ]; then
  echo "model already present: $OUT"
  exit 0
fi

# 1) prebuilt community GGUF via huggingface-cli (preferred).
if command -v huggingface-cli >/dev/null 2>&1; then
  echo "downloading $REPO/$FILE via huggingface-cli ..."
  huggingface-cli download "$REPO" "$FILE" --local-dir "$OUT_DIR"
# 2) plain HTTP fallback.
elif command -v curl >/dev/null 2>&1; then
  echo "downloading $FILE via curl ..."
  curl -fL "https://huggingface.co/$REPO/resolve/main/$FILE" -o "$OUT"
# 3) convert the HF checkpoint with contrib/llama.cpp as a last resort.
elif [ -f "$ROOT/contrib/llama.cpp/convert_hf_to_gguf.py" ]; then
  echo "converting BAAI/bge-small-en-v1.5 via contrib/llama.cpp ..."
  python3 "$ROOT/contrib/llama.cpp/convert_hf_to_gguf.py" \
    "BAAI/bge-small-en-v1.5" --outtype q8_0 --outfile "$OUT"
else
  echo "error: need huggingface-cli, curl, or contrib/llama.cpp to obtain the model" >&2
  exit 1
fi

echo "model ready: $OUT ($(du -h "$OUT" | cut -f1))"
