/*
** rh vector-search extension — vector BLOB codec.
**
** A stored vector is a packed BLOB with no header: the dimension and element
** type travel in the vector_init() config, never in the blob (matching the
** upstream API contract). All multi-byte elements are little-endian, which is
** also the wasm32 native order. Clean-room; see vector.h.
*/
#ifndef RH_VEC_TYPES_H
#define RH_VEC_TYPES_H

#include "sqlite3.h"

/* Element encodings for a stored vector. */
typedef enum RhvecType {
  RHVEC_F32 = 0,   /* 4 bytes/dim, IEEE-754 single                     */
  RHVEC_F16,       /* 2 bytes/dim, IEEE-754 half                       */
  RHVEC_BF16,      /* 2 bytes/dim, bfloat16 (high 16 bits of a float)  */
  RHVEC_I8,        /* 1 byte/dim, signed, round-to-nearest + clamp     */
  RHVEC_U8,        /* 1 byte/dim, unsigned, round-to-nearest + clamp   */
  RHVEC_BIT        /* 1 bit/dim (LSB-first in each byte), set when >0   */
} RhvecType;

/* Number of bytes needed to hold an nDim vector of the given type. */
sqlite3_int64 rhvecBlobSize(RhvecType type, int nDim);

/* Number of dimensions a blob of nBlob bytes holds, or -1 if nBlob is not a
** whole number of elements for the type. */
int rhvecDimFromBytes(RhvecType type, sqlite3_int64 nBlob);

/* Parse a type name (case-insensitive) into *pType. Accepts both the upstream
** spellings and short aliases: FLOAT32/F32, FLOAT16/F16, BFLOAT16/BF16/FLOATB16,
** INT8/I8, UINT8/U8, 1BIT/BIT. Returns SQLITE_OK or SQLITE_ERROR. */
int rhvecParseType(const char *z, RhvecType *pType);

/* Canonical lowercase name for a type (e.g. "f32"). */
const char *rhvecTypeName(RhvecType type);

/* Decode a packed BLOB of the given type into nDim floats (BIT -> 0.0/1.0).
** Returns SQLITE_ERROR if the blob is too small for nDim. */
int rhvecDecodeToF32(RhvecType type, const void *blob, sqlite3_int64 nBlob,
                     int nDim, float *aOut);

/* Software half/bfloat16 conversions (no reliance on _Float16). */
unsigned short rhvecF32ToF16(float f);
float          rhvecF16ToF32(unsigned short h);
unsigned short rhvecF32ToBf16(float f);
float          rhvecBf16ToF32(unsigned short b);

/*
** Parse a JSON array of numbers (e.g. "[0.1, -2, 3.5]") into a freshly
** sqlite3_malloc64'd double[]. On SQLITE_OK, *paOut owns memory the caller
** frees with sqlite3_free and *pnOut is the element count (may be 0 for
** "[]"). Returns SQLITE_NOMEM on OOM or SQLITE_ERROR if malformed. The input
** must be NUL-terminated (as sqlite3_value_text guarantees).
*/
int rhvecParseJsonArray(const char *zJson, int nJson,
                        double **paOut, int *pnOut);

/*
** Encode a double[] into a packed BLOB of the given type. *ppBlob is
** sqlite3_malloc64'd (always non-NULL, even for nDim==0) and *pnBlob is its
** length; caller frees with sqlite3_free. Returns SQLITE_NOMEM on OOM.
*/
int rhvecEncode(RhvecType type, const double *a, int nDim,
                void **ppBlob, sqlite3_int64 *pnBlob);

/* Register vector_as_f32/f16/bf16/i8/u8/bit on the connection. */
int rhvecRegisterTypeFuncs(sqlite3 *db);

#endif /* RH_VEC_TYPES_H */
