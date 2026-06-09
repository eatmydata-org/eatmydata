/*
** Minimal GGUF v3 reader. See gguf.h. Bounds-checked single pass.
*/
#include "gguf.h"

#include <stdlib.h>
#include <string.h>

/* ---- little-endian cursor with bounds checking ----
** All target ABIs (wasm32, arm64, x86_64) are little-endian, so a memcpy out of
** the buffer reproduces the wire value; we never byte-swap. */
typedef struct {
  const uint8_t *p;
  const uint8_t *end;
  int err; /* sticky: set on any short read */
} cur;

static uint8_t rd_u8(cur *c) {
  if (c->p + 1 > c->end) { c->err = 1; return 0; }
  return *c->p++;
}
static uint16_t rd_u16(cur *c) {
  uint16_t v = 0;
  if (c->p + 2 > c->end) { c->err = 1; return 0; }
  memcpy(&v, c->p, 2); c->p += 2; return v;
}
static uint32_t rd_u32(cur *c) {
  uint32_t v = 0;
  if (c->p + 4 > c->end) { c->err = 1; return 0; }
  memcpy(&v, c->p, 4); c->p += 4; return v;
}
static uint64_t rd_u64(cur *c) {
  uint64_t v = 0;
  if (c->p + 8 > c->end) { c->err = 1; return 0; }
  memcpy(&v, c->p, 8); c->p += 8; return v;
}

/* GGUF string: u64 length + raw bytes (no NUL). Returns a view; on a short
** read the view is empty and c->err is set. */
static gguf_str rd_str(cur *c) {
  gguf_str s = { NULL, 0 };
  uint64_t n = rd_u64(c);
  if (c->err) return s;
  if (n > (uint64_t)(c->end - c->p)) { c->err = 1; return s; }
  s.ptr = (const char *)c->p;
  s.len = n;
  c->p += n;
  return s;
}

/* Bytes per element for the scalar metadata types; 0 for STRING/ARRAY. */
static uint32_t kv_scalar_size(uint32_t t) {
  switch (t) {
    case GGUF_T_UINT8: case GGUF_T_INT8: case GGUF_T_BOOL:    return 1;
    case GGUF_T_UINT16: case GGUF_T_INT16:                    return 2;
    case GGUF_T_UINT32: case GGUF_T_INT32: case GGUF_T_FLOAT32: return 4;
    case GGUF_T_UINT64: case GGUF_T_INT64: case GGUF_T_FLOAT64: return 8;
    default: return 0;
  }
}

/* Read a scalar value into a 64-bit union slot, widening per type. */
static void rd_scalar(cur *c, uint32_t t, gguf_kv *kv) {
  switch (t) {
    case GGUF_T_UINT8:  kv->val.u = rd_u8(c); break;
    case GGUF_T_INT8:   kv->val.i = (int8_t)rd_u8(c); break;
    case GGUF_T_UINT16: kv->val.u = rd_u16(c); break;
    case GGUF_T_INT16:  kv->val.i = (int16_t)rd_u16(c); break;
    case GGUF_T_UINT32: kv->val.u = rd_u32(c); break;
    case GGUF_T_INT32:  kv->val.i = (int32_t)rd_u32(c); break;
    case GGUF_T_UINT64: kv->val.u = rd_u64(c); break;
    case GGUF_T_INT64:  kv->val.i = (int64_t)rd_u64(c); break;
    case GGUF_T_BOOL:   kv->val.u = rd_u8(c) ? 1 : 0; break;
    case GGUF_T_FLOAT32: { uint32_t b = rd_u32(c); float f; memcpy(&f, &b, 4); kv->val.f = f; break; }
    case GGUF_T_FLOAT64: { uint64_t b = rd_u64(c); double d; memcpy(&d, &b, 8); kv->val.f = d; break; }
    default: c->err = 1; break;
  }
}

/* Skip past `n` array elements of element-type `at`, leaving cursor after them.
** Strings are variable-length so they must be walked individually. */
static void skip_array_elems(cur *c, uint32_t at, uint64_t n) {
  if (at == GGUF_T_STRING) {
    for (uint64_t i = 0; i < n && !c->err; i++) (void)rd_str(c);
    return;
  }
  uint32_t sz = kv_scalar_size(at);
  if (sz == 0) { c->err = 1; return; } /* arrays-of-arrays unsupported */
  uint64_t bytes = n * sz;
  if (bytes > (uint64_t)(c->end - c->p)) { c->err = 1; return; }
  c->p += bytes;
}

static uint64_t align_up(uint64_t x, uint64_t a) {
  if (a == 0) return x;
  uint64_t r = x % a;
  return r ? x + (a - r) : x;
}

int gguf_str_eq(gguf_str s, const char *z) {
  uint64_t n = strlen(z);
  return s.len == n && memcmp(s.ptr, z, n) == 0;
}

int gguf_open(const uint8_t *buf, uint64_t len, gguf_ctx *ctx) {
  memset(ctx, 0, sizeof(*ctx));
  cur c = { buf, buf + len, 0 };

  uint8_t m0 = rd_u8(&c), m1 = rd_u8(&c), m2 = rd_u8(&c), m3 = rd_u8(&c);
  if (c.err || m0 != 'G' || m1 != 'G' || m2 != 'U' || m3 != 'F') return -1;
  uint32_t version = rd_u32(&c);
  if (version != 2 && version != 3) return -1; /* v1 used 32-bit counts */

  uint64_t n_tensors = rd_u64(&c);
  uint64_t n_kv = rd_u64(&c);
  if (c.err) return -1;
  /* Sanity: each entry needs several bytes, so counts can't exceed the file. */
  if (n_tensors > len || n_kv > len) return -1;

  ctx->base = buf;
  ctx->size = len;
  ctx->alignment = 32; /* GGUF default; overridden by general.alignment below */

  if (n_kv) {
    ctx->kv = (gguf_kv *)calloc(n_kv, sizeof(gguf_kv));
    if (!ctx->kv) return -1;
  }
  ctx->n_kv = n_kv;

  for (uint64_t i = 0; i < n_kv; i++) {
    gguf_kv *kv = &ctx->kv[i];
    kv->key = rd_str(&c);
    kv->type = rd_u32(&c);
    if (c.err) { gguf_free(ctx); return -1; }
    if (kv->type == GGUF_T_STRING) {
      kv->str = rd_str(&c);
    } else if (kv->type == GGUF_T_ARRAY) {
      kv->arr_type = rd_u32(&c);
      kv->arr_len = rd_u64(&c);
      if (c.err) { gguf_free(ctx); return -1; }
      kv->arr_data = c.p;
      skip_array_elems(&c, kv->arr_type, kv->arr_len);
    } else {
      rd_scalar(&c, kv->type, kv);
    }
    if (c.err) { gguf_free(ctx); return -1; }

    if (gguf_str_eq(kv->key, "general.alignment") &&
        (kv->type == GGUF_T_UINT32 || kv->type == GGUF_T_UINT64)) {
      if (kv->val.u) ctx->alignment = kv->val.u;
    }
  }

  if (n_tensors) {
    ctx->tensors = (gguf_tensor *)calloc(n_tensors, sizeof(gguf_tensor));
    if (!ctx->tensors) { gguf_free(ctx); return -1; }
  }
  ctx->n_tensors = n_tensors;

  for (uint64_t i = 0; i < n_tensors; i++) {
    gguf_tensor *t = &ctx->tensors[i];
    t->name = rd_str(&c);
    t->n_dims = rd_u32(&c);
    if (c.err || t->n_dims > 4) { gguf_free(ctx); return -1; }
    for (uint32_t d = 0; d < t->n_dims; d++) t->dims[d] = rd_u64(&c);
    t->type = rd_u32(&c);
    t->offset = rd_u64(&c);
    if (c.err) { gguf_free(ctx); return -1; }
  }

  /* Data section begins at the first alignment boundary past the directory. */
  uint64_t consumed = (uint64_t)(c.p - buf);
  uint64_t data_off = align_up(consumed, ctx->alignment);
  if (data_off > len) { gguf_free(ctx); return -1; }
  const uint8_t *data = buf + data_off;
  uint64_t data_cap = len - data_off;

  for (uint64_t i = 0; i < n_tensors; i++) {
    gguf_tensor *t = &ctx->tensors[i];
    if (t->offset > data_cap) { gguf_free(ctx); return -1; }
    t->data = data + t->offset;
    /* For the element types we decode (F32/F16/Q8_0) verify the span fits. */
    uint64_t n = 1;
    for (uint32_t d = 0; d < t->n_dims; d++) n *= t->dims[d];
    uint64_t nbytes = 0;
    if (t->type == GGML_T_F32) nbytes = n * 4;
    else if (t->type == GGML_T_F16) nbytes = n * 2;
    else if (t->type == GGML_T_Q8_0) {
      if (n % GGML_Q8_0_BLOCK != 0) { gguf_free(ctx); return -1; }
      nbytes = (n / GGML_Q8_0_BLOCK) * GGML_Q8_0_BYTES;
    }
    if (nbytes && nbytes > data_cap - t->offset) { gguf_free(ctx); return -1; }
  }
  return 0;
}

void gguf_free(gguf_ctx *ctx) {
  if (!ctx) return;
  free(ctx->kv);
  free(ctx->tensors);
  ctx->kv = NULL;
  ctx->tensors = NULL;
  ctx->n_kv = ctx->n_tensors = 0;
}

const gguf_kv *gguf_find(const gguf_ctx *ctx, const char *key) {
  for (uint64_t i = 0; i < ctx->n_kv; i++)
    if (gguf_str_eq(ctx->kv[i].key, key)) return &ctx->kv[i];
  return NULL;
}

int gguf_get_u32(const gguf_ctx *ctx, const char *key, uint32_t *out) {
  const gguf_kv *kv = gguf_find(ctx, key);
  if (!kv) return 0;
  switch (kv->type) {
    case GGUF_T_UINT8: case GGUF_T_UINT16: case GGUF_T_UINT32:
    case GGUF_T_UINT64: case GGUF_T_BOOL:
      *out = (uint32_t)kv->val.u; return 1;
    case GGUF_T_INT8: case GGUF_T_INT16: case GGUF_T_INT32: case GGUF_T_INT64:
      *out = (uint32_t)kv->val.i; return 1;
    default: return 0;
  }
}

int gguf_get_f32(const gguf_ctx *ctx, const char *key, float *out) {
  const gguf_kv *kv = gguf_find(ctx, key);
  if (!kv) return 0;
  if (kv->type == GGUF_T_FLOAT32 || kv->type == GGUF_T_FLOAT64) {
    *out = (float)kv->val.f; return 1;
  }
  return 0;
}

int gguf_get_str(const gguf_ctx *ctx, const char *key, gguf_str *out) {
  const gguf_kv *kv = gguf_find(ctx, key);
  if (!kv || kv->type != GGUF_T_STRING) return 0;
  *out = kv->str;
  return 1;
}

const gguf_tensor *gguf_tensor_find(const gguf_ctx *ctx, const char *name) {
  for (uint64_t i = 0; i < ctx->n_tensors; i++)
    if (gguf_str_eq(ctx->tensors[i].name, name)) return &ctx->tensors[i];
  return NULL;
}
