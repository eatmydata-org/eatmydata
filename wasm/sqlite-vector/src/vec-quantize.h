/*
** rh vector-search extension — TurboQuant quantization.
**
** Clean-room implementation of the scheme in "TurboQuant: Online Vector
** Quantization with Near-optimal Distortion Rate" (Zandieh, Daliri, Hadian,
** Mirrokni; arXiv:2504.19874). NO upstream sqlite-vector code is used; this is
** written from the paper. See vector.h.
**
** Pipeline (data-oblivious, online — no training on the dataset):
**   1. Rotate x by a Haar-random orthogonal matrix Pi (QR of a Gaussian),
**      regenerated deterministically from a stored 64-bit seed so the query
**      and the stored vectors share the SAME rotation across sessions.
**   2. Store the L2 norm (scale) in float32; quantize the unit direction.
**   3. Per-coordinate scalar quantization at b bits using the MSE-optimal
**      (Lloyd-Max) codebook for the standard normal — the rotated unit
**      coordinates are ~ N(0, 1/d) — or a uniform codebook for 8-bit.
**   4. Asymmetric estimate: the query stays full-precision. Because Pi is
**      orthonormal, <q,x> = ||x|| * <Pi q, y_unit>, scored against the
**      dequantized unit vector y_unit. L2/cosine follow from that + norms.
**
** SIMPLIFICATION vs the paper: the optional Stage-2 "1-bit QJL on the residual"
** (which further de-biases the inner-product estimate) is NOT implemented; the
** scan layer reranks the top candidates with the exact vectors, which recovers
** recall. Documented honestly per the clean-room discipline.
*/
#ifndef RH_VEC_QUANTIZE_H
#define RH_VEC_QUANTIZE_H

#include "sqlite3.h"

/* Persisted quantization parameters for one (table,column). */
typedef struct RhvecQuantMeta {
  int qbits;
  int nDim;
  sqlite3_uint64 seed;
} RhvecQuantMeta;

/* A preloaded set of quantized vectors for one (table,column). */
typedef struct RhvecQuantSet {
  int nRows;
  int nDim;
  int qbits;
  int codeBytes;
  sqlite3_uint64 seed;
  const sqlite3_int64 *aRowid;  /* [nRows]            */
  const float *aScale;          /* [nRows]            */
  const unsigned char *aCode;   /* [nRows*codeBytes]  */
} RhvecQuantSet;

/* Bytes of packed code for an nDim vector at qbits bits/coordinate. */
int rhvecQuantCodeBytes(int nDim, int qbits);

/* Fill aLevels with the (1<<qbits) standardized codebook centroids (sorted
** ascending). aLevels must hold at least (1<<qbits) floats. */
void rhvecCodebook(int qbits, float *aLevels);

/* Build the Haar rotation matrix (nDim*nDim floats, row-major) from seed.
** sqlite3_malloc64'd; caller frees with sqlite3_free. NULL on OOM. */
float *rhvecBuildRotation(sqlite3_uint64 seed, int nDim);

/* out = Pi * in (in/out are nDim floats). */
void rhvecRotate(const float *Pi, int nDim, const float *in, float *out);

/* Decode a packed code into the dequantized unit vector in rotated space:
** out[j] = levels[idx_j] * invSqrtD. */
void rhvecDequantUnit(const unsigned char *code, int nDim, int qbits,
                      const float *aLevels, float invSqrtD, float *out);

/* Look up persisted quant params. SQLITE_OK / SQLITE_NOTFOUND / error. */
int rhvecQuantMetaLookup(sqlite3 *db, const char *zTbl, const char *zCol,
                         RhvecQuantMeta *pMeta);

/* If (zTbl,zCol) is currently preloaded in memory, fill *pSet and return 1;
** otherwise return 0. */
int rhvecQuantCacheGet(const char *zTbl, const char *zCol, RhvecQuantSet *pSet);

/* Register vector_quantize / _memory / _preload / _cleanup. */
int rhvecRegisterQuantizeFuncs(sqlite3 *db);

/* Shadow tables (also used by the scan to read codes on a cache miss). */
#define RHVEC_QUANT_TABLE "_rhvec_quant"
#define RHVEC_QUANT_META  "_rhvec_quant_meta"

#endif /* RH_VEC_QUANTIZE_H */
