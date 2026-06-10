#!/usr/bin/env python
"""Distill a Model2Vec STATIC embedder from a BGE teacher and emit a GGUF the
semantic engine reads. The teacher size is a parameter (Model2Vec's runtime cost is
the [vocab x dim] table, independent of teacher size — see wasm/semantic/PERF.md).

The distilled matrix is reindexed into the BGE GGUF's id order (== HF tokenizer id
order; model2vec reorders/removes ids), so the runtime REUSES the existing,
llama-verified WordPiece tokenizer (sem_tokenize) unchanged — the artifact is just
the [bge_vocab x dim] f32 matrix + the bge token list.

Ship f32 (model2vec defaults to f16): cleaner 1:1 parity AND higher quality.

  convert-m2v-gguf.py --source BAAI/bge-base-en-v1.5 --pca-dims 256 \
      --bge-gguf src/assets/models/bge-small-en-v1.5-q8_0.gguf \
      --outfile  src/assets/models/bge-base-m2v-d256.gguf
"""
import argparse, sys
import numpy as np
import gguf
from model2vec.distill import distill
from transformers import AutoTokenizer


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default="BAAI/bge-base-en-v1.5")
    ap.add_argument("--pca-dims", type=int, default=256)
    ap.add_argument("--bge-gguf", default="src/assets/models/bge-small-en-v1.5-q8_0.gguf")
    ap.add_argument("--outfile", required=True)
    args = ap.parse_args()

    log = lambda *a: print("[m2v]", *a, file=sys.stderr, flush=True)

    # 1. distill (full source vocab; we map by string, so removed tokens just become
    #    zero rows in bge-id space and never match real text).
    log(f"distilling {args.source} pca={args.pca_dims} ...")
    sm = distill(model_name=args.source, pca_dims=args.pca_dims)
    emb = sm.embedding.astype(np.float32)        # [m2v_vocab, dim], f32
    dim = emb.shape[1]
    m2v_tok2id = {t: i for i, t in enumerate(sm.tokens)}  # HF-form strings -> m2v id
    log(f"distilled: m2v vocab={emb.shape[0]} dim={dim} median_tok_len={sm.median_token_length}")

    # 2. target id space = the BGE GGUF token list (== HF id order). Copy it verbatim
    #    for the artifact (llama ▁-form, what sem_tokenize expects).
    rd = gguf.GGUFReader(args.bge_gguf)
    f = rd.get_field("tokenizer.ggml.tokens")
    bge_tokens = [bytes(f.parts[f.data[i]]).decode("utf-8", "replace") for i in range(len(f.data))]
    V = len(bge_tokens)
    # HF strings per id (same id space as the bge GGUF, per convert-ner-gguf's 1:1 assert)
    htok = AutoTokenizer.from_pretrained(args.source)
    hf_id2tok = {i: t for t, i in htok.get_vocab().items()}
    assert len(hf_id2tok) == V, f"HF vocab {len(hf_id2tok)} != bge GGUF {V}"

    # 3. reindex: M[bge_id] = m2v vector for that token (by HF string).
    M = np.zeros((V, dim), dtype=np.float32)
    matched = 0
    for i in range(V):
        j = m2v_tok2id.get(hf_id2tok[i])
        if j is not None:
            M[i] = emb[j]
            matched += 1
    log(f"reindexed {matched}/{V} rows into bge id order ({V - matched} zero rows = unused/special)")

    # 4. parity check: our pipeline (HF-bge tokenize -> reindexed M -> recipe) vs
    #    stock model2vec sm.encode (after switching it to f32). cosine must be ~1.
    sm.embedding = emb  # f32 model2vec == what we ship
    probe = ["red running shoes", "Contoso 512MB MP3 Player E51 Silver",
             "wireless noise cancelling headphones with long battery life",
             "café au lait", "lorem ipsum dolor sit amet"]
    truth = sm.encode(probe)
    def ours(text):
        ids = htok(text, add_special_tokens=False)["input_ids"]
        if not ids:
            return np.zeros(dim, np.float32)
        rows = M[np.asarray(ids)]
        acc = np.zeros(dim, np.float32)
        for r in rows:
            acc = (acc + r).astype(np.float32)              # sequential f32 mean
        mean = (acc / np.float32(len(ids))).astype(np.float32)
        nrm = np.float32(np.sqrt(np.float32((mean * mean).sum())))  # pairwise sumsq
        return (mean / (nrm + np.float32(1e-32))).astype(np.float32)
    cos = [float(np.dot(ours(t), truth[i]) / (np.linalg.norm(ours(t)) * np.linalg.norm(truth[i]) + 1e-9))
           for i, t in enumerate(probe)]
    log("parity cosine our-pipeline vs sm.encode:", [round(c, 6) for c in cos])
    if min(cos) < 0.9999:
        log("WARN: parity below 0.9999 — tokenization/reindex mismatch, investigate before shipping")

    # 5. write GGUF: bge token list + the reindexed matrix + metadata.
    w = gguf.GGUFWriter(args.outfile, "bert")
    w.add_uint32("tokenizer.ggml.unknown_token_id", 100)
    w.add_uint32("tokenizer.ggml.cls_token_id", 101)
    w.add_uint32("tokenizer.ggml.seperator_token_id", 102)
    w.add_uint32("tokenizer.ggml.padding_token_id", 0)
    w.add_token_list(bge_tokens)
    w.add_string("semantic.kind", "model2vec")
    w.add_string("model2vec.source", args.source)
    w.add_uint32("model2vec.dim", dim)
    w.add_uint32("model2vec.median_token_length", int(sm.median_token_length))
    w.add_tensor("m2v.embeddings", M)        # [vocab, dim] f32
    w.write_header_to_file()
    w.write_kv_data_to_file()
    w.write_tensors_to_file()
    w.close()
    log(f"wrote {args.outfile}  ({M.nbytes/1e6:.0f} MB matrix, {V}x{dim})")


if __name__ == "__main__":
    main()
