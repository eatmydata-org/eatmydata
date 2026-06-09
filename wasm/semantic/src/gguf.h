/*
** Minimal GGUF v3 reader — metadata KV + tensor directory only.
**
** Just enough of the format (https://github.com/ggml-org/ggml/blob/master/docs/gguf.md)
** to drive bge-small-en-v1.5 loading: scalar/string/array metadata lookups and
** a tensor directory (name, dims, type, resolved data pointer). No writing, no
** quantized-block decode — callers handle F32/F16 element reads themselves.
**
** Every read is bounds-checked against the input buffer; a malformed file fails
** with a negative rc rather than reading out of bounds (the buffer may be
** untrusted browser input).
*/
#ifndef BGE_GGUF_H
#define BGE_GGUF_H

#include <stddef.h>
#include <stdint.h>

/* GGUF metadata value types (wire enum). */
enum {
  GGUF_T_UINT8 = 0, GGUF_T_INT8 = 1, GGUF_T_UINT16 = 2, GGUF_T_INT16 = 3,
  GGUF_T_UINT32 = 4, GGUF_T_INT32 = 5, GGUF_T_FLOAT32 = 6, GGUF_T_BOOL = 7,
  GGUF_T_STRING = 8, GGUF_T_ARRAY = 9, GGUF_T_UINT64 = 10, GGUF_T_INT64 = 11,
  GGUF_T_FLOAT64 = 12
};

/* ggml tensor element types we care about (others -> rejected by the loader).
** Q8_0 blocks are 32 int8 weights + one f16 scale (34 bytes / 32 weights). */
enum { GGML_T_F32 = 0, GGML_T_F16 = 1, GGML_T_Q8_0 = 8 };
#define GGML_Q8_0_BLOCK 32
#define GGML_Q8_0_BYTES 34 /* 2 (f16 scale) + 32 (int8) */

/* A length-counted view into the buffer; NOT NUL-terminated. */
typedef struct {
  const char *ptr;
  uint64_t len;
} gguf_str;

typedef struct {
  gguf_str       key;
  uint32_t       type;        /* GGUF_T_* */
  /* scalar value (valid when type is a scalar type) */
  union { uint64_t u; int64_t i; double f; } val;
  gguf_str       str;         /* valid when type == GGUF_T_STRING */
  /* array payload (valid when type == GGUF_T_ARRAY) */
  uint32_t       arr_type;    /* element GGUF_T_* */
  uint64_t       arr_len;     /* element count */
  const uint8_t *arr_data;    /* first element, packed on the wire */
} gguf_kv;

typedef struct {
  gguf_str       name;
  uint32_t       n_dims;
  uint64_t       dims[4];
  uint32_t       type;        /* GGML_T_* */
  uint64_t       offset;      /* byte offset within the data section */
  const uint8_t *data;        /* resolved: base + data_section + offset */
} gguf_tensor;

typedef struct {
  const uint8_t *base;
  uint64_t       size;
  uint64_t       alignment;
  gguf_kv       *kv;
  uint64_t       n_kv;
  gguf_tensor   *tensors;
  uint64_t       n_tensors;
} gguf_ctx;

/* Parse `buf`/`len` into *ctx (heap-allocates kv/tensors). 0 on success, <0 on
** malformed input. On success the caller must gguf_free(ctx). The data pointers
** in kv/tensors alias `buf`, so `buf` must outlive read access to them. */
int  gguf_open(const uint8_t *buf, uint64_t len, gguf_ctx *ctx);
void gguf_free(gguf_ctx *ctx);

/* Metadata lookups by NUL-terminated key. Return NULL/0/false when absent or
** type-mismatched. Integer getter coerces any unsigned/signed scalar width. */
const gguf_kv *gguf_find(const gguf_ctx *ctx, const char *key);
int      gguf_get_u32(const gguf_ctx *ctx, const char *key, uint32_t *out);
int      gguf_get_f32(const gguf_ctx *ctx, const char *key, float *out);
/* String value -> view (not NUL-terminated). 1 on success, 0 otherwise. */
int      gguf_get_str(const gguf_ctx *ctx, const char *key, gguf_str *out);

/* Tensor directory lookup by exact (NUL-terminated) name. NULL if absent. */
const gguf_tensor *gguf_tensor_find(const gguf_ctx *ctx, const char *name);

/* Compare a gguf_str against a C string. 1 if equal. */
int gguf_str_eq(gguf_str s, const char *z);

#endif /* BGE_GGUF_H */
