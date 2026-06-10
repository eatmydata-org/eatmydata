/*
** BERT encoder forward pass — f32, SIMD128 (wasm) / scalar (native),
** single-threaded, RUNTIME geometry (dims come from sem_model, not #defines, so
** the one engine runs both the 12L/384 embedding model and the 4L/512 token-
** classification model). The matmul is batched (weights stream once per layer,
** reused across tokens) and the GEMM kernel is a 4-output-row × 4-token register-
** blocked microkernel (16 accumulators) built on fused multiply-add (relaxed_madd
** on wasm, fmaf natively).
**
** Post-LN BERT encoder:
**   embeddings = word[id] + token_type[0] + position[t], then LayerNorm
**   per layer:
**     attn = softmax(QKᵀ / √head_dim) · V ; x = LayerNorm(x + Wo·attn + bo)
**     ffn  = Wdown · gelu(Wup·x + bup) + bdown ; x = LayerNorm(x + ffn)
** Then a head:
**   EMBED      -> CLS pool (row 0) -> L2 normalize.
**   TOKEN_CLS  -> per-token classifier (D -> num_labels) -> softmax -> argmax.
**
** GELU has two modes: the tanh rational approximation (ggml_gelu; bit-matches the
** llama.cpp embedding oracle) for EMBED, and exact erf (bit-matches the ONNX
** export) for TOKEN_CLS. f32 accumulation throughout. Single sequence, no padding
** -> attention is full / unmasked.
*/
#include "semantic.h"
#include "semantic-internal.h"

#include <math.h>
#include <stdlib.h>

#ifdef __wasm_simd128__
#include <wasm_simd128.h>
#endif

static const float GELU_SQRT_2_OVER_PI = 0.79788456080286535587989211986876f;
static const float GELU_COEF_A = 0.044715f;
static const float SQRT_1_2 = 0.70710678118654752440f; /* 1/√2, for exact erf gelu */

/*
** tanh for the GELU tanh-approximation (the EMBED path). Minimax rational
** (odd degree-13 numerator / degree-6 denominator, |x| clamped to 9). Scalar
** (`fmaf`) and SIMD (`relaxed_madd`) forms share the SAME op order so wasm ==
** native bit-for-bit (the llama.cpp gate). Coefficients are the standard
** `generic_fast_tanh_float` minimax set (Eigen/cephes lineage).
*/
#define RTANH_A1 4.89352455891786e-03f
#define RTANH_A3 6.37261928875436e-04f
#define RTANH_A5 1.48572235717979e-05f
#define RTANH_A7 5.12229709037114e-08f
#define RTANH_A9 (-8.60467152213735e-11f)
#define RTANH_A11 2.00018790482477e-13f
#define RTANH_A13 (-2.76076847742355e-16f)
#define RTANH_B0 4.89352518554385e-03f
#define RTANH_B2 2.26843463243900e-03f
#define RTANH_B4 1.18534705686654e-04f
#define RTANH_B6 1.19825839466702e-06f

static inline float rtanhf(float x) {
  x = x > 9.0f ? 9.0f : (x < -9.0f ? -9.0f : x);
  float x2 = x * x;
  float p = RTANH_A13;
  p = fmaf(p, x2, RTANH_A11); p = fmaf(p, x2, RTANH_A9); p = fmaf(p, x2, RTANH_A7);
  p = fmaf(p, x2, RTANH_A5);  p = fmaf(p, x2, RTANH_A3);  p = fmaf(p, x2, RTANH_A1);
  p = p * x;
  float q = RTANH_B6;
  q = fmaf(q, x2, RTANH_B4); q = fmaf(q, x2, RTANH_B2); q = fmaf(q, x2, RTANH_B0);
  return p / q;
}

static inline float geluf_tanh(float x) {
  float arg = GELU_SQRT_2_OVER_PI * x * fmaf(GELU_COEF_A, x * x, 1.0f);
  return 0.5f * x * (1.0f + rtanhf(arg));
}

/* Exact erf GELU (the TOKEN_CLS path), matching HF "gelu" / the ONNX Erf op. */
static inline float geluf_erf(float x) {
  return 0.5f * x * (1.0f + erff(x * SQRT_1_2));
}

/*
** Single-precision exp for the attention softmax. Range-reduce x = m·ln2 + r
** (Cody–Waite two-step), evaluate a degree-5 minimax poly for exp(r), then scale
** by 2^m via the IEEE exponent field. Scalar (`fmaf`) and SIMD (`exp4`,
** `relaxed_madd`) forms share the SAME op order so wasm == native bit-for-bit.
** Coefficients are the standard cephes/Eigen single-precision `pexp` set (same
** published lineage as the tanh-GELU minimax above; provenance note in PERF.md).
** Softmax inputs are ≤ 0 (att-mx), but the full ±88 range is handled anyway.
*/
#define EXP_HI     88.3762626647950f
#define EXP_LO    (-88.3762626647949f)
#define EXP_LOG2EF 1.44269504088896341f
#define EXP_C1     0.693359375f
#define EXP_C2    (-2.12194440e-4f)
#define EXP_P0     1.9875691500e-4f
#define EXP_P1     1.3981999507e-3f
#define EXP_P2     8.3334519073e-3f
#define EXP_P3     4.1665795894e-2f
#define EXP_P4     1.6666665459e-1f
#define EXP_P5     5.0000001201e-1f

static inline float expf_approx(float x) {
  x = x > EXP_HI ? EXP_HI : (x < EXP_LO ? EXP_LO : x);
  float m = floorf(fmaf(x, EXP_LOG2EF, 0.5f));
  x = fmaf(m, -EXP_C1, x); /* x - m*C1 (high) */
  x = fmaf(m, -EXP_C2, x); /* x - m*C2 (low)  */
  float z = x * x;
  float y = EXP_P0;
  y = fmaf(y, x, EXP_P1); y = fmaf(y, x, EXP_P2); y = fmaf(y, x, EXP_P3);
  y = fmaf(y, x, EXP_P4); y = fmaf(y, x, EXP_P5);
  y = fmaf(y, z, x) + 1.0f; /* y*x^2 + x + 1 */
  union { int32_t i; float f; } pw;
  pw.i = ((int32_t)m + 127) << 23; /* 2^m via exponent field */
  return y * pw.f;
}

#ifdef __wasm_simd128__
static inline v128_t rtanh4(v128_t x) {
  x = wasm_f32x4_max(wasm_f32x4_const_splat(-9.0f), wasm_f32x4_min(wasm_f32x4_const_splat(9.0f), x));
  v128_t x2 = wasm_f32x4_mul(x, x);
  v128_t p = wasm_f32x4_const_splat(RTANH_A13);
  p = wasm_f32x4_relaxed_madd(p, x2, wasm_f32x4_const_splat(RTANH_A11));
  p = wasm_f32x4_relaxed_madd(p, x2, wasm_f32x4_const_splat(RTANH_A9));
  p = wasm_f32x4_relaxed_madd(p, x2, wasm_f32x4_const_splat(RTANH_A7));
  p = wasm_f32x4_relaxed_madd(p, x2, wasm_f32x4_const_splat(RTANH_A5));
  p = wasm_f32x4_relaxed_madd(p, x2, wasm_f32x4_const_splat(RTANH_A3));
  p = wasm_f32x4_relaxed_madd(p, x2, wasm_f32x4_const_splat(RTANH_A1));
  p = wasm_f32x4_mul(p, x);
  v128_t q = wasm_f32x4_const_splat(RTANH_B6);
  q = wasm_f32x4_relaxed_madd(q, x2, wasm_f32x4_const_splat(RTANH_B4));
  q = wasm_f32x4_relaxed_madd(q, x2, wasm_f32x4_const_splat(RTANH_B2));
  q = wasm_f32x4_relaxed_madd(q, x2, wasm_f32x4_const_splat(RTANH_B0));
  return wasm_f32x4_div(p, q);
}
/* tanh-GELU on four f32 at once — bit-identical, lane-for-lane, to geluf_tanh(). */
static inline v128_t gelu4(v128_t x) {
  v128_t x2 = wasm_f32x4_mul(x, x);
  v128_t arg = wasm_f32x4_mul(wasm_f32x4_mul(wasm_f32x4_const_splat(GELU_SQRT_2_OVER_PI), x),
                              wasm_f32x4_relaxed_madd(wasm_f32x4_const_splat(GELU_COEF_A), x2,
                                                      wasm_f32x4_const_splat(1.0f)));
  return wasm_f32x4_mul(wasm_f32x4_mul(wasm_f32x4_const_splat(0.5f), x),
                        wasm_f32x4_add(wasm_f32x4_const_splat(1.0f), rtanh4(arg)));
}
/* exp on four f32 at once — bit-identical, lane-for-lane, to expf_approx(). */
static inline v128_t exp4(v128_t x) {
  x = wasm_f32x4_max(wasm_f32x4_const_splat(EXP_LO),
                     wasm_f32x4_min(wasm_f32x4_const_splat(EXP_HI), x));
  v128_t m = wasm_f32x4_floor(
      wasm_f32x4_relaxed_madd(x, wasm_f32x4_const_splat(EXP_LOG2EF), wasm_f32x4_const_splat(0.5f)));
  x = wasm_f32x4_relaxed_madd(m, wasm_f32x4_const_splat(-EXP_C1), x);
  x = wasm_f32x4_relaxed_madd(m, wasm_f32x4_const_splat(-EXP_C2), x);
  v128_t z = wasm_f32x4_mul(x, x);
  v128_t y = wasm_f32x4_const_splat(EXP_P0);
  y = wasm_f32x4_relaxed_madd(y, x, wasm_f32x4_const_splat(EXP_P1));
  y = wasm_f32x4_relaxed_madd(y, x, wasm_f32x4_const_splat(EXP_P2));
  y = wasm_f32x4_relaxed_madd(y, x, wasm_f32x4_const_splat(EXP_P3));
  y = wasm_f32x4_relaxed_madd(y, x, wasm_f32x4_const_splat(EXP_P4));
  y = wasm_f32x4_relaxed_madd(y, x, wasm_f32x4_const_splat(EXP_P5));
  y = wasm_f32x4_add(wasm_f32x4_relaxed_madd(y, z, x), wasm_f32x4_const_splat(1.0f));
  /* 2^m via the IEEE exponent field: ((int)m + 127) << 23, reinterpreted f32. */
  v128_t n = wasm_i32x4_add(wasm_i32x4_trunc_sat_f32x4(m), wasm_i32x4_splat(127));
  return wasm_f32x4_mul(y, wasm_i32x4_shl(n, 23));
}
#endif

/*
** Scalar reference dot with 4 lane-accumulators + fmaf. Mirrors one SIMD v128
** accumulator's lane layout / horizontal-sum order, so the native build computes
** each output bit-for-bit like the wasm microkernel below. Also the portable
** fallback for non-SIMD dotf.
*/
static inline float dot4_fma(const float *x, const float *w, int n) {
  float c0 = 0.0f, c1 = 0.0f, c2 = 0.0f, c3 = 0.0f;
  int k = 0;
  for (; k + 4 <= n; k += 4) {
    c0 = fmaf(x[k + 0], w[k + 0], c0);
    c1 = fmaf(x[k + 1], w[k + 1], c1);
    c2 = fmaf(x[k + 2], w[k + 2], c2);
    c3 = fmaf(x[k + 3], w[k + 3], c3);
  }
  float s = ((c0 + c1) + c2) + c3;
  for (; k < n; k++) s = fmaf(x[k], w[k], s);
  return s;
}

#ifdef __wasm_simd128__
/* Horizontal sum of a v128, left-to-right — matches dot4_fma's ((c0+c1)+c2)+c3. */
static inline float hsum4(v128_t v) {
  float l0 = wasm_f32x4_extract_lane(v, 0);
  float l1 = wasm_f32x4_extract_lane(v, 1);
  float l2 = wasm_f32x4_extract_lane(v, 2);
  float l3 = wasm_f32x4_extract_lane(v, 3);
  return ((l0 + l1) + l2) + l3;
}
#endif

/*
** f32 dot product, used by the attention scores (q·k over head_dim) and the
** n_out%4 GEMM remainder. SIMD: one v128 accumulator with relaxed_madd; scalar:
** dot4_fma — bit-identical layout.
*/
static inline float dotf(const float *a, const float *b, int n) {
#ifdef __wasm_simd128__
  v128_t acc = wasm_f32x4_const_splat(0.0f);
  int i = 0;
  for (; i + 4 <= n; i += 4)
    acc = wasm_f32x4_relaxed_madd(wasm_v128_load(a + i), wasm_v128_load(b + i), acc);
  float s = hsum4(acc);
  for (; i < n; i++) s = fmaf(a[i], b[i], s);
  return s;
#else
  return dot4_fma(a, b, n);
#endif
}

/*
** Batched f32 linear: Y[T][n_out] = X[T][n_in] · Wᵀ + b, W row-major [n_out][n_in].
** b may be NULL. Batched/output-major (each weight row streams once, reused over
** tokens) + a 4-output-row × 4-token register-blocked tile (16 live accumulators).
** Each Y[t][j] accumulates in the SAME lane order as dot4_fma, so the native build
** reproduces the wasm result bit-for-bit. Dimension-agnostic — the runtime dims
** flow straight through.
*/
#ifdef __wasm_simd128__
static void linear_batch_f32(float *Y, const float *X, const float *W, const float *b,
                             int n_in, int n_out, int T) {
  const v128_t Z = wasm_f32x4_const_splat(0.0f);
  int j = 0;
  for (; j + 4 <= n_out; j += 4) {
    const float *w0 = W + (size_t)(j + 0) * n_in;
    const float *w1 = W + (size_t)(j + 1) * n_in;
    const float *w2 = W + (size_t)(j + 2) * n_in;
    const float *w3 = W + (size_t)(j + 3) * n_in;
    const float b0 = b ? b[j + 0] : 0.0f;
    const float b1 = b ? b[j + 1] : 0.0f;
    const float b2 = b ? b[j + 2] : 0.0f;
    const float b3 = b ? b[j + 3] : 0.0f;
    int t = 0;
    for (; t + 4 <= T; t += 4) {
      const float *x0 = X + (size_t)(t + 0) * n_in;
      const float *x1 = X + (size_t)(t + 1) * n_in;
      const float *x2 = X + (size_t)(t + 2) * n_in;
      const float *x3 = X + (size_t)(t + 3) * n_in;
      v128_t r00 = Z, r01 = Z, r02 = Z, r03 = Z;
      v128_t r10 = Z, r11 = Z, r12 = Z, r13 = Z;
      v128_t r20 = Z, r21 = Z, r22 = Z, r23 = Z;
      v128_t r30 = Z, r31 = Z, r32 = Z, r33 = Z;
      int k = 0;
      for (; k + 4 <= n_in; k += 4) {
        v128_t xv0 = wasm_v128_load(x0 + k);
        v128_t xv1 = wasm_v128_load(x1 + k);
        v128_t xv2 = wasm_v128_load(x2 + k);
        v128_t xv3 = wasm_v128_load(x3 + k);
        v128_t wv0 = wasm_v128_load(w0 + k);
        v128_t wv1 = wasm_v128_load(w1 + k);
        v128_t wv2 = wasm_v128_load(w2 + k);
        v128_t wv3 = wasm_v128_load(w3 + k);
        r00 = wasm_f32x4_relaxed_madd(xv0, wv0, r00); r01 = wasm_f32x4_relaxed_madd(xv0, wv1, r01);
        r02 = wasm_f32x4_relaxed_madd(xv0, wv2, r02); r03 = wasm_f32x4_relaxed_madd(xv0, wv3, r03);
        r10 = wasm_f32x4_relaxed_madd(xv1, wv0, r10); r11 = wasm_f32x4_relaxed_madd(xv1, wv1, r11);
        r12 = wasm_f32x4_relaxed_madd(xv1, wv2, r12); r13 = wasm_f32x4_relaxed_madd(xv1, wv3, r13);
        r20 = wasm_f32x4_relaxed_madd(xv2, wv0, r20); r21 = wasm_f32x4_relaxed_madd(xv2, wv1, r21);
        r22 = wasm_f32x4_relaxed_madd(xv2, wv2, r22); r23 = wasm_f32x4_relaxed_madd(xv2, wv3, r23);
        r30 = wasm_f32x4_relaxed_madd(xv3, wv0, r30); r31 = wasm_f32x4_relaxed_madd(xv3, wv1, r31);
        r32 = wasm_f32x4_relaxed_madd(xv3, wv2, r32); r33 = wasm_f32x4_relaxed_madd(xv3, wv3, r33);
      }
      float y00 = hsum4(r00), y01 = hsum4(r01), y02 = hsum4(r02), y03 = hsum4(r03);
      float y10 = hsum4(r10), y11 = hsum4(r11), y12 = hsum4(r12), y13 = hsum4(r13);
      float y20 = hsum4(r20), y21 = hsum4(r21), y22 = hsum4(r22), y23 = hsum4(r23);
      float y30 = hsum4(r30), y31 = hsum4(r31), y32 = hsum4(r32), y33 = hsum4(r33);
      for (; k < n_in; k++) { /* n_in%4 tail */
        float xa = x0[k], xb = x1[k], xc = x2[k], xd = x3[k];
        float k0 = w0[k], k1 = w1[k], k2 = w2[k], k3 = w3[k];
        y00 = fmaf(xa, k0, y00); y01 = fmaf(xa, k1, y01); y02 = fmaf(xa, k2, y02); y03 = fmaf(xa, k3, y03);
        y10 = fmaf(xb, k0, y10); y11 = fmaf(xb, k1, y11); y12 = fmaf(xb, k2, y12); y13 = fmaf(xb, k3, y13);
        y20 = fmaf(xc, k0, y20); y21 = fmaf(xc, k1, y21); y22 = fmaf(xc, k2, y22); y23 = fmaf(xc, k3, y23);
        y30 = fmaf(xd, k0, y30); y31 = fmaf(xd, k1, y31); y32 = fmaf(xd, k2, y32); y33 = fmaf(xd, k3, y33);
      }
      float *Y0 = Y + (size_t)(t + 0) * n_out + j;
      float *Y1 = Y + (size_t)(t + 1) * n_out + j;
      float *Y2 = Y + (size_t)(t + 2) * n_out + j;
      float *Y3 = Y + (size_t)(t + 3) * n_out + j;
      Y0[0] = b0 + y00; Y0[1] = b1 + y01; Y0[2] = b2 + y02; Y0[3] = b3 + y03;
      Y1[0] = b0 + y10; Y1[1] = b1 + y11; Y1[2] = b2 + y12; Y1[3] = b3 + y13;
      Y2[0] = b0 + y20; Y2[1] = b1 + y21; Y2[2] = b2 + y22; Y2[3] = b3 + y23;
      Y3[0] = b0 + y30; Y3[1] = b1 + y31; Y3[2] = b2 + y32; Y3[3] = b3 + y33;
    }
    for (; t < T; t++) { /* T%4 tail */
      const float *xt = X + (size_t)t * n_in;
      float *Yt = Y + (size_t)t * n_out + j;
      Yt[0] = b0 + dotf(w0, xt, n_in);
      Yt[1] = b1 + dotf(w1, xt, n_in);
      Yt[2] = b2 + dotf(w2, xt, n_in);
      Yt[3] = b3 + dotf(w3, xt, n_in);
    }
  }
  for (; j < n_out; j++) { /* n_out%4 remainder */
    const float *wrow = W + (size_t)j * n_in;
    const float bias = b ? b[j] : 0.0f;
    for (int t = 0; t < T; t++)
      Y[(size_t)t * n_out + j] = bias + dotf(wrow, X + (size_t)t * n_in, n_in);
  }
}
#else
static void linear_batch_f32(float *Y, const float *X, const float *W, const float *b,
                             int n_in, int n_out, int T) {
  for (int j = 0; j < n_out; j++) {
    const float *wrow = W + (size_t)j * n_in;
    const float bias = b ? b[j] : 0.0f;
    for (int t = 0; t < T; t++)
      Y[(size_t)t * n_out + j] = bias + dot4_fma(wrow, X + (size_t)t * n_in, n_in);
  }
}
#endif

static void mm(float *Y, const float *X, const qmat *W, const float *b, int T) {
  linear_batch_f32(Y, X, W->f32, b, W->n_in, W->n_out, T);
}

/* In-place LayerNorm over a length-n vector: (x-μ)/√(σ²+eps) * w + b, biased σ². */
static void layernorm(float *x, const float *w, const float *b, int n, float eps) {
  double mean = 0.0;
  for (int i = 0; i < n; i++) mean += x[i];
  mean /= n;
  double var = 0.0;
  for (int i = 0; i < n; i++) { double d = x[i] - mean; var += d * d; }
  var /= n;
  float inv = (float)(1.0 / sqrt(var + (double)eps));
  for (int i = 0; i < n; i++) x[i] = ((float)(x[i] - mean)) * inv * w[i] + b[i];
}

/*
** Run embeddings + every encoder layer over `ids`/`T`. Returns the final hidden
** states X[T][D] in *out_x (caller frees). SEM_OK or <0.
*/
static int encode(const sem_model *m, const int32_t *ids, int T, float **out_x) {
  if (T <= 0) return SEM_ERR_INPUT;
  const int D = m->d_model, H = m->n_heads, dh = m->head_dim, F = m->d_ffn;
  const float scale = 1.0f / sqrtf((float)dh);

  size_t td = (size_t)T * D;
  float *x    = (float *)malloc(td * sizeof(float));
  float *q    = (float *)malloc(td * sizeof(float));
  float *k    = (float *)malloc(td * sizeof(float));
  float *v    = (float *)malloc(td * sizeof(float));
  float *ctx  = (float *)malloc(td * sizeof(float));
  float *proj = (float *)malloc(td * sizeof(float));            /* attn_o / ffn_down out */
  float *ff   = (float *)malloc((size_t)T * F * sizeof(float)); /* ffn_up out (batched) */
  float *att  = (float *)malloc((size_t)T * sizeof(float));     /* per-query softmax scratch */
  if (!x || !q || !k || !v || !ctx || !proj || !ff || !att) {
    free(x); free(q); free(k); free(v); free(ctx); free(proj); free(ff); free(att);
    return SEM_ERR_OOM;
  }

  /* embeddings: word + token_type[0] + position, then LayerNorm */
  for (int t = 0; t < T; t++) {
    const float *we = m->tok_embd + (size_t)ids[t] * D;
    const float *pe = m->pos_embd + (size_t)t * D;
    float *xt = x + (size_t)t * D;
    for (int c = 0; c < D; c++) xt[c] = we[c] + m->tok_type[c] + pe[c];
    layernorm(xt, m->emb_norm_w, m->emb_norm_b, D, m->ln_eps);
  }

  for (int l = 0; l < m->n_layers; l++) {
    const sem_layer *L = &m->layers[l];

    /* Q/K/V — one batched matmul each (weights stream once, reused over tokens). */
    mm(q, x, &L->attn_q_w, L->attn_q_b, T);
    mm(k, x, &L->attn_k_w, L->attn_k_b, T);
    mm(v, x, &L->attn_v_w, L->attn_v_b, T);

    /* self-attention per head */
    for (int h = 0; h < H; h++) {
      int off = h * dh;
      for (int t = 0; t < T; t++) {
        const float *qt = q + (size_t)t * D + off;
        /* attention scores att[u] = scale·(q_t·k_u over head_dim). Done one-at-a-
        ** time the dot is a single-accumulator dotf — FMA-latency-bound (no ILP),
        ** and at O(T²) it dominates long-doc attention. Key-block ×8: 8 independent
        ** v128 accumulators feed the FMA pipeline (8-way ILP) with q_t reused across
        ** the block. Each att[u] hsums in dotf's exact lane order, so the value is
        ** bit-identical to the per-u dotf — and to the native scalar path below. */
#ifdef __wasm_simd128__
        {
          const v128_t Z = wasm_f32x4_const_splat(0.0f);
          int u = 0;
          for (; u + 8 <= T; u += 8) {
            const float *k0 = k + (size_t)(u + 0) * D + off, *k1 = k + (size_t)(u + 1) * D + off;
            const float *k2 = k + (size_t)(u + 2) * D + off, *k3 = k + (size_t)(u + 3) * D + off;
            const float *k4 = k + (size_t)(u + 4) * D + off, *k5 = k + (size_t)(u + 5) * D + off;
            const float *k6 = k + (size_t)(u + 6) * D + off, *k7 = k + (size_t)(u + 7) * D + off;
            v128_t a0 = Z, a1 = Z, a2 = Z, a3 = Z, a4 = Z, a5 = Z, a6 = Z, a7 = Z;
            for (int c = 0; c < dh; c += 4) {
              v128_t qv = wasm_v128_load(qt + c);
              a0 = wasm_f32x4_relaxed_madd(qv, wasm_v128_load(k0 + c), a0);
              a1 = wasm_f32x4_relaxed_madd(qv, wasm_v128_load(k1 + c), a1);
              a2 = wasm_f32x4_relaxed_madd(qv, wasm_v128_load(k2 + c), a2);
              a3 = wasm_f32x4_relaxed_madd(qv, wasm_v128_load(k3 + c), a3);
              a4 = wasm_f32x4_relaxed_madd(qv, wasm_v128_load(k4 + c), a4);
              a5 = wasm_f32x4_relaxed_madd(qv, wasm_v128_load(k5 + c), a5);
              a6 = wasm_f32x4_relaxed_madd(qv, wasm_v128_load(k6 + c), a6);
              a7 = wasm_f32x4_relaxed_madd(qv, wasm_v128_load(k7 + c), a7);
            }
            att[u + 0] = hsum4(a0) * scale; att[u + 1] = hsum4(a1) * scale;
            att[u + 2] = hsum4(a2) * scale; att[u + 3] = hsum4(a3) * scale;
            att[u + 4] = hsum4(a4) * scale; att[u + 5] = hsum4(a5) * scale;
            att[u + 6] = hsum4(a6) * scale; att[u + 7] = hsum4(a7) * scale;
          }
          for (; u < T; u++) att[u] = dotf(qt, k + (size_t)u * D + off, dh) * scale;
        }
#else
        for (int u = 0; u < T; u++)
          att[u] = dotf(qt, k + (size_t)u * D + off, dh) * scale;
#endif
        /* max over the scores (numerically-stable softmax shift) */
        float mx = -INFINITY;
        for (int u = 0; u < T; u++) if (att[u] > mx) mx = att[u];
        /* softmax: att[u] = exp(att[u]-mx) (vectorized 4-wide on wasm; the scalar
        ** tail + native path use the lane-identical expf_approx), then a
        ** scalar-sequential normalization sum — same add order both builds, so
        ** wasm == native bit-for-bit (the embedding gate). */
        int u = 0;
#ifdef __wasm_simd128__
        v128_t vmx = wasm_f32x4_splat(mx);
        for (; u + 4 <= T; u += 4)
          wasm_v128_store(att + u, exp4(wasm_f32x4_sub(wasm_v128_load(att + u), vmx)));
#endif
        for (; u < T; u++) att[u] = expf_approx(att[u] - mx);
        float sum = 0.0f;
        for (u = 0; u < T; u++) sum += att[u];
        float inv = 1.0f / sum;
        float *ct = ctx + (size_t)t * D + off;
        /* context = (Σ_u att[u]·v_u) · inv, accumulated per output channel over u
        ** in ascending order — identical order in SIMD and scalar, so wasm ==
        ** native bit-for-bit (the embedding gate). Generalized over head_dim/4
        ** chunks (was a head_dim==32 hardcoded 8-accumulator unroll). */
#ifdef __wasm_simd128__
        {
          const int nq = dh >> 2; /* head_dim/4 chunks */
          v128_t acc[SEM_MAX_HEAD_DIM / 4];
          for (int z = 0; z < nq; z++) acc[z] = wasm_f32x4_const_splat(0.0f);
          for (int u = 0; u < T; u++) {
            v128_t a = wasm_f32x4_splat(att[u]);
            const float *vu = v + (size_t)u * D + off;
            for (int z = 0; z < nq; z++)
              acc[z] = wasm_f32x4_relaxed_madd(a, wasm_v128_load(vu + z * 4), acc[z]);
          }
          v128_t vinv = wasm_f32x4_splat(inv);
          for (int z = 0; z < nq; z++) wasm_v128_store(ct + z * 4, wasm_f32x4_mul(acc[z], vinv));
        }
#else
        for (int c = 0; c < dh; c++) {
          float acc = 0.0f;
          for (int u = 0; u < T; u++) acc = fmaf(att[u], v[(size_t)u * D + off + c], acc);
          ct[c] = acc * inv;
        }
#endif
      }
    }

    /* output projection + residual + post-attention LayerNorm */
    mm(proj, ctx, &L->attn_o_w, L->attn_o_b, T);
    for (int t = 0; t < T; t++) {
      float *xt = x + (size_t)t * D;
      const float *pt = proj + (size_t)t * D;
      for (int c = 0; c < D; c++) xt[c] += pt[c];
      layernorm(xt, L->attn_norm_w, L->attn_norm_b, D, m->ln_eps);
    }

    /* feed-forward (up → GELU → down) + residual + post-FFN LayerNorm */
    mm(ff, x, &L->ffn_up_w, L->ffn_up_b, T);
    {
      size_t nff = (size_t)T * F, i = 0;
      if (m->gelu_kind == SEM_GELU_ERF) {
        for (; i < nff; i++) ff[i] = geluf_erf(ff[i]); /* exact erf (ONNX parity) */
      } else {
#ifdef __wasm_simd128__
        for (; i + 4 <= nff; i += 4) wasm_v128_store(ff + i, gelu4(wasm_v128_load(ff + i)));
#endif
        for (; i < nff; i++) ff[i] = geluf_tanh(ff[i]); /* tanh approx (llama gate) */
      }
    }
    mm(proj, ff, &L->ffn_down_w, L->ffn_down_b, T);
    for (int t = 0; t < T; t++) {
      float *xt = x + (size_t)t * D;
      const float *pt = proj + (size_t)t * D;
      for (int c = 0; c < D; c++) xt[c] += pt[c];
      layernorm(xt, L->ffn_norm_w, L->ffn_norm_b, D, m->ln_eps);
    }
  }

  free(q); free(k); free(v); free(ctx); free(proj); free(ff); free(att);
  *out_x = x;
  return SEM_OK;
}

int sem_forward_embed(const sem_model *m, const int32_t *ids, int T, float *out) {
  float *x = NULL;
  int rc = encode(m, ids, T, &x);
  if (rc != SEM_OK) return rc;
  const int D = m->d_model;
  /* CLS pooling (row 0) + L2 normalize */
  float *cls = x; /* row 0 */
  double nrm = 0.0;
  for (int c = 0; c < D; c++) nrm += (double)cls[c] * cls[c];
  float inv = nrm > 0.0 ? (float)(1.0 / sqrt(nrm)) : 0.0f;
  for (int c = 0; c < D; c++) out[c] = cls[c] * inv;
  free(x);
  return SEM_OK;
}

int sem_forward_tokencls(const sem_model *m, const int32_t *ids, int T,
                         int32_t *out_label, float *out_score) {
  float *x = NULL;
  int rc = encode(m, ids, T, &x);
  if (rc != SEM_OK) return rc;
  const int NL = m->num_labels;

  /* logits[T][NL] = X · classifier.Wᵀ + classifier.b, then per-token softmax. */
  float *logits = (float *)malloc((size_t)T * NL * sizeof(float));
  if (!logits) { free(x); return SEM_ERR_OOM; }
  mm(logits, x, &m->cls_w, m->cls_b, T);

  for (int t = 0; t < T; t++) {
    const float *lt = logits + (size_t)t * NL;
    int best = 0;
    float mx = lt[0];
    for (int c = 1; c < NL; c++) if (lt[c] > mx) { mx = lt[c]; best = c; }
    /* softmax probability of the argmax class (numerically stable). */
    double sum = 0.0;
    for (int c = 0; c < NL; c++) sum += exp((double)(lt[c] - mx));
    out_label[t] = best;
    out_score[t] = (float)(1.0 / sum); /* exp(mx-mx)=1 over Σ */
  }

  free(logits);
  free(x);
  return SEM_OK;
}

/*
** numpy's pairwise summation of x[i]*x[i] (i=0..n-1), reproducing np.sum order so
** the Model2Vec norm bit-matches np.linalg.norm. Base case ≤128 uses 8 lane
** accumulators (numpy's NPY_PW_BLOCKSIZE=128 unrolled-by-8 block); above that it
** splits in half rounded down to a multiple of 8 and recurses. Scalar (no SIMD) so
** wasm == native bit-for-bit. Each square is rounded to f32 exactly like (x*x).
*/
static float pw_sumsq(const float *x, int n) {
  if (n < 8) {
    float s = 0.0f;
    for (int i = 0; i < n; i++) s += x[i] * x[i];
    return s;
  }
  if (n <= 128) {
    float r0 = x[0] * x[0], r1 = x[1] * x[1], r2 = x[2] * x[2], r3 = x[3] * x[3];
    float r4 = x[4] * x[4], r5 = x[5] * x[5], r6 = x[6] * x[6], r7 = x[7] * x[7];
    int i = 8;
    for (; i + 8 <= n; i += 8) {
      r0 += x[i + 0] * x[i + 0]; r1 += x[i + 1] * x[i + 1];
      r2 += x[i + 2] * x[i + 2]; r3 += x[i + 3] * x[i + 3];
      r4 += x[i + 4] * x[i + 4]; r5 += x[i + 5] * x[i + 5];
      r6 += x[i + 6] * x[i + 6]; r7 += x[i + 7] * x[i + 7];
    }
    float s = ((r0 + r1) + (r2 + r3)) + ((r4 + r5) + (r6 + r7));
    for (; i < n; i++) s += x[i] * x[i];
    return s;
  }
  int n2 = n / 2;
  n2 -= n2 % 8;
  return pw_sumsq(x, n2) + pw_sumsq(x + n2, n - n2);
}

int sem_forward_static(const sem_model *m, const int32_t *ids, int n, float *out) {
  const int D = m->d_model;
  for (int j = 0; j < D; j++) out[j] = 0.0f;
  if (n <= 0) return SEM_OK; /* empty -> zero vector (matches model2vec) */
  /* sequential f32 mean over the content token rows == numpy mean(axis=0) */
  for (int i = 0; i < n; i++) {
    const float *row = m->m2v_emb + (size_t)ids[i] * D;
    for (int j = 0; j < D; j++) out[j] += row[j];
  }
  const float k = (float)n;
  for (int j = 0; j < D; j++) out[j] = out[j] / k;
  /* L2 normalize with numpy-pairwise sum-of-squares (+1e-32, as model2vec) */
  float norm = sqrtf(pw_sumsq(out, D));
  float denom = norm + 1e-32f;
  for (int j = 0; j < D; j++) out[j] = out[j] / denom;
  return SEM_OK;
}
