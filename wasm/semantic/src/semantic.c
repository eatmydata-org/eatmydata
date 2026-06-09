/*
** semantic glue: parse the GGUF, validate it is a supported BERT encoder, read
** the geometry from metadata, up-convert every weight F16/F32/Q8_0 -> owned f32,
** build the WordPiece vocab, detect the head (classifier present => TOKEN_CLS,
** else EMBED), and orchestrate tokenize -> forward. Holds one global instance.
*/
#include "semantic.h"
#include "semantic-internal.h"
#include "gguf.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static sem_state g;

/* ---- F16 -> F32 (IEEE half, incl. subnormals / inf / nan) ---- */
static float f16_to_f32(uint16_t h) {
  uint32_t sign = (uint32_t)(h & 0x8000) << 16;
  uint32_t exp  = (h >> 10) & 0x1F;
  uint32_t mant = h & 0x3FF;
  uint32_t f;
  if (exp == 0) {
    if (mant == 0) {
      f = sign;
    } else {
      exp = 127 - 15 + 1;
      while ((mant & 0x400) == 0) { mant <<= 1; exp--; }
      mant &= 0x3FF;
      f = sign | (exp << 23) | (mant << 13);
    }
  } else if (exp == 0x1F) {
    f = sign | 0x7F800000u | (mant << 13);
  } else {
    f = sign | ((exp + (127 - 15)) << 23) | (mant << 13);
  }
  float out;
  memcpy(&out, &f, 4);
  return out;
}

/* Find a tensor, verify its element count, and return a freshly-allocated f32
** copy (converting from F16/Q8_0 when needed). NULL on any failure. */
static float *load_tensor(const gguf_ctx *ctx, const char *name, uint64_t expect) {
  const gguf_tensor *t = gguf_tensor_find(ctx, name);
  if (!t) return NULL;
  uint64_t n = 1;
  for (uint32_t d = 0; d < t->n_dims; d++) n *= t->dims[d];
  if (n != expect) return NULL;
  float *dst = (float *)malloc((size_t)n * sizeof(float));
  if (!dst) return NULL;
  if (t->type == GGML_T_F32) {
    memcpy(dst, t->data, (size_t)n * sizeof(float));
  } else if (t->type == GGML_T_F16) {
    for (uint64_t i = 0; i < n; i++) {
      uint16_t h;
      memcpy(&h, t->data + i * 2, 2); /* tolerate unaligned */
      dst[i] = f16_to_f32(h);
    }
  } else if (t->type == GGML_T_Q8_0) {
    /* Dequant to f32 at load: each 34-byte block = f16 scale `d` + 32 int8;
    ** weight = d * q. Keeps the kernels pure f32 — Q8_0 is a download-size win. */
    if (n % GGML_Q8_0_BLOCK != 0) { free(dst); return NULL; }
    uint64_t nblk = n / GGML_Q8_0_BLOCK;
    for (uint64_t b = 0; b < nblk; b++) {
      const uint8_t *blk = t->data + b * GGML_Q8_0_BYTES;
      uint16_t dh;
      memcpy(&dh, blk, 2);
      float d = f16_to_f32(dh);
      for (int i = 0; i < GGML_Q8_0_BLOCK; i++) {
        dst[b * GGML_Q8_0_BLOCK + i] = d * (float)(int8_t)blk[2 + i];
      }
    }
  } else {
    free(dst);
    return NULL;
  }
  return dst;
}

static void free_qmat(qmat *q) {
  free(q->f32);
  q->f32 = NULL;
}

/* Load a matmul weight as dense f32 (F16/F32/Q8_0 all handled by load_tensor). */
static int load_qmat(const gguf_ctx *ctx, const char *name, int n_in, int n_out, qmat *out) {
  memset(out, 0, sizeof(*out));
  out->n_in = n_in;
  out->n_out = n_out;
  out->f32 = load_tensor(ctx, name, (uint64_t)n_in * n_out);
  return out->f32 ? SEM_OK : SEM_ERR_TENSOR;
}

static void free_model(sem_model *m) {
  free(m->tok_embd); free(m->tok_type); free(m->pos_embd);
  free(m->emb_norm_w); free(m->emb_norm_b);
  if (m->layers) {
    for (int l = 0; l < m->n_layers; l++) {
      sem_layer *L = &m->layers[l];
      free_qmat(&L->attn_q_w); free(L->attn_q_b);
      free_qmat(&L->attn_k_w); free(L->attn_k_b);
      free_qmat(&L->attn_v_w); free(L->attn_v_b);
      free_qmat(&L->attn_o_w); free(L->attn_o_b);
      free(L->attn_norm_w); free(L->attn_norm_b);
      free_qmat(&L->ffn_up_w); free(L->ffn_up_b);
      free_qmat(&L->ffn_down_w); free(L->ffn_down_b);
      free(L->ffn_norm_w); free(L->ffn_norm_b);
    }
    free(m->layers);
  }
  free_qmat(&m->cls_w); free(m->cls_b);
  memset(m, 0, sizeof(*m));
}

static void free_vocab(sem_vocab *v) {
  free(v->arena); free(v->tok_off); free(v->tok_len); free(v->buckets);
  memset(v, 0, sizeof(*v));
}

/* Build the hashed WordPiece vocab from tokenizer.ggml.tokens. */
static int build_vocab(const gguf_ctx *ctx, sem_vocab *v, int vocab_size) {
  const gguf_kv *kv = gguf_find(ctx, "tokenizer.ggml.tokens");
  if (!kv || kv->type != GGUF_T_ARRAY || kv->arr_type != GGUF_T_STRING ||
      (int)kv->arr_len != vocab_size)
    return SEM_ERR_ARCH;

  memset(v, 0, sizeof(*v));
  v->n = vocab_size;
  v->tok_off = (uint32_t *)malloc((size_t)vocab_size * sizeof(uint32_t));
  v->tok_len = (uint32_t *)malloc((size_t)vocab_size * sizeof(uint32_t));
  if (!v->tok_off || !v->tok_len) { free_vocab(v); return SEM_ERR_OOM; }

  /* First pass: total bytes. The array payload was bounds-checked at gguf_open. */
  const uint8_t *p = kv->arr_data;
  uint64_t total = 0;
  for (int i = 0; i < vocab_size; i++) {
    uint64_t len; memcpy(&len, p, 8); p += 8 + len; total += len;
  }
  v->arena = (char *)malloc((size_t)total + 1);
  if (!v->arena) { free_vocab(v); return SEM_ERR_OOM; }

  /* Second pass: copy bytes, record offsets/lengths, track max length. */
  p = kv->arr_data;
  uint32_t off = 0;
  v->max_token_len = 0;
  for (int i = 0; i < vocab_size; i++) {
    uint64_t len; memcpy(&len, p, 8); p += 8;
    memcpy(v->arena + off, p, (size_t)len);
    v->tok_off[i] = off;
    v->tok_len[i] = (uint32_t)len;
    if ((int)len > v->max_token_len) v->max_token_len = (int)len;
    off += (uint32_t)len;
    p += len;
  }

  /* Hash table: power-of-two cap, load factor <= 0.5. */
  int cap = 1;
  while (cap < vocab_size * 2) cap <<= 1;
  v->cap = cap;
  v->buckets = (int32_t *)malloc((size_t)cap * sizeof(int32_t));
  if (!v->buckets) { free_vocab(v); return SEM_ERR_OOM; }
  for (int i = 0; i < cap; i++) v->buckets[i] = -1;
  uint32_t mask = (uint32_t)cap - 1;
  for (int id = 0; id < vocab_size; id++) {
    uint32_t hh = 2166136261u;
    const char *b = v->arena + v->tok_off[id];
    for (uint32_t j = 0; j < v->tok_len[id]; j++) { hh ^= (unsigned char)b[j]; hh *= 16777619u; }
    uint32_t slot = hh & mask;
    while (v->buckets[slot] >= 0) slot = (slot + 1) & mask;
    v->buckets[slot] = id;
  }

  /* Special token ids (fall back to the standard BERT ids if a key is absent). */
  uint32_t u;
  v->unk_id = gguf_get_u32(ctx, "tokenizer.ggml.unknown_token_id", &u) ? (int)u : 100;
  v->cls_id = gguf_get_u32(ctx, "tokenizer.ggml.cls_token_id", &u) ? (int)u : 101;
  v->sep_id = gguf_get_u32(ctx, "tokenizer.ggml.seperator_token_id", &u) ? (int)u : 102;
  v->pad_id = gguf_get_u32(ctx, "tokenizer.ggml.padding_token_id", &u) ? (int)u : 0;
  return SEM_OK;
}

/* Total element count of a tensor (or 0 if absent). */
static uint64_t tensor_numel(const gguf_ctx *ctx, const char *name) {
  const gguf_tensor *t = gguf_tensor_find(ctx, name);
  if (!t) return 0;
  uint64_t n = 1;
  for (uint32_t d = 0; d < t->n_dims; d++) n *= t->dims[d];
  return n;
}

int sem_init(const uint8_t *gguf, int len) {
  if (!gguf || len <= 0) return SEM_ERR_INPUT;
  if (g.ready) { free_model(&g.model); free_vocab(&g.vocab); g.ready = 0; }

  gguf_ctx ctx;
  if (gguf_open(gguf, (uint64_t)len, &ctx) != 0) return SEM_ERR_GGUF;

  int rc = SEM_OK;
  sem_model *m = &g.model;
  memset(m, 0, sizeof(*m));

  /* arch must be bert */
  gguf_str arch;
  if (!gguf_get_str(&ctx, "general.architecture", &arch) || !gguf_str_eq(arch, "bert")) {
    rc = SEM_ERR_ARCH; goto done;
  }

  /* ---- runtime geometry from metadata ---- */
  uint32_t u32;
  #define GET(key, dst) do { if (!gguf_get_u32(&ctx, key, &u32)) { rc = SEM_ERR_ARCH; goto done; } dst = (int)u32; } while (0)
  GET("bert.block_count", m->n_layers);
  GET("bert.embedding_length", m->d_model);
  GET("bert.feed_forward_length", m->d_ffn);
  GET("bert.attention.head_count", m->n_heads);
  #undef GET
  m->n_ctx = gguf_get_u32(&ctx, "bert.context_length", &u32) ? (int)u32 : SEM_MAX_CTX;
  if (m->n_ctx > SEM_MAX_CTX) m->n_ctx = SEM_MAX_CTX;
  if (!gguf_get_f32(&ctx, "bert.attention.layer_norm_epsilon", &m->ln_eps)) m->ln_eps = 1e-12f;

  /* validate geometry against the engine's bounds */
  if (m->n_layers < 1 || m->n_layers > 64 || m->d_model < 4 || m->d_model > 4096 ||
      m->n_heads < 1 || m->d_ffn < 4 || m->n_ctx < 2 ||
      (m->d_model % m->n_heads) != 0 || (m->d_model % 4) != 0 || (m->d_ffn % 4) != 0) {
    rc = SEM_ERR_ARCH; goto done;
  }
  m->head_dim = m->d_model / m->n_heads;
  if (m->head_dim > SEM_MAX_HEAD_DIM || (m->head_dim % 4) != 0) { rc = SEM_ERR_ARCH; goto done; }

  /* gelu mode: explicit "semantic.gelu"="erf" => exact erf, else tanh approx. */
  gguf_str gelu;
  m->gelu_kind = (gguf_get_str(&ctx, "semantic.gelu", &gelu) && gguf_str_eq(gelu, "erf"))
                     ? SEM_GELU_ERF : SEM_GELU_TANH;

  /* vocab size from the token array length */
  const gguf_kv *toks = gguf_find(&ctx, "tokenizer.ggml.tokens");
  if (!toks || toks->type != GGUF_T_ARRAY || toks->arr_type != GGUF_T_STRING) { rc = SEM_ERR_ARCH; goto done; }
  m->vocab_size = (int)toks->arr_len;

  const int D = m->d_model, F = m->d_ffn;

  /* ---- embeddings ---- */
  #define LOAD(field, name, count) do { \
      m->field = load_tensor(&ctx, name, (uint64_t)(count)); \
      if (!m->field) { rc = SEM_ERR_TENSOR; goto done; } \
    } while (0)
  LOAD(tok_embd,   "token_embd.weight",      (uint64_t)D * m->vocab_size);
  LOAD(tok_type,   "token_types.weight",     (uint64_t)D * 2);
  LOAD(pos_embd,   "position_embd.weight",   (uint64_t)D * m->n_ctx);
  LOAD(emb_norm_w, "token_embd_norm.weight", D);
  LOAD(emb_norm_b, "token_embd_norm.bias",   D);

  /* ---- layers ---- */
  m->layers = (sem_layer *)calloc((size_t)m->n_layers, sizeof(sem_layer));
  if (!m->layers) { rc = SEM_ERR_OOM; goto done; }
  char nm[64];
  #define LOADL(field, suffix, count) do { \
      snprintf(nm, sizeof(nm), "blk.%d.%s", l, suffix); \
      m->layers[l].field = load_tensor(&ctx, nm, (uint64_t)(count)); \
      if (!m->layers[l].field) { rc = SEM_ERR_TENSOR; goto done; } \
    } while (0)
  #define LOADQ(field, suffix, nin, nout) do { \
      snprintf(nm, sizeof(nm), "blk.%d.%s", l, suffix); \
      rc = load_qmat(&ctx, nm, (nin), (nout), &m->layers[l].field); \
      if (rc != SEM_OK) goto done; \
    } while (0)
  for (int l = 0; l < m->n_layers; l++) {
    LOADQ(attn_q_w, "attn_q.weight", D, D);
    LOADL(attn_q_b, "attn_q.bias",   D);
    LOADQ(attn_k_w, "attn_k.weight", D, D);
    LOADL(attn_k_b, "attn_k.bias",   D);
    LOADQ(attn_v_w, "attn_v.weight", D, D);
    LOADL(attn_v_b, "attn_v.bias",   D);
    LOADQ(attn_o_w, "attn_output.weight", D, D);
    LOADL(attn_o_b, "attn_output.bias",   D);
    LOADL(attn_norm_w, "attn_output_norm.weight", D);
    LOADL(attn_norm_b, "attn_output_norm.bias",   D);
    LOADQ(ffn_up_w, "ffn_up.weight",   D, F);
    LOADL(ffn_up_b, "ffn_up.bias",     F);
    LOADQ(ffn_down_w, "ffn_down.weight", F, D);
    LOADL(ffn_down_b, "ffn_down.bias",   D);
    LOADL(ffn_norm_w, "layer_output_norm.weight", D);
    LOADL(ffn_norm_b, "layer_output_norm.bias",   D);
  }
  #undef LOAD
  #undef LOADL
  #undef LOADQ

  /* ---- head: classifier present => TOKEN_CLS, else EMBED ---- */
  uint64_t cls_numel = tensor_numel(&ctx, "classifier.weight");
  if (cls_numel > 0) {
    if (cls_numel % (uint64_t)D != 0) { rc = SEM_ERR_TENSOR; goto done; }
    m->num_labels = (int)(cls_numel / (uint64_t)D);
    if (m->num_labels < 1 || m->num_labels > 4096) { rc = SEM_ERR_TENSOR; goto done; }
    rc = load_qmat(&ctx, "classifier.weight", D, m->num_labels, &m->cls_w);
    if (rc != SEM_OK) goto done;
    m->cls_b = load_tensor(&ctx, "classifier.bias", (uint64_t)m->num_labels);
    if (!m->cls_b) { rc = SEM_ERR_TENSOR; goto done; }
    m->kind = SEM_KIND_TOKEN_CLS;
  } else {
    m->kind = SEM_KIND_EMBED;
    m->num_labels = 0;
  }

  rc = build_vocab(&ctx, &g.vocab, m->vocab_size);
  if (rc != SEM_OK) goto done;

  g.ready = 1;

done:
  gguf_free(&ctx);
  if (rc != SEM_OK) { free_model(&g.model); free_vocab(&g.vocab); g.ready = 0; }
  return rc;
}

int sem_kind(void) { return g.ready ? g.model.kind : SEM_ERR_NOT_INIT; }
int sem_dim(void) { return g.ready ? g.model.d_model : 0; }
int sem_num_labels(void) { return g.ready ? g.model.num_labels : 0; }

int sem_embed(const char *text, int len, float *out) {
  if (!g.ready) return SEM_ERR_NOT_INIT;
  if (g.model.kind != SEM_KIND_EMBED) return SEM_ERR_KIND;
  if (!text || !out) return SEM_ERR_INPUT;
  int32_t *ids = NULL;
  int n = 0;
  int rc = sem_tokenize(&g.vocab, text, len, g.model.n_ctx, &ids, NULL, NULL, &n);
  if (rc != SEM_OK) return rc;
  if (n <= 0) { free(ids); return SEM_ERR_TOKENIZE; }
  rc = sem_forward_embed(&g.model, ids, n, out);
  free(ids);
  return rc;
}

int sem_ner_infer(const char *text, int len, int32_t *out, int max_tokens) {
  if (!g.ready) return SEM_ERR_NOT_INIT;
  if (g.model.kind != SEM_KIND_TOKEN_CLS) return SEM_ERR_KIND;
  if (!text || !out || max_tokens <= 0) return SEM_ERR_INPUT;

  int32_t *ids = NULL, *starts = NULL, *ends = NULL;
  int n = 0;
  int rc = sem_tokenize(&g.vocab, text, len, g.model.n_ctx, &ids, &starts, &ends, &n);
  if (rc != SEM_OK) return rc;
  if (n <= 0) { free(ids); free(starts); free(ends); return SEM_ERR_TOKENIZE; }

  int32_t *labels = (int32_t *)malloc((size_t)n * sizeof(int32_t));
  float *scores = (float *)malloc((size_t)n * sizeof(float));
  if (!labels || !scores) {
    free(labels); free(scores); free(ids); free(starts); free(ends);
    return SEM_ERR_OOM;
  }
  rc = sem_forward_tokencls(&g.model, ids, n, labels, scores);
  if (rc != SEM_OK) {
    free(labels); free(scores); free(ids); free(starts); free(ends);
    return rc;
  }

  /* pack content tokens (start>=0; [CLS]/[SEP] excluded) into the 4 blocks */
  int32_t *o_lab = out;
  int32_t *o_st  = out + max_tokens;
  int32_t *o_en  = out + 2 * max_tokens;
  float   *o_sc  = (float *)(out + 3 * max_tokens);
  int w = 0;
  for (int i = 0; i < n && w < max_tokens; i++) {
    if (starts[i] < 0) continue; /* [CLS]/[SEP] span no input */
    o_lab[w] = labels[i];
    o_st[w]  = starts[i];
    o_en[w]  = ends[i];
    o_sc[w]  = scores[i];
    w++;
  }

  free(labels); free(scores); free(ids); free(starts); free(ends);
  return w;
}

const sem_vocab *sem_debug_vocab(void) { return g.ready ? &g.vocab : NULL; }

const char *sem_strerror(int rc) {
  switch (rc) {
    case SEM_OK:           return "ok";
    case SEM_ERR_GGUF:     return "malformed GGUF";
    case SEM_ERR_ARCH:     return "unsupported architecture/geometry (not a supported bert)";
    case SEM_ERR_TENSOR:   return "missing or mis-shaped weight tensor";
    case SEM_ERR_OOM:      return "out of memory";
    case SEM_ERR_NOT_INIT: return "sem_init not called / failed";
    case SEM_ERR_INPUT:    return "invalid argument";
    case SEM_ERR_TOKENIZE: return "tokenization produced no tokens";
    case SEM_ERR_KIND:     return "wrong entry point for the loaded model kind";
    default:               return "unknown error";
  }
}
