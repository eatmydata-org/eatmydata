/*
** Internal shared types for the semantic module (not part of the public ABI).
** Split across semantic.c (load/glue), tokenizer.c (WPM), model.c (forward pass).
**
** Geometry is RUNTIME (read from GGUF metadata into sem_model), not compile-time
** #defines — the one engine runs both the 12L/384 embedding model and the
** 4L/512 token-classification model. Only two compile-time bounds remain:
*/
#ifndef SEMANTIC_INTERNAL_H
#define SEMANTIC_INTERNAL_H

#include <stdint.h>

/* Upper bounds (sem_init rejects a GGUF exceeding them). SEM_MAX_HEAD_DIM sizes
** the attention-context SIMD accumulator array on the stack; 128 covers head_dim
** 32 (embed) and 64 (token-cls) with room to spare. SEM_MAX_CTX caps the token
** sequence (both shipped models use 512). */
#define SEM_MAX_HEAD_DIM 128
#define SEM_MAX_CTX      512

/* GELU variant. EMBED uses the tanh rational approximation (bit-matches the
** llama.cpp oracle); TOKEN_CLS uses exact erf (bit-matches the ONNX export). */
enum { SEM_GELU_TANH = 0, SEM_GELU_ERF = 1 };

/* A matmul weight, row-major [n_out][n_in] (the GGUF [in,out] ne-order is exactly
** this in memory), held as dense f32. Q8_0 GGUFs are dequantized to f32 at load
** (a download-size win, not a compute change): the matmul is f32 SIMD either way. */
typedef struct {
  int    n_in, n_out;
  float *f32; /* [n_out*n_in] */
} qmat;

/* Per-layer weights. Matmul weights are qmat (dense f32); biases and LayerNorm
** params are f32 too. y[j] = b[j] + Σ_i W[j*n_in+i]*x[i]. */
typedef struct {
  qmat   attn_q_w; float *attn_q_b;   /* [D][D],  [D] */
  qmat   attn_k_w; float *attn_k_b;   /* [D][D],  [D] */
  qmat   attn_v_w; float *attn_v_b;   /* [D][D],  [D] */
  qmat   attn_o_w; float *attn_o_b;   /* [D][D],  [D] */
  float *attn_norm_w, *attn_norm_b;   /* [D] post-attention LayerNorm */
  qmat   ffn_up_w; float *ffn_up_b;   /* [FFN][D], [FFN] */
  qmat   ffn_down_w; float *ffn_down_b; /* [D][FFN], [D] */
  float *ffn_norm_w, *ffn_norm_b;     /* [D] post-FFN LayerNorm */
} sem_layer;

typedef struct {
  /* runtime geometry (from GGUF metadata) */
  int    d_model;     /* hidden size                          */
  int    n_layers;    /* transformer blocks                   */
  int    n_heads;     /* attention heads                      */
  int    head_dim;    /* d_model / n_heads (<= SEM_MAX_HEAD_DIM) */
  int    d_ffn;       /* feed-forward width                   */
  int    n_ctx;       /* max tokens incl CLS/SEP (<= SEM_MAX_CTX) */
  int    vocab_size;
  int    num_labels;  /* classifier outputs (TOKEN_CLS), else 0 */
  int    kind;        /* SEM_KIND_* */
  int    gelu_kind;   /* SEM_GELU_* */
  float  ln_eps;

  float *tok_embd;    /* [vocab][D]   word embeddings           */
  float *tok_type;    /* [2][D]       segment embeddings        */
  float *pos_embd;    /* [n_ctx][D]   absolute position embeds  */
  float *emb_norm_w;  /* [D]          embeddings.LayerNorm      */
  float *emb_norm_b;  /* [D]                                    */
  sem_layer *layers;  /* [n_layers]                             */

  /* token-classification head (kind == SEM_KIND_TOKEN_CLS only) */
  qmat   cls_w;       /* [num_labels][D] */
  float *cls_b;       /* [num_labels]    */
} sem_model;

/* WordPiece vocabulary. Token strings are copied out of the GGUF into `arena`
** (the input buffer is not retained) and indexed by an open-addressing hash
** table keyed on the raw token bytes. The token strings are the GGUF's
** pre-transformed form: word-initial pieces carry a leading "▁" (U+2581),
** continuation pieces are bare (no "##"), so the matcher is a phantom-space
** greedy longest-match exactly as in llama.cpp's WPM tokenizer. */
typedef struct {
  char     *arena;       /* concatenated token bytes              */
  uint32_t *tok_off;     /* [n] byte offset of token i in arena   */
  uint32_t *tok_len;     /* [n] byte length of token i            */
  int       n;           /* token count (== vocab_size)           */
  int32_t  *buckets;     /* [cap] token id or -1; cap is 2^k      */
  int       cap;
  int       max_token_len; /* max token byte length (greedy cap)  */
  int       unk_id, cls_id, sep_id, pad_id;
} sem_vocab;

typedef struct {
  sem_model model;
  sem_vocab vocab;
  int       ready;
} sem_state;

/* tokenizer.c */
int  sem_vocab_lookup(const sem_vocab *v, const char *bytes, int len); /* id or -1 */
/* Tokenize `text` (len bytes; len<0 => strlen) into [CLS] … [SEP], truncated to
** n_ctx. Allocates *out_ids (caller frees). When out_starts/out_ends are non-NULL
** they are also allocated (caller frees) and filled with each id's [start,end)
** BYTE offset into `text` (start==-1 for [CLS]/[SEP], which span no input).
** Returns SEM_OK or <0. */
int  sem_tokenize(const sem_vocab *v, const char *text, int len, int n_ctx,
                  int32_t **out_ids, int32_t **out_starts, int32_t **out_ends,
                  int *out_n);

/* model.c */
/* EMBED: run the encoder on `ids`/`n`, CLS-pool, L2-normalize into out[d_model]. */
int  sem_forward_embed(const sem_model *m, const int32_t *ids, int n, float *out);
/* TOKEN_CLS: run the encoder + classifier on `ids`/`n`; per token write the
** argmax label id and its softmax probability (n entries, incl CLS/SEP). */
int  sem_forward_tokencls(const sem_model *m, const int32_t *ids, int n,
                          int32_t *out_label, float *out_score);

/* Debug-only (native test harness): the live vocab after a successful sem_init,
** so the CLI can dump token ids for the tokenizer-vs-llama.cpp check. NULL if
** not ready. Not part of the public ABI (semantic.h). */
const sem_vocab *sem_debug_vocab(void);

#endif /* SEMANTIC_INTERNAL_H */
