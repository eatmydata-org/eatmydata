#!/usr/bin/env python3
"""
convert-ner-gguf.py — convert gravitee-io/bert-small-pii-detection (a
`BertForTokenClassification`) into a GGUF the `semantic` C engine reads.

The embedding model (bge-small) ships a prebuilt community GGUF; this token-
classification model does NOT (llama.cpp's converter targets embedding/LM BERT and
drops the classification head), so we build one. The semantic engine reads geometry
from metadata at runtime and treats a GGUF carrying `classifier.weight` as a
token-classification model, so the ONLY differences from the bge GGUF are: the
geometry numbers, the `classifier.{weight,bias}` head, and `semantic.gelu="erf"`.

Emits (tensor NAMES match the bge GGUF exactly, so the shared loader handles both):
  * bert.* metadata (block_count, embedding_length, feed_forward_length,
    head_count, context_length, layer_norm_epsilon).
  * Encoder weights: token_embd / token_types / position_embd / *_norm and per
    layer blk.N.{attn_q,attn_k,attn_v,attn_output,ffn_up,ffn_down}.weight/.bias
    + the two LayerNorms. PyTorch `Linear.weight` is [out,in] row-major = exactly
    the [n_out][n_in] the C GEMM wants — no transpose.
  * classifier.weight [num_labels,512] / classifier.bias [num_labels].
  * tokenizer.ggml.tokens: the WordPiece vocab in llama.cpp WPM form (word-initial
    "▁", "##" continuations bare, bracketed specials as-is) — asserted byte-identical
    to the shipped bge GGUF's vocab.
  * semantic.gelu="tanh" (default; the vectorized SIMD GELU — fast, ~3e-4 from the
    model's exact-erf, negligible for argmax). `--gelu erf` for the exact scalar path.
  * ner.labels: the BIO labels (id2label) for documentation; the JS side keeps its
    own copy and the C engine returns the argmax id.

Usage:
  convert-ner-gguf.py [--outtype f32|q8_0] [--model <hf-id-or-path>] --outfile <path>

Runs OFFLINE against the HuggingFace cache (HF_HUB_OFFLINE=1 below); the checkpoint
is the one `make transformers` already downloads for the ONNX export. q8_0 quantizes
only the 2D weight matrices (1D biases/norms stay f32) → ~28 MB vs ~115 MB; the C
loader dequantizes to f32 at load either way.
"""
import argparse
import os
import sys

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

import numpy as np
import torch
import gguf
from transformers import AutoModelForTokenClassification, AutoTokenizer

DEFAULT_MODEL = "gravitee-io/bert-small-pii-detection"

EMB_MAP = {
    "bert.embeddings.word_embeddings.weight": "token_embd.weight",
    "bert.embeddings.token_type_embeddings.weight": "token_types.weight",
    "bert.embeddings.position_embeddings.weight": "position_embd.weight",
    "bert.embeddings.LayerNorm.weight": "token_embd_norm.weight",
    "bert.embeddings.LayerNorm.bias": "token_embd_norm.bias",
}
LAYER_MAP = {
    "attention.self.query.weight": "attn_q.weight",
    "attention.self.query.bias": "attn_q.bias",
    "attention.self.key.weight": "attn_k.weight",
    "attention.self.key.bias": "attn_k.bias",
    "attention.self.value.weight": "attn_v.weight",
    "attention.self.value.bias": "attn_v.bias",
    "attention.output.dense.weight": "attn_output.weight",
    "attention.output.dense.bias": "attn_output.bias",
    "attention.output.LayerNorm.weight": "attn_output_norm.weight",
    "attention.output.LayerNorm.bias": "attn_output_norm.bias",
    "intermediate.dense.weight": "ffn_up.weight",
    "intermediate.dense.bias": "ffn_up.bias",
    "output.dense.weight": "ffn_down.weight",
    "output.dense.bias": "ffn_down.bias",
    "output.LayerNorm.weight": "layer_output_norm.weight",
    "output.LayerNorm.bias": "layer_output_norm.bias",
}


def wpm_transform(token: str) -> str:
    """HF WordPiece token -> llama.cpp WPM stored form (validated == bge GGUF)."""
    if token.startswith("##"):
        return token[2:]
    if token.startswith("[") and token.endswith("]"):
        return token
    return "▁" + token


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--outtype", choices=["f32", "q8_0"], default="q8_0")
    ap.add_argument("--outfile", required=True)
    ap.add_argument(
        "--validate-vocab",
        default="src/assets/models/bge-small-en-v1.5-q8_0.gguf",
        help="bge GGUF to assert the WPM vocab transform against (skipped if absent)",
    )
    ap.add_argument(
        "--gelu",
        choices=["tanh", "erf"],
        default="tanh",
        help="GELU the engine uses for this model. 'tanh' selects the vectorized "
        "SIMD rational-tanh GELU (fast; the standard GELU approximation, ~3e-4 from "
        "exact erf — negligible for argmax, parity vs ONNX stays ~0.98). 'erf' is the "
        "exact erf GELU (scalar, slower) for max fidelity to the model's declared "
        "activation. Default tanh: ~1.5x faster NER with no measurable quality loss.",
    )
    args = ap.parse_args()

    print(f"[convert-ner] loading {args.model} (offline) ...", file=sys.stderr)
    model = AutoModelForTokenClassification.from_pretrained(args.model)
    tok = AutoTokenizer.from_pretrained(args.model)
    cfg = model.config
    sd = {k: v.detach().cpu().to(torch.float32).numpy() for k, v in model.state_dict().items()}

    n_layer = int(cfg.num_hidden_layers)
    d_model = int(cfg.hidden_size)
    n_head = int(cfg.num_attention_heads)
    d_ffn = int(cfg.intermediate_size)
    n_ctx = int(cfg.max_position_embeddings)
    n_labels = int(cfg.num_labels)
    ln_eps = float(getattr(cfg, "layer_norm_eps", 1e-12))
    assert n_labels == len(cfg.id2label), "num_labels vs id2label mismatch"
    labels = [cfg.id2label[i] for i in range(n_labels)]
    print(
        f"[convert-ner] bert: layers={n_layer} d={d_model} heads={n_head} "
        f"ffn={d_ffn} ctx={n_ctx} labels={n_labels}",
        file=sys.stderr,
    )

    # ---- vocab (id-ordered) -> WPM form, asserted == bge GGUF ----
    vocab = tok.get_vocab()
    id2tok = {i: t for t, i in vocab.items()}
    tokens = [wpm_transform(id2tok[i]) for i in range(len(id2tok))]
    if args.validate_vocab and os.path.exists(args.validate_vocab):
        f = gguf.GGUFReader(args.validate_vocab).get_field("tokenizer.ggml.tokens")
        ref = [bytes(f.parts[f.data[i]]).decode("utf-8", "replace") for i in range(len(f.data))]
        ndiff = sum(1 for a, b in zip(tokens, ref) if a != b)
        if len(tokens) == len(ref) and ndiff == 0:
            print("[convert-ner] vocab transform == bge GGUF (1:1) ✓", file=sys.stderr)
        else:
            print(
                f"[convert-ner] WARN vocab differs from bge GGUF "
                f"(len {len(tokens)} vs {len(ref)}, {ndiff} token diffs) — "
                f"tokenization may not match the shared tokenizer.c",
                file=sys.stderr,
            )

    w = gguf.GGUFWriter(args.outfile, "bert")
    w.add_block_count(n_layer)
    w.add_context_length(n_ctx)
    w.add_embedding_length(d_model)
    w.add_feed_forward_length(d_ffn)
    w.add_head_count(n_head)
    w.add_layer_norm_eps(ln_eps)
    # Special-token ids the shared tokenizer reads (keys match semantic.c, incl. the
    # historical "seperator" spelling gguf/llama.cpp use).
    w.add_uint32("tokenizer.ggml.unknown_token_id", 100)
    w.add_uint32("tokenizer.ggml.cls_token_id", 101)
    w.add_uint32("tokenizer.ggml.seperator_token_id", 102)
    w.add_uint32("tokenizer.ggml.padding_token_id", 0)
    w.add_token_list(tokens)
    # GELU mode the engine reads. Default 'tanh' = the vectorized SIMD GELU (fast);
    # 'erf' = exact (scalar, slower). See --gelu help.
    w.add_string("semantic.gelu", args.gelu)
    w.add_array("ner.labels", labels)

    # q8_0 only for the big 2D matmul weights; 1D vectors + the classifier head
    # (51 elems, not a multiple of 32) stay f32.
    def emit(name: str, arr: np.ndarray):
        arr = np.ascontiguousarray(arr)
        if args.outtype == "q8_0" and arr.ndim == 2 and (arr.shape[-1] % 32 == 0):
            # quantize() returns the packed byte rows ((out, in) -> (out, in/32*34));
            # the writer infers the logical [out,in] ne from that byte shape.
            q = gguf.quants.quantize(arr, gguf.GGMLQuantizationType.Q8_0)
            w.add_tensor(name, q, raw_dtype=gguf.GGMLQuantizationType.Q8_0)
        else:
            w.add_tensor(name, arr.astype(np.float32))

    seen = set()
    for hf, gg in EMB_MAP.items():
        emit(gg, sd[hf]); seen.add(hf)
    for L in range(n_layer):
        for suf, gg in LAYER_MAP.items():
            hf = f"bert.encoder.layer.{L}.{suf}"
            emit(f"blk.{L}.{gg}", sd[hf]); seen.add(hf)
    emit("classifier.weight", sd["classifier.weight"]); seen.add("classifier.weight")
    emit("classifier.bias", sd["classifier.bias"]); seen.add("classifier.bias")

    for k in sd:
        if k not in seen and not k.startswith("bert.pooler"):
            print(f"[convert-ner] note: dropped unmapped tensor {k}", file=sys.stderr)

    w.write_header_to_file()
    w.write_kv_data_to_file()
    w.write_tensors_to_file()
    w.close()
    size = os.path.getsize(args.outfile)
    print(f"[convert-ner] wrote {args.outfile} ({size / 1e6:.1f} MB, {args.outtype})", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
