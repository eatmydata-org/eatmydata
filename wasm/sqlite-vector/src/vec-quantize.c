/*
** rh vector-search extension — TurboQuant quantization implementation.
**
** Clean-room from arXiv:2504.19874 (see vec-quantize.h for the scheme and the
** documented simplification). SQLite conventions throughout: sqlite3_malloc64,
** prepared statements, public API only.
*/
#include "sqlite3.h"
#include "vec-quantize.h"
#include "vec-config.h"
#include "vec-distance.h"
#include "vec-types.h"

#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define RHVEC_TWO_PI 6.283185307179586

/* ---- deterministic PRNG (splitmix64) + standard-normal sampler ---- */

static sqlite3_uint64 rhvecSm64(sqlite3_uint64 *s){
  sqlite3_uint64 z = (*s += 0x9E3779B97F4A7C15ULL);
  z = (z ^ (z>>30)) * 0xBF58476D1CE4E5B9ULL;
  z = (z ^ (z>>27)) * 0x94D049BB133111EBULL;
  return z ^ (z>>31);
}
static double rhvecUniform(sqlite3_uint64 *s){
  return (double)(rhvecSm64(s) >> 11) * (1.0/9007199254740992.0); /* [0,1) */
}
static double rhvecGauss(sqlite3_uint64 *s){
  double u1 = rhvecUniform(s);
  double u2 = rhvecUniform(s);
  if( u1 < 1e-300 ) u1 = 1e-300;
  return sqrt(-2.0*log(u1)) * cos(RHVEC_TWO_PI*u2);
}

/* FNV-1a 64-bit hash of "tbl\0col", used as the rotation seed so it is stable
** for a column and distinct between columns. */
static sqlite3_uint64 rhvecSeed(const char *zTbl, const char *zCol){
  sqlite3_uint64 h = 1469598103934665603ULL;
  const char *z;
  for(z=zTbl; *z; z++){ h ^= (unsigned char)*z; h *= 1099511628211ULL; }
  h ^= 0; h *= 1099511628211ULL;
  for(z=zCol; *z; z++){ h ^= (unsigned char)*z; h *= 1099511628211ULL; }
  return h ? h : 0x1234567ULL;
}

/* ---- rotation ---- */

float *rhvecBuildRotation(sqlite3_uint64 seed, int nDim){
  float *Pi;
  sqlite3_uint64 s = seed ? seed : 0x1234567ULL;
  sqlite3_int64 i, j, k, n = nDim;
  Pi = (float*)sqlite3_malloc64((sqlite3_int64)sizeof(float)*n*n);
  if( Pi==0 ) return 0;
  for(i=0; i<n*n; i++) Pi[i] = (float)rhvecGauss(&s);
  /* Modified Gram-Schmidt: orthonormalize the rows (Haar orthogonal). */
  for(i=0; i<n; i++){
    float *vi = Pi + i*n;
    double nrm = 0.0;
    for(j=0; j<i; j++){
      const float *vj = Pi + j*n;
      double dotp = 0.0;
      for(k=0; k<n; k++) dotp += (double)vi[k]*vj[k];
      for(k=0; k<n; k++) vi[k] -= (float)(dotp*vj[k]);
    }
    for(k=0; k<n; k++) nrm += (double)vi[k]*vi[k];
    nrm = sqrt(nrm);
    if( nrm < 1e-12 ){
      for(k=0; k<n; k++) vi[k] = (k==i) ? 1.0f : 0.0f;  /* degenerate */
    }else{
      float inv = (float)(1.0/nrm);
      for(k=0; k<n; k++) vi[k] *= inv;
    }
  }
  return Pi;
}

void rhvecRotate(const float *Pi, int nDim, const float *in, float *out){
  int i, k;
  for(i=0; i<nDim; i++){
    const float *row = Pi + (sqlite3_int64)i*nDim;
    double s = 0.0;
    for(k=0; k<nDim; k++) s += (double)row[k]*in[k];
    out[i] = (float)s;
  }
}

/* ---- codebook + bit packing ---- */

void rhvecCodebook(int qbits, float *aLevels){
  static const float L1[] = { -0.7978845608f, 0.7978845608f };
  static const float L2[] = { -1.5104f, -0.4528f, 0.4528f, 1.5104f };
  static const float L3[] = {
    -2.1519f, -1.3439f, -0.7560f, -0.2451f, 0.2451f, 0.7560f, 1.3439f, 2.1519f
  };
  static const float L4[] = {
    -2.7326f, -2.0690f, -1.6180f, -1.2562f, -0.9424f, -0.6568f, -0.3881f,
    -0.1284f, 0.1284f, 0.3881f, 0.6568f, 0.9424f, 1.2562f, 1.6180f, 2.0690f,
    2.7326f
  };
  int L = 1<<qbits, i;
  const float *src = 0;
  switch( qbits ){
    case 1: src = L1; break;
    case 2: src = L2; break;
    case 3: src = L3; break;
    case 4: src = L4; break;
  }
  if( src ){
    for(i=0; i<L; i++) aLevels[i] = src[i];
    return;
  }
  /* Uniform fallback (e.g. 8-bit) over [-3,3] standard deviations. */
  {
    double LIM = 3.0, step = 2.0*LIM/L;
    for(i=0; i<L; i++) aLevels[i] = (float)(-LIM + (i+0.5)*step);
  }
}

int rhvecQuantCodeBytes(int nDim, int qbits){
  return (int)(((sqlite3_int64)nDim*qbits + 7) / 8);
}

static void rhvecPutBits(unsigned char *buf, int pos, int b, unsigned v){
  int i;
  for(i=0; i<b; i++){
    if( (v>>i) & 1u ) buf[(pos+i)>>3] |= (unsigned char)(1u << ((pos+i)&7));
  }
}
static unsigned rhvecGetBits(const unsigned char *buf, int pos, int b){
  unsigned v = 0;
  int i;
  for(i=0; i<b; i++){
    if( (buf[(pos+i)>>3] >> ((pos+i)&7)) & 1u ) v |= (1u<<i);
  }
  return v;
}

/* Nearest codebook index for a standardized coordinate. */
static int rhvecNearest(double s, int qbits, const float *aLevels){
  int L = 1<<qbits, i, best;
  double bd;
  if( qbits>4 ){
    double LIM = 3.0, step = 2.0*LIM/L;
    int idx = (int)floor((s+LIM)/step);
    if( idx<0 ) idx = 0;
    if( idx>=L ) idx = L-1;
    return idx;
  }
  best = 0;
  bd = fabs(s - aLevels[0]);
  for(i=1; i<L; i++){
    double d = fabs(s - aLevels[i]);
    if( d<bd ){ bd = d; best = i; }
  }
  return best;
}

void rhvecDequantUnit(
  const unsigned char *code,
  int nDim,
  int qbits,
  const float *aLevels,
  float invSqrtD,
  float *out
){
  int j;
  for(j=0; j<nDim; j++){
    unsigned idx = rhvecGetBits(code, j*qbits, qbits);
    out[j] = aLevels[idx] * invSqrtD;
  }
}

/* ---- shadow tables ---- */

static int rhvecQuantEnsureTables(sqlite3 *db){
  return sqlite3_exec(
    db,
    "CREATE TABLE IF NOT EXISTS " RHVEC_QUANT_TABLE
    "(tbl TEXT NOT NULL, col TEXT NOT NULL, rid INTEGER NOT NULL,"
    " scale REAL NOT NULL, code BLOB NOT NULL, PRIMARY KEY(tbl,col,rid));"
    "CREATE TABLE IF NOT EXISTS " RHVEC_QUANT_META
    "(tbl TEXT NOT NULL, col TEXT NOT NULL, qtype TEXT NOT NULL,"
    " qbits INTEGER NOT NULL, seed INTEGER NOT NULL, ndim INTEGER NOT NULL,"
    " PRIMARY KEY(tbl,col));",
    0, 0, 0
  );
}

int rhvecQuantMetaLookup(
  sqlite3 *db,
  const char *zTbl,
  const char *zCol,
  RhvecQuantMeta *pMeta
){
  sqlite3_stmt *pStmt = 0;
  int rc = sqlite3_prepare_v2(
    db,
    "SELECT qbits, seed, ndim FROM " RHVEC_QUANT_META
    " WHERE tbl=?1 AND col=?2",
    -1, &pStmt, 0
  );
  if( rc!=SQLITE_OK ){ sqlite3_finalize(pStmt); return SQLITE_NOTFOUND; }
  sqlite3_bind_text(pStmt, 1, zTbl, -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(pStmt, 2, zCol, -1, SQLITE_TRANSIENT);
  rc = sqlite3_step(pStmt);
  if( rc==SQLITE_ROW ){
    pMeta->qbits = sqlite3_column_int(pStmt, 0);
    pMeta->seed = (sqlite3_uint64)sqlite3_column_int64(pStmt, 1);
    pMeta->nDim = sqlite3_column_int(pStmt, 2);
    sqlite3_finalize(pStmt);
    return SQLITE_OK;
  }
  sqlite3_finalize(pStmt);
  return SQLITE_NOTFOUND;
}

/* ---- quantize core ---- */

static int rhvecQuantizeImpl(
  sqlite3 *db,
  const char *zTbl,
  const char *zCol,
  const char *zQtype,
  int qbits,
  sqlite3_int64 *pnRows,
  char **pzErr
){
  RhvecConfig cfg;
  float *Pi = 0, *aF = 0, *aRot = 0;
  unsigned char *aCode = 0;
  float aLevels[256];
  sqlite3_uint64 seed;
  sqlite3_stmt *pRead = 0, *pIns = 0, *pDel = 0, *pMeta = 0;
  char *zSql = 0;
  int d, codeBytes, rc;
  double sqrtD, invSqrtD;
  sqlite3_int64 nRows = 0;

  rc = rhvecConfigLookup(db, zTbl, zCol, &cfg);
  if( rc==SQLITE_NOTFOUND ){
    *pzErr = sqlite3_mprintf(
      "vector_quantize: no vector_init for \"%s\".\"%s\"", zTbl, zCol);
    return SQLITE_ERROR;
  }
  if( rc!=SQLITE_OK ) return rc;

  d = cfg.nDim;
  codeBytes = rhvecQuantCodeBytes(d, qbits);
  seed = rhvecSeed(zTbl, zCol);
  sqrtD = sqrt((double)(d>0 ? d : 1));
  invSqrtD = 1.0/sqrtD;
  rhvecCodebook(qbits, aLevels);

  Pi = rhvecBuildRotation(seed, d);
  aF = (float*)sqlite3_malloc64((sqlite3_int64)sizeof(float)*(d>0?d:1));
  aRot = (float*)sqlite3_malloc64((sqlite3_int64)sizeof(float)*(d>0?d:1));
  aCode = (unsigned char*)sqlite3_malloc64(codeBytes>0?codeBytes:1);
  if( Pi==0 || aF==0 || aRot==0 || aCode==0 ){ rc = SQLITE_NOMEM; goto done; }

  rc = rhvecQuantEnsureTables(db);
  if( rc!=SQLITE_OK ){ *pzErr = sqlite3_mprintf("%s", sqlite3_errmsg(db)); goto done; }

  /* No explicit BEGIN/COMMIT: vector_quantize runs inside the calling
  ** statement's implicit transaction (it is invoked from a SELECT), so all
  ** inserts are already batched into that one transaction. */
  rc = sqlite3_prepare_v2(db,
    "DELETE FROM " RHVEC_QUANT_TABLE " WHERE tbl=?1 AND col=?2", -1, &pDel, 0);
  if( rc!=SQLITE_OK ) goto sqlerr;
  sqlite3_bind_text(pDel, 1, zTbl, -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(pDel, 2, zCol, -1, SQLITE_TRANSIENT);
  sqlite3_step(pDel);

  rc = sqlite3_prepare_v2(db,
    "INSERT OR REPLACE INTO " RHVEC_QUANT_META
    "(tbl,col,qtype,qbits,seed,ndim) VALUES(?1,?2,?3,?4,?5,?6)", -1, &pMeta, 0);
  if( rc!=SQLITE_OK ) goto sqlerr;
  sqlite3_bind_text(pMeta, 1, zTbl, -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(pMeta, 2, zCol, -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(pMeta, 3, zQtype, -1, SQLITE_TRANSIENT);
  sqlite3_bind_int(pMeta, 4, qbits);
  sqlite3_bind_int64(pMeta, 5, (sqlite3_int64)seed);
  sqlite3_bind_int(pMeta, 6, d);
  sqlite3_step(pMeta);

  zSql = sqlite3_mprintf("SELECT rowid, \"%w\" FROM \"%w\"", zCol, zTbl);
  if( zSql==0 ){ rc = SQLITE_NOMEM; goto done; }
  rc = sqlite3_prepare_v2(db, zSql, -1, &pRead, 0);
  if( rc!=SQLITE_OK ) goto sqlerr;

  rc = sqlite3_prepare_v2(db,
    "INSERT INTO " RHVEC_QUANT_TABLE
    "(tbl,col,rid,scale,code) VALUES(?1,?2,?3,?4,?5)", -1, &pIns, 0);
  if( rc!=SQLITE_OK ) goto sqlerr;

  while( sqlite3_step(pRead)==SQLITE_ROW ){
    sqlite3_int64 rowid;
    const void *pv;
    sqlite3_int64 nb;
    int dd, j;
    double norm = 0.0;
    if( sqlite3_column_type(pRead,1)==SQLITE_NULL ) continue;
    rowid = sqlite3_column_int64(pRead, 0);
    nb = sqlite3_column_bytes(pRead, 1);
    pv = sqlite3_column_blob(pRead, 1);
    dd = rhvecDimFromBytes(cfg.type, nb);
    if( dd!=d ) continue;
    rhvecDecodeToF32(cfg.type, pv, nb, d, aF);
    for(j=0; j<d; j++) norm += (double)aF[j]*aF[j];
    norm = sqrt(norm);
    rhvecRotate(Pi, d, aF, aRot);
    memset(aCode, 0, codeBytes>0?(size_t)codeBytes:1);
    if( norm>0.0 ){
      double inv = 1.0/norm;
      for(j=0; j<d; j++){
        double s = (double)aRot[j]*inv*sqrtD;
        int idx = rhvecNearest(s, qbits, aLevels);
        rhvecPutBits(aCode, j*qbits, qbits, (unsigned)idx);
      }
    }
    sqlite3_bind_text(pIns, 1, zTbl, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(pIns, 2, zCol, -1, SQLITE_TRANSIENT);
    sqlite3_bind_int64(pIns, 3, rowid);
    sqlite3_bind_double(pIns, 4, norm);
    sqlite3_bind_blob(pIns, 5, aCode, codeBytes, SQLITE_TRANSIENT);
    rc = sqlite3_step(pIns);
    if( rc!=SQLITE_DONE ){ goto sqlerr; }
    sqlite3_reset(pIns);
    nRows++;
  }

  rc = SQLITE_OK;
  *pnRows = nRows;
  goto done;

sqlerr:
  if( *pzErr==0 ) *pzErr = sqlite3_mprintf("%s", sqlite3_errmsg(db));

done:
  sqlite3_finalize(pRead);
  sqlite3_finalize(pIns);
  sqlite3_finalize(pDel);
  sqlite3_finalize(pMeta);
  sqlite3_free(zSql);
  sqlite3_free(Pi);
  sqlite3_free(aF);
  sqlite3_free(aRot);
  sqlite3_free(aCode);
  return rc;
}

/* Map a qtype name + optional qbits to a concrete bit-width. */
static int rhvecQbitsForType(const char *zQtype, int qbitsOpt, int *pQbits,
                             char **pzErr){
  int b = qbitsOpt;
  if( sqlite3_stricmp(zQtype,"1bit")==0 ){
    b = 1;
  }else if( sqlite3_stricmp(zQtype,"int8")==0
         || sqlite3_stricmp(zQtype,"uint8")==0 ){
    b = 8;
  }else if( sqlite3_stricmp(zQtype,"turbo")==0
         || sqlite3_stricmp(zQtype,"turbo4")==0 ){
    if( b<=0 ) b = 4;
  }else if( sqlite3_stricmp(zQtype,"turbo2")==0 ){
    b = 2;
  }else if( sqlite3_stricmp(zQtype,"turbo3")==0 ){
    b = 3;
  }else{
    *pzErr = sqlite3_mprintf("vector_quantize: unknown qtype '%s'", zQtype);
    return SQLITE_ERROR;
  }
  if( b!=1 && b!=2 && b!=3 && b!=4 && b!=8 ){
    *pzErr = sqlite3_mprintf("vector_quantize: qbits must be 1..4 or 8");
    return SQLITE_ERROR;
  }
  *pQbits = b;
  return SQLITE_OK;
}

/*
** vector_quantize(table, column [, options]) -> INTEGER rows quantized.
** options: qtype=TURBO|TURBO2|TURBO3|TURBO4|1BIT|INT8|UINT8 (default TURBO),
** qbits=2|3|4 (TURBO only).
*/
static void rhvecQuantizeFunc(
  sqlite3_context *ctx,
  int argc,
  sqlite3_value **argv
){
  sqlite3 *db = sqlite3_context_db_handle(ctx);
  const char *zTbl, *zCol;
  const char *z;
  char zKey[64], zVal[64];
  char zQtype[32] = "turbo";
  int qbitsOpt = 0, qbits = 4, rc;
  sqlite3_int64 nRows = 0;
  char *zErr = 0;

  zTbl = (const char*)sqlite3_value_text(argv[0]);
  zCol = (const char*)sqlite3_value_text(argv[1]);
  z = (argc>=3 && sqlite3_value_type(argv[2])!=SQLITE_NULL)
        ? (const char*)sqlite3_value_text(argv[2]) : "";
  while( rhvecNextOption(&z, zKey, sizeof(zKey), zVal, sizeof(zVal)) ){
    if( sqlite3_stricmp(zKey,"qtype")==0 ){
      sqlite3_snprintf(sizeof(zQtype), zQtype, "%s", zVal);
    }else if( sqlite3_stricmp(zKey,"qbits")==0 ){
      qbitsOpt = atoi(zVal);
    }else if( sqlite3_stricmp(zKey,"max_memory")==0 ){
      /* accepted for parity; the scan bounds memory by the candidate set */
    }else{
      char *zE = sqlite3_mprintf("vector_quantize: unknown option '%s'", zKey);
      sqlite3_result_error(ctx, zE, -1);
      sqlite3_free(zE);
      return;
    }
  }
  if( rhvecQbitsForType(zQtype, qbitsOpt, &qbits, &zErr)!=SQLITE_OK ){
    sqlite3_result_error(ctx, zErr, -1);
    sqlite3_free(zErr);
    return;
  }
  rc = rhvecQuantizeImpl(db, zTbl, zCol, zQtype, qbits, &nRows, &zErr);
  if( rc!=SQLITE_OK ){
    sqlite3_result_error(ctx, zErr ? zErr : sqlite3_errmsg(db), -1);
    sqlite3_free(zErr);
    return;
  }
  sqlite3_result_int64(ctx, nRows);
}

/* vector_quantize_memory(table, column) -> INTEGER bytes to preload. */
static void rhvecQuantizeMemoryFunc(
  sqlite3_context *ctx,
  int argc,
  sqlite3_value **argv
){
  sqlite3 *db = sqlite3_context_db_handle(ctx);
  const char *zTbl = (const char*)sqlite3_value_text(argv[0]);
  const char *zCol = (const char*)sqlite3_value_text(argv[1]);
  RhvecQuantMeta meta;
  sqlite3_stmt *pStmt = 0;
  sqlite3_int64 nRows = 0, perRow;
  (void)argc;
  if( rhvecQuantMetaLookup(db, zTbl, zCol, &meta)!=SQLITE_OK ){
    sqlite3_result_int64(ctx, 0);
    return;
  }
  if( sqlite3_prepare_v2(db,
        "SELECT count(*) FROM " RHVEC_QUANT_TABLE " WHERE tbl=?1 AND col=?2",
        -1, &pStmt, 0)==SQLITE_OK ){
    sqlite3_bind_text(pStmt, 1, zTbl, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(pStmt, 2, zCol, -1, SQLITE_TRANSIENT);
    if( sqlite3_step(pStmt)==SQLITE_ROW ) nRows = sqlite3_column_int64(pStmt, 0);
  }
  sqlite3_finalize(pStmt);
  /* 8 bytes rowid + 4 bytes scale + packed code per row. */
  perRow = 8 + 4 + rhvecQuantCodeBytes(meta.nDim, meta.qbits);
  sqlite3_result_int64(ctx, nRows*perRow);
}

/* ---- preload cache ---- */

typedef struct RhvecCacheEntry {
  char *zTbl;
  char *zCol;
  int nRows;
  int nDim;
  int qbits;
  int codeBytes;
  sqlite3_uint64 seed;
  sqlite3_int64 *aRowid;
  float *aScale;
  unsigned char *aCode;
} RhvecCacheEntry;

static RhvecCacheEntry **gCache = 0;
static int gCacheN = 0;

static int rhvecCacheIndex(const char *zTbl, const char *zCol){
  int i;
  for(i=0; i<gCacheN; i++){
    if( strcmp(gCache[i]->zTbl, zTbl)==0 && strcmp(gCache[i]->zCol, zCol)==0 ){
      return i;
    }
  }
  return -1;
}

static void rhvecCacheFreeEntry(RhvecCacheEntry *e){
  if( e==0 ) return;
  sqlite3_free(e->zTbl);
  sqlite3_free(e->zCol);
  sqlite3_free(e->aRowid);
  sqlite3_free(e->aScale);
  sqlite3_free(e->aCode);
  sqlite3_free(e);
}

static void rhvecCacheRemove(const char *zTbl, const char *zCol){
  int i = rhvecCacheIndex(zTbl, zCol);
  if( i<0 ) return;
  rhvecCacheFreeEntry(gCache[i]);
  gCache[i] = gCache[gCacheN-1];
  gCacheN--;
}

int rhvecQuantCacheGet(const char *zTbl, const char *zCol, RhvecQuantSet *pSet){
  int i = rhvecCacheIndex(zTbl, zCol);
  RhvecCacheEntry *e;
  if( i<0 ) return 0;
  e = gCache[i];
  pSet->nRows = e->nRows;
  pSet->nDim = e->nDim;
  pSet->qbits = e->qbits;
  pSet->codeBytes = e->codeBytes;
  pSet->seed = e->seed;
  pSet->aRowid = e->aRowid;
  pSet->aScale = e->aScale;
  pSet->aCode = e->aCode;
  return 1;
}

/* vector_quantize_preload(table, column) -> NULL. */
static void rhvecQuantizePreloadFunc(
  sqlite3_context *ctx,
  int argc,
  sqlite3_value **argv
){
  sqlite3 *db = sqlite3_context_db_handle(ctx);
  const char *zTbl = (const char*)sqlite3_value_text(argv[0]);
  const char *zCol = (const char*)sqlite3_value_text(argv[1]);
  RhvecQuantMeta meta;
  RhvecCacheEntry *e = 0;
  sqlite3_stmt *pStmt = 0;
  int rc, cap = 0, codeBytes;
  (void)argc;

  if( rhvecQuantMetaLookup(db, zTbl, zCol, &meta)!=SQLITE_OK ){
    sqlite3_result_error(ctx, "vector_quantize_preload: not quantized", -1);
    return;
  }
  codeBytes = rhvecQuantCodeBytes(meta.nDim, meta.qbits);
  e = (RhvecCacheEntry*)sqlite3_malloc64(sizeof(*e));
  if( e==0 ){ sqlite3_result_error_nomem(ctx); return; }
  memset(e, 0, sizeof(*e));
  e->zTbl = sqlite3_mprintf("%s", zTbl);
  e->zCol = sqlite3_mprintf("%s", zCol);
  e->nDim = meta.nDim;
  e->qbits = meta.qbits;
  e->codeBytes = codeBytes;
  e->seed = meta.seed;
  if( e->zTbl==0 || e->zCol==0 ){ rhvecCacheFreeEntry(e); sqlite3_result_error_nomem(ctx); return; }

  rc = sqlite3_prepare_v2(db,
    "SELECT rid, scale, code FROM " RHVEC_QUANT_TABLE
    " WHERE tbl=?1 AND col=?2 ORDER BY rid", -1, &pStmt, 0);
  if( rc!=SQLITE_OK ){ rhvecCacheFreeEntry(e); sqlite3_result_error(ctx, sqlite3_errmsg(db), -1); return; }
  sqlite3_bind_text(pStmt, 1, zTbl, -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(pStmt, 2, zCol, -1, SQLITE_TRANSIENT);
  while( sqlite3_step(pStmt)==SQLITE_ROW ){
    const void *pc = sqlite3_column_blob(pStmt, 2);
    int nc = sqlite3_column_bytes(pStmt, 2);
    if( e->nRows>=cap ){
      int nNew = cap ? cap*2 : 256;
      sqlite3_int64 *r = (sqlite3_int64*)sqlite3_realloc64(e->aRowid, (sqlite3_int64)sizeof(sqlite3_int64)*nNew);
      float *s = (float*)sqlite3_realloc64(e->aScale, (sqlite3_int64)sizeof(float)*nNew);
      unsigned char *c = (unsigned char*)sqlite3_realloc64(e->aCode, (sqlite3_int64)codeBytes*nNew);
      if( r==0 || s==0 || c==0 ){
        sqlite3_free(r); sqlite3_free(s); sqlite3_free(c);
        /* note: partial buffers already swapped below stay owned by e */
        e->aRowid = r ? r : e->aRowid;
        e->aScale = s ? s : e->aScale;
        e->aCode = c ? c : e->aCode;
        sqlite3_finalize(pStmt);
        rhvecCacheFreeEntry(e);
        sqlite3_result_error_nomem(ctx);
        return;
      }
      e->aRowid = r; e->aScale = s; e->aCode = c; cap = nNew;
    }
    e->aRowid[e->nRows] = sqlite3_column_int64(pStmt, 0);
    e->aScale[e->nRows] = (float)sqlite3_column_double(pStmt, 1);
    memset(e->aCode + (sqlite3_int64)e->nRows*codeBytes, 0, codeBytes);
    if( pc && nc>0 ){
      memcpy(e->aCode + (sqlite3_int64)e->nRows*codeBytes, pc,
             nc<codeBytes ? nc : codeBytes);
    }
    e->nRows++;
  }
  sqlite3_finalize(pStmt);

  /* Replace any existing entry, then append. */
  rhvecCacheRemove(zTbl, zCol);
  {
    RhvecCacheEntry **g = (RhvecCacheEntry**)sqlite3_realloc64(
      gCache, (sqlite3_int64)sizeof(RhvecCacheEntry*)*(gCacheN+1));
    if( g==0 ){ rhvecCacheFreeEntry(e); sqlite3_result_error_nomem(ctx); return; }
    gCache = g;
    gCache[gCacheN++] = e;
  }
  sqlite3_result_null(ctx);
}

/* vector_quantize_cleanup(table, column) -> NULL. Frees preloaded memory. */
static void rhvecQuantizeCleanupFunc(
  sqlite3_context *ctx,
  int argc,
  sqlite3_value **argv
){
  const char *zTbl = (const char*)sqlite3_value_text(argv[0]);
  const char *zCol = (const char*)sqlite3_value_text(argv[1]);
  (void)argc;
  rhvecCacheRemove(zTbl, zCol);
  sqlite3_result_null(ctx);
}

int rhvecRegisterQuantizeFuncs(sqlite3 *db){
  int rc;
  rc = sqlite3_create_function(db, "vector_quantize", 2,
         SQLITE_UTF8 | SQLITE_DIRECTONLY, 0, rhvecQuantizeFunc, 0, 0);
  if( rc==SQLITE_OK ){
    rc = sqlite3_create_function(db, "vector_quantize", 3,
           SQLITE_UTF8 | SQLITE_DIRECTONLY, 0, rhvecQuantizeFunc, 0, 0);
  }
  if( rc==SQLITE_OK ){
    rc = sqlite3_create_function(db, "vector_quantize_memory", 2,
           SQLITE_UTF8 | SQLITE_DIRECTONLY, 0, rhvecQuantizeMemoryFunc, 0, 0);
  }
  if( rc==SQLITE_OK ){
    rc = sqlite3_create_function(db, "vector_quantize_preload", 2,
           SQLITE_UTF8 | SQLITE_DIRECTONLY, 0, rhvecQuantizePreloadFunc, 0, 0);
  }
  if( rc==SQLITE_OK ){
    rc = sqlite3_create_function(db, "vector_quantize_cleanup", 2,
           SQLITE_UTF8 | SQLITE_DIRECTONLY, 0, rhvecQuantizeCleanupFunc, 0, 0);
  }
  return rc;
}
