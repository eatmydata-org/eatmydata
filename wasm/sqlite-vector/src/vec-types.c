/*
** rh vector-search extension — vector BLOB codec implementation.
**
** Clean-room (see vector.h). SQLite coding conventions: allocations go through
** sqlite3_malloc64 / sqlite3_realloc64 / sqlite3_free; results are returned via
** the sqlite3_result_* family. Only parsing/math libc calls (strtod, lround,
** memcpy) are used, never libc allocation.
*/
#include "sqlite3.h"
#include "vec-types.h"

#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

/* Number of bytes for an nDim vector of the given type. */
sqlite3_int64 rhvecBlobSize(RhvecType type, int nDim){
  sqlite3_int64 n = nDim<0 ? 0 : (sqlite3_int64)nDim;
  switch( type ){
    case RHVEC_F32:  return n*4;
    case RHVEC_F16:  return n*2;
    case RHVEC_BF16: return n*2;
    case RHVEC_I8:   return n*1;
    case RHVEC_U8:   return n*1;
    case RHVEC_BIT:  return (n+7)/8;
  }
  return 0;
}

/* Recover the dimension a blob encodes, or -1 if the byte count is not a
** whole number of elements. For BIT any byte count is ambiguous (the last
** byte may be partly padding), so we return the maximum dimension it can
** hold; callers cross-check against the configured dimension. */
int rhvecDimFromBytes(RhvecType type, sqlite3_int64 nBlob){
  if( nBlob<0 ) return -1;
  switch( type ){
    case RHVEC_F32:  return (nBlob%4)==0 ? (int)(nBlob/4) : -1;
    case RHVEC_F16:  return (nBlob%2)==0 ? (int)(nBlob/2) : -1;
    case RHVEC_BF16: return (nBlob%2)==0 ? (int)(nBlob/2) : -1;
    case RHVEC_I8:   return (int)nBlob;
    case RHVEC_U8:   return (int)nBlob;
    case RHVEC_BIT:  return (int)(nBlob*8);
  }
  return -1;
}

/* Parse a type name into *pType. Case-insensitive; accepts upstream spellings
** and short aliases. */
int rhvecParseType(const char *z, RhvecType *pType){
  if( z==0 ) return SQLITE_ERROR;
  if( sqlite3_stricmp(z,"float32")==0 || sqlite3_stricmp(z,"f32")==0 ){
    *pType = RHVEC_F32;
  }else if( sqlite3_stricmp(z,"float16")==0 || sqlite3_stricmp(z,"f16")==0 ){
    *pType = RHVEC_F16;
  }else if( sqlite3_stricmp(z,"bfloat16")==0 || sqlite3_stricmp(z,"bf16")==0
            || sqlite3_stricmp(z,"floatb16")==0 ){
    *pType = RHVEC_BF16;
  }else if( sqlite3_stricmp(z,"int8")==0 || sqlite3_stricmp(z,"i8")==0 ){
    *pType = RHVEC_I8;
  }else if( sqlite3_stricmp(z,"uint8")==0 || sqlite3_stricmp(z,"u8")==0 ){
    *pType = RHVEC_U8;
  }else if( sqlite3_stricmp(z,"1bit")==0 || sqlite3_stricmp(z,"bit")==0 ){
    *pType = RHVEC_BIT;
  }else{
    return SQLITE_ERROR;
  }
  return SQLITE_OK;
}

const char *rhvecTypeName(RhvecType type){
  switch( type ){
    case RHVEC_F32:  return "f32";
    case RHVEC_F16:  return "f16";
    case RHVEC_BF16: return "bf16";
    case RHVEC_I8:   return "i8";
    case RHVEC_U8:   return "u8";
    case RHVEC_BIT:  return "bit";
  }
  return "?";
}

/* IEEE-754 single -> half, round-to-nearest-even, with inf/nan/subnormal. */
unsigned short rhvecF32ToF16(float f){
  uint32_t x;
  uint32_t sign, mant;
  int32_t exp;
  memcpy(&x, &f, 4);
  sign = (x>>16) & 0x8000u;
  exp  = (int32_t)((x>>23) & 0xff);
  mant = x & 0x7fffffu;
  if( exp==0xff ){                 /* inf / nan */
    return (unsigned short)(sign | 0x7c00u | (mant ? 0x200u : 0u));
  }
  exp = exp - 127 + 15;
  if( exp>=0x1f ){                 /* overflow -> inf */
    return (unsigned short)(sign | 0x7c00u);
  }
  if( exp<=0 ){                    /* subnormal or zero */
    uint32_t half;
    int shift;
    if( exp<-10 ) return (unsigned short)sign;
    mant |= 0x800000u;
    shift = 14 - exp;
    half = mant >> shift;
    if( (mant >> (shift-1)) & 1u ) half++;   /* round */
    return (unsigned short)(sign | half);
  }
  {                                /* normal, round-to-nearest-even */
    uint16_t half = (uint16_t)(sign | ((uint32_t)exp<<10) | (mant>>13));
    uint32_t rem = mant & 0x1fffu;
    if( rem>0x1000u || (rem==0x1000u && (half&1u)) ) half++;
    return half;
  }
}

/* IEEE-754 half -> single. */
float rhvecF16ToF32(unsigned short h){
  uint32_t sign = (uint32_t)(h & 0x8000u) << 16;
  uint32_t exp  = (h>>10) & 0x1fu;
  uint32_t mant = h & 0x3ffu;
  uint32_t f;
  float out;
  if( exp==0 ){
    if( mant==0 ){
      f = sign;
    }else{
      exp = 127 - 15 + 1;
      while( (mant & 0x400u)==0 ){ mant<<=1; exp--; }
      mant &= 0x3ffu;
      f = sign | (exp<<23) | (mant<<13);
    }
  }else if( exp==0x1fu ){
    f = sign | 0x7f800000u | (mant<<13);
  }else{
    f = sign | ((exp - 15 + 127)<<23) | (mant<<13);
  }
  memcpy(&out, &f, 4);
  return out;
}

/* float -> bfloat16 (truncate to high 16 bits, round-to-nearest-even). */
unsigned short rhvecF32ToBf16(float f){
  uint32_t x;
  uint32_t round;
  memcpy(&x, &f, 4);
  if( ((x>>23)&0xff)==0xff && (x&0x7fffffu) ){  /* nan: keep it quiet */
    return (unsigned short)((x>>16) | 0x40u);
  }
  round = ((x>>16) & 1u) + 0x7fffu;
  x += round;
  return (unsigned short)(x>>16);
}

/* bfloat16 -> float. */
float rhvecBf16ToF32(unsigned short b){
  uint32_t x = (uint32_t)b << 16;
  float out;
  memcpy(&out, &x, 4);
  return out;
}

static int rhvecIsSpace(char c){
  return c==' ' || c=='\t' || c=='\n' || c=='\r';
}

/* Round a double to an integer and clamp into [lo,hi]. */
static int rhvecClampRound(double v, int lo, int hi){
  long r;
  if( v!=v ) return 0;             /* nan -> 0 */
  r = lround(v);
  if( r<lo ) return lo;
  if( r>hi ) return hi;
  return (int)r;
}

int rhvecParseJsonArray(const char *z, int n, double **paOut, int *pnOut){
  const char *zEnd;
  double *a = 0;
  int cnt = 0, cap = 0;
  *paOut = 0;
  *pnOut = 0;
  if( z==0 ) return SQLITE_ERROR;
  zEnd = z + n;
  while( z<zEnd && rhvecIsSpace(*z) ) z++;
  if( z>=zEnd || *z!='[' ) return SQLITE_ERROR;
  z++;
  for(;;){
    char *zStop;
    double v;
    while( z<zEnd && rhvecIsSpace(*z) ) z++;
    if( z<zEnd && *z==']' ){ z++; break; }
    if( cnt>0 ){
      if( z<zEnd && *z==',' ){
        z++;
        while( z<zEnd && rhvecIsSpace(*z) ) z++;
      }else{
        sqlite3_free(a);
        return SQLITE_ERROR;
      }
    }
    if( z>=zEnd ){ sqlite3_free(a); return SQLITE_ERROR; }
    zStop = 0;
    v = strtod(z, &zStop);
    if( zStop==z ){ sqlite3_free(a); return SQLITE_ERROR; }
    z = zStop;
    if( cnt>=cap ){
      int newCap = cap ? cap*2 : 8;
      double *aNew = sqlite3_realloc64(a, (sqlite3_int64)sizeof(double)*newCap);
      if( aNew==0 ){ sqlite3_free(a); return SQLITE_NOMEM; }
      a = aNew;
      cap = newCap;
    }
    a[cnt++] = v;
  }
  while( z<zEnd && rhvecIsSpace(*z) ) z++;
  if( z!=zEnd ){ sqlite3_free(a); return SQLITE_ERROR; }
  *paOut = a;
  *pnOut = cnt;
  return SQLITE_OK;
}

int rhvecEncode(
  RhvecType type,
  const double *a,
  int nDim,
  void **ppBlob,
  sqlite3_int64 *pnBlob
){
  sqlite3_int64 nBlob = rhvecBlobSize(type, nDim);
  unsigned char *p;
  int i;
  p = (unsigned char*)sqlite3_malloc64(nBlob>0 ? nBlob : 1);
  if( p==0 ) return SQLITE_NOMEM;
  switch( type ){
    case RHVEC_F32:
      for(i=0; i<nDim; i++){
        float f = (float)a[i];
        memcpy(p + (sqlite3_int64)i*4, &f, 4);
      }
      break;
    case RHVEC_F16:
      for(i=0; i<nDim; i++){
        unsigned short h = rhvecF32ToF16((float)a[i]);
        memcpy(p + (sqlite3_int64)i*2, &h, 2);
      }
      break;
    case RHVEC_BF16:
      for(i=0; i<nDim; i++){
        unsigned short h = rhvecF32ToBf16((float)a[i]);
        memcpy(p + (sqlite3_int64)i*2, &h, 2);
      }
      break;
    case RHVEC_I8:
      for(i=0; i<nDim; i++){
        signed char c = (signed char)rhvecClampRound(a[i], -128, 127);
        p[i] = (unsigned char)c;
      }
      break;
    case RHVEC_U8:
      for(i=0; i<nDim; i++){
        p[i] = (unsigned char)rhvecClampRound(a[i], 0, 255);
      }
      break;
    case RHVEC_BIT:
      memset(p, 0, nBlob>0 ? (size_t)nBlob : 1);
      for(i=0; i<nDim; i++){
        if( a[i]>0.0 ) p[i>>3] |= (unsigned char)(1u << (i & 7));
      }
      break;
  }
  *ppBlob = p;
  *pnBlob = nBlob;
  return SQLITE_OK;
}

int rhvecDecodeToF32(
  RhvecType type,
  const void *blob,
  sqlite3_int64 nBlob,
  int nDim,
  float *aOut
){
  const unsigned char *p = (const unsigned char*)blob;
  int i;
  if( nDim<0 || rhvecBlobSize(type, nDim) > nBlob ) return SQLITE_ERROR;
  switch( type ){
    case RHVEC_F32:
      for(i=0; i<nDim; i++){
        float f;
        memcpy(&f, p + (sqlite3_int64)i*4, 4);
        aOut[i] = f;
      }
      break;
    case RHVEC_F16:
      for(i=0; i<nDim; i++){
        unsigned short h;
        memcpy(&h, p + (sqlite3_int64)i*2, 2);
        aOut[i] = rhvecF16ToF32(h);
      }
      break;
    case RHVEC_BF16:
      for(i=0; i<nDim; i++){
        unsigned short h;
        memcpy(&h, p + (sqlite3_int64)i*2, 2);
        aOut[i] = rhvecBf16ToF32(h);
      }
      break;
    case RHVEC_I8:
      for(i=0; i<nDim; i++) aOut[i] = (float)(signed char)p[i];
      break;
    case RHVEC_U8:
      for(i=0; i<nDim; i++) aOut[i] = (float)p[i];
      break;
    case RHVEC_BIT:
      for(i=0; i<nDim; i++){
        aOut[i] = ((p[i>>3] >> (i & 7)) & 1u) ? 1.0f : 0.0f;
      }
      break;
  }
  return SQLITE_OK;
}

/*
** vector_as_<type>(value) -> BLOB
**
** TEXT input is parsed as a JSON number array and packed into the type's
** layout. BLOB input is assumed to already be in that layout and passed
** through unchanged (upstream contract). NULL maps to NULL. The element type
** is carried as the function's user-data pointer.
*/
static void rhvecAsFunc(
  sqlite3_context *ctx,
  int argc,
  sqlite3_value **argv
){
  RhvecType type = (RhvecType)(intptr_t)sqlite3_user_data(ctx);
  int vt = sqlite3_value_type(argv[0]);
  const char *zJson;
  int nJson;
  double *a = 0;
  int nDim = 0, rc;
  void *blob = 0;
  sqlite3_int64 nBlob = 0;
  (void)argc;

  if( vt==SQLITE_NULL ){ sqlite3_result_null(ctx); return; }
  if( vt==SQLITE_BLOB ){ sqlite3_result_value(ctx, argv[0]); return; }

  zJson = (const char*)sqlite3_value_text(argv[0]);
  nJson = sqlite3_value_bytes(argv[0]);
  rc = rhvecParseJsonArray(zJson, nJson, &a, &nDim);
  if( rc==SQLITE_NOMEM ){ sqlite3_result_error_nomem(ctx); return; }
  if( rc!=SQLITE_OK ){
    sqlite3_result_error(ctx, "vector_as_*: expected a JSON array of numbers", -1);
    return;
  }
  rc = rhvecEncode(type, a, nDim, &blob, &nBlob);
  sqlite3_free(a);
  if( rc==SQLITE_NOMEM ){ sqlite3_result_error_nomem(ctx); return; }
  sqlite3_result_blob(ctx, blob, (int)nBlob, sqlite3_free);
}

int rhvecRegisterTypeFuncs(sqlite3 *db){
  static const struct {
    const char *zName;
    RhvecType type;
  } aFunc[] = {
    { "vector_as_f32",  RHVEC_F32  },
    { "vector_as_f16",  RHVEC_F16  },
    { "vector_as_bf16", RHVEC_BF16 },
    { "vector_as_i8",   RHVEC_I8   },
    { "vector_as_u8",   RHVEC_U8   },
    { "vector_as_bit",  RHVEC_BIT  },
  };
  int i, rc = SQLITE_OK;
  for(i=0; i<(int)(sizeof(aFunc)/sizeof(aFunc[0])) && rc==SQLITE_OK; i++){
    rc = sqlite3_create_function(
      db, aFunc[i].zName, 1,
      SQLITE_UTF8 | SQLITE_DETERMINISTIC | SQLITE_INNOCUOUS,
      (void*)(intptr_t)aFunc[i].type, rhvecAsFunc, 0, 0
    );
  }
  return rc;
}
