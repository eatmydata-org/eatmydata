/*
** rh vector-search extension — scan virtual tables implementation.
**
** vector_full_scan is an eponymous table-valued function: the positional call
** arguments become EQ constraints on the HIDDEN columns (tbl, col, query, k),
** which xBestIndex maps to xFilter argv. xFilter opens a prepared statement
** over the base table on the same connection, decodes each stored vector, and
** computes the configured metric against the query. With k it returns the k
** nearest sorted by distance; without k it streams every row in table order so
** plain SQL ORDER BY / LIMIT works. Clean-room (see vector.h).
*/
#include "sqlite3.h"
#include "vec-scan.h"
#include "vec-config.h"
#include "vec-distance.h"
#include "vec-quantize.h"
#include "vec-types.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

/*
** Embed a NUL-terminated UTF-8 query phrase into nDim float32 values written to
** aOut. Returns 0 on success; 1 if the on-device embedding model is not
** available/warmed; other nonzero on error. DEFINED in the wa-sqlite build
** itself (wasm/wa-sqlite/src/runtime_shim.c) as a thin wrapper over the in-tree
** BGE engine's sem_embed — the engine is compiled into wa-sqlite.wasm, so this
** is a plain in-module C call (synchronous, no JS, no Asyncify/SAB). In
** Node/vitest the GGUF is never loaded, so sem_dim()==0 and this returns 1.
*/
extern int analyst_embed_query(const char *zText, int nText, float *aOut, int nDim);

/* How many quantized candidates to rerank per requested result (k). The
** quantized pass prunes; the exact rerank over k*OVERSAMPLE candidates
** recovers recall (this is what compensates for the omitted QJL residual
** stage — see vec-quantize.h). */
#define RHVEC_RERANK_OVERSAMPLE 8

/* Output/hidden column indices, matching the declared schema below. */
#define RHVEC_SCOL_ROWID    0
#define RHVEC_SCOL_DISTANCE 1
#define RHVEC_SCOL_TABLE    2
#define RHVEC_SCOL_COLUMN   3
#define RHVEC_SCOL_QUERY    4
#define RHVEC_SCOL_K        5

typedef struct RhvecMatch {
  sqlite3_int64 rowid;
  double distance;   /* natural metric value reported to the caller */
  double order;      /* sort key: distance, or -dot for DOT (smaller=nearer) */
} RhvecMatch;

typedef struct RhvecScanVtab {
  sqlite3_vtab base;
  sqlite3 *db;
  /* 1 for the vector_search module (the (tbl,col) args are the user-facing
  ** text column and must be resolved through _rhvec_search_map to the storage
  ** sidecar); 0 for vector_full_scan / vector_quantize_scan (args ARE the
  ** storage). Set from the module pAux in xConnect. */
  int isSearch;
} RhvecScanVtab;

typedef struct RhvecScanCursor {
  sqlite3_vtab_cursor base;
  RhvecMatch *aRes;
  int nRes;
  int nAlloc;
  int iRow;
} RhvecScanCursor;

static int rhvecScanConnect(
  sqlite3 *db,
  void *pAux,
  int argc,
  const char *const *argv,
  sqlite3_vtab **ppVtab,
  char **pzErr
){
  RhvecScanVtab *p;
  int rc;
  (void)argc;
  (void)argv;
  (void)pzErr;
  rc = sqlite3_declare_vtab(
    db,
    "CREATE TABLE x(rowid INTEGER, distance REAL, tbl HIDDEN, col HIDDEN,"
    " query HIDDEN, k HIDDEN)"
  );
  if( rc!=SQLITE_OK ) return rc;
  p = (RhvecScanVtab*)sqlite3_malloc64(sizeof(*p));
  if( p==0 ) return SQLITE_NOMEM;
  memset(p, 0, sizeof(*p));
  p->db = db;
  /* The vector_search module registers with a non-NULL pAux to flag that its
  ** (tbl,col) call arguments are user-facing and need _rhvec_search_map
  ** resolution; the other two modules pass pAux=0. */
  p->isSearch = pAux ? 1 : 0;
  *ppVtab = &p->base;
  return SQLITE_OK;
}

static int rhvecScanDisconnect(sqlite3_vtab *pVtab){
  sqlite3_free(pVtab);
  return SQLITE_OK;
}

static int rhvecScanBestIndex(sqlite3_vtab *pVtab, sqlite3_index_info *pIdx){
  int i;
  int iTbl=-1, iCol=-1, iQuery=-1, iK=-1;
  int argc=0;
  (void)pVtab;
  for(i=0; i<pIdx->nConstraint; i++){
    const struct sqlite3_index_constraint *c = &pIdx->aConstraint[i];
    if( !c->usable ) continue;
    if( c->op!=SQLITE_INDEX_CONSTRAINT_EQ ) continue;
    switch( c->iColumn ){
      case RHVEC_SCOL_TABLE:  iTbl=i; break;
      case RHVEC_SCOL_COLUMN: iCol=i; break;
      case RHVEC_SCOL_QUERY:  iQuery=i; break;
      case RHVEC_SCOL_K:      iK=i; break;
    }
  }
  if( iTbl<0 || iCol<0 || iQuery<0 ) return SQLITE_CONSTRAINT;
  pIdx->aConstraintUsage[iTbl].argvIndex = ++argc;
  pIdx->aConstraintUsage[iTbl].omit = 1;
  pIdx->aConstraintUsage[iCol].argvIndex = ++argc;
  pIdx->aConstraintUsage[iCol].omit = 1;
  pIdx->aConstraintUsage[iQuery].argvIndex = ++argc;
  pIdx->aConstraintUsage[iQuery].omit = 1;
  if( iK>=0 ){
    pIdx->aConstraintUsage[iK].argvIndex = ++argc;
    pIdx->aConstraintUsage[iK].omit = 1;
    pIdx->idxNum = 1;
  }else{
    pIdx->idxNum = 0;
  }
  pIdx->estimatedCost = 1.0e6;
  pIdx->estimatedRows = 1000;
  return SQLITE_OK;
}

static int rhvecScanOpen(sqlite3_vtab *pVtab, sqlite3_vtab_cursor **ppCur){
  RhvecScanCursor *pCur;
  (void)pVtab;
  pCur = (RhvecScanCursor*)sqlite3_malloc64(sizeof(*pCur));
  if( pCur==0 ) return SQLITE_NOMEM;
  memset(pCur, 0, sizeof(*pCur));
  *ppCur = &pCur->base;
  return SQLITE_OK;
}

static int rhvecScanClose(sqlite3_vtab_cursor *pCur){
  RhvecScanCursor *c = (RhvecScanCursor*)pCur;
  sqlite3_free(c->aRes);
  sqlite3_free(c);
  return SQLITE_OK;
}

/* Grow the result array and append one match. */
static int rhvecPush(
  RhvecScanCursor *c,
  sqlite3_int64 rowid,
  double dist,
  double order
){
  if( c->nRes>=c->nAlloc ){
    int nNew = c->nAlloc ? c->nAlloc*2 : 64;
    RhvecMatch *aNew = (RhvecMatch*)sqlite3_realloc64(
      c->aRes, (sqlite3_int64)sizeof(RhvecMatch)*nNew
    );
    if( aNew==0 ) return SQLITE_NOMEM;
    c->aRes = aNew;
    c->nAlloc = nNew;
  }
  c->aRes[c->nRes].rowid = rowid;
  c->aRes[c->nRes].distance = dist;
  c->aRes[c->nRes].order = order;
  c->nRes++;
  return SQLITE_OK;
}

static int rhvecCmpOrder(const void *pa, const void *pb){
  const RhvecMatch *a = (const RhvecMatch*)pa;
  const RhvecMatch *b = (const RhvecMatch*)pb;
  if( a->order < b->order ) return -1;
  if( a->order > b->order ) return 1;
  if( a->rowid < b->rowid ) return -1;
  if( a->rowid > b->rowid ) return 1;
  return 0;
}

/* Ensure the result array can hold n matches. */
static int rhvecReserve(RhvecScanCursor *c, int n){
  RhvecMatch *a;
  if( c->nAlloc>=n ) return SQLITE_OK;
  a = (RhvecMatch*)sqlite3_realloc64(c->aRes, (sqlite3_int64)sizeof(RhvecMatch)*n);
  if( a==0 ) return SQLITE_NOMEM;
  c->aRes = a;
  c->nAlloc = n;
  return SQLITE_OK;
}

/* Max-heap (root = largest order) sift-down over the first n entries. */
static void rhvecSiftDown(RhvecMatch *a, int n, int i){
  for(;;){
    int l = 2*i+1, r = 2*i+2, m = i;
    if( l<n && a[l].order>a[m].order ) m = l;
    if( r<n && a[r].order>a[m].order ) m = r;
    if( m==i ) break;
    { RhvecMatch t = a[i]; a[i] = a[m]; a[m] = t; }
    i = m;
  }
}

/*
** Offer one match to a bounded top-`limit` selection (the `limit` smallest by
** order). Keeps a size-`limit` max-heap in aRes so the whole scan is
** O(N log limit) time and O(limit) memory instead of collect-all + sort.
** Caller must rhvecReserve(limit) first.
*/
static void rhvecOffer(
  RhvecScanCursor *c,
  int limit,
  sqlite3_int64 rowid,
  double dist,
  double order
){
  if( limit<=0 ) return;
  if( c->nRes<limit ){
    c->aRes[c->nRes].rowid = rowid;
    c->aRes[c->nRes].distance = dist;
    c->aRes[c->nRes].order = order;
    c->nRes++;
    if( c->nRes==limit ){
      int i;
      for(i=limit/2-1; i>=0; i--) rhvecSiftDown(c->aRes, limit, i);
    }
    return;
  }
  if( order < c->aRes[0].order ){
    c->aRes[0].rowid = rowid;
    c->aRes[0].distance = dist;
    c->aRes[0].order = order;
    rhvecSiftDown(c->aRes, limit, 0);
  }
}

/*
** Exact metric between a query and one candidate, computed in a single pass
** with the query norm precomputed once (qnorm2) — avoids recomputing it per
** row for cosine, and uses ||a-b||^2 = ||a||^2 + ||b||^2 - 2<a,b> so L2 needs
** only one dot+norm pass. Sets *pDist (natural value) and *pOrder (smaller =
** nearer; negated for DOT).
*/
static void rhvecScanScore(
  RhvecMetric metric,
  const float *q,
  double qnorm2,
  const float *r,
  int n,
  double *pDist,
  double *pOrder
){
  int i;
  switch( metric ){
    case RHVEC_DOT: {
      double dp = 0.0;
      for(i=0; i<n; i++) dp += (double)q[i]*r[i];
      *pDist = dp; *pOrder = -dp; return;
    }
    case RHVEC_COSINE: {
      double dp = 0.0, rn = 0.0, cd;
      for(i=0; i<n; i++){ dp += (double)q[i]*r[i]; rn += (double)r[i]*r[i]; }
      cd = (qnorm2>0.0 && rn>0.0) ? 1.0 - dp/(sqrt(qnorm2)*sqrt(rn)) : 1.0;
      *pDist = cd; *pOrder = cd; return;
    }
    case RHVEC_SQUARED_L2:
    case RHVEC_L2: {
      double dp = 0.0, rn = 0.0, sq;
      for(i=0; i<n; i++){ dp += (double)q[i]*r[i]; rn += (double)r[i]*r[i]; }
      sq = qnorm2 + rn - 2.0*dp;
      if( sq<0.0 ) sq = 0.0;
      if( metric==RHVEC_L2 ) sq = sqrt(sq);
      *pDist = sq; *pOrder = sq; return;
    }
    default: {  /* L1 / HAMMING: own pass */
      *pDist = rhvecDistanceF32(metric, q, r, n);
      *pOrder = *pDist;
      return;
    }
  }
}

/* Estimate (dist, order) for the quantized scan from <Pi q, dequant(code)>. */
static void rhvecEstFromDot(
  RhvecMetric metric,
  double scale,
  double dotUnit,
  double qnorm,
  double qnorm2,
  double *pDist,
  double *pOrder
){
  switch( metric ){
    case RHVEC_COSINE: {
      double cd = (qnorm>0.0) ? 1.0 - dotUnit/qnorm : 1.0;
      *pDist = cd; *pOrder = cd; return;
    }
    case RHVEC_SQUARED_L2:
    case RHVEC_L2: {
      double sq = qnorm2 + scale*scale - 2.0*scale*dotUnit;
      if( sq<0.0 ) sq = 0.0;
      if( metric==RHVEC_L2 ) sq = sqrt(sq);
      *pDist = sq; *pOrder = sq; return;
    }
    default: {  /* DOT */
      double est = scale*dotUnit;
      *pDist = est; *pOrder = -est; return;
    }
  }
}

/* Decode the query value (BLOB in the config type, or JSON text) into nDim
** floats. On error sets *pzErr (sqlite3_mprintf) and returns SQLITE_ERROR. */
static int rhvecDecodeQuery(
  const RhvecConfig *pCfg,
  sqlite3_value *pVal,
  float *aOut,
  char **pzErr
){
  int t = sqlite3_value_type(pVal);
  if( t==SQLITE_BLOB ){
    const void *p = sqlite3_value_blob(pVal);
    sqlite3_int64 nb = sqlite3_value_bytes(pVal);
    int d = rhvecDimFromBytes(pCfg->type, nb);
    if( d!=pCfg->nDim ){
      *pzErr = sqlite3_mprintf(
        "query dimension %d != configured %d", d, pCfg->nDim);
      return SQLITE_ERROR;
    }
    rhvecDecodeToF32(pCfg->type, p, nb, pCfg->nDim, aOut);
    return SQLITE_OK;
  }
  if( t==SQLITE_TEXT ){
    const char *zText = (const char*)sqlite3_value_text(pVal);
    int nText = sqlite3_value_bytes(pVal);
    double *a = 0;
    int n = 0, i;
    int rc = rhvecParseJsonArray(zText, nText, &a, &n);
    if( rc==SQLITE_OK ){
      /* A literal vector written as a JSON array of numbers. */
      if( n!=pCfg->nDim ){
        sqlite3_free(a);
        *pzErr = sqlite3_mprintf(
          "query length %d != configured %d", n, pCfg->nDim);
        return SQLITE_ERROR;
      }
      for(i=0; i<n; i++) aOut[i] = (float)a[i];
      sqlite3_free(a);
      return SQLITE_OK;
    }
    /* Not a JSON array: treat the text as a natural-language search phrase and
    ** embed it via the host on-device model. This is what makes
    ** vector_search('product','name','dogs',k) work — and a friendly superset
    ** for the other scans. */
    {
      int erc = analyst_embed_query(zText, nText, aOut, pCfg->nDim);
      if( erc==0 ) return SQLITE_OK;
      if( erc==1 ){
        *pzErr = sqlite3_mprintf(
          "semantic query embedding unavailable (on-device model not warmed up)");
      }else{
        *pzErr = sqlite3_mprintf("semantic query embedding failed (code %d)", erc);
      }
      return SQLITE_ERROR;
    }
  }
  *pzErr = sqlite3_mprintf("query must be a BLOB, JSON array, or search phrase");
  return SQLITE_ERROR;
}

static int rhvecScanFilter(
  sqlite3_vtab_cursor *pCur,
  int idxNum,
  const char *idxStr,
  int argc,
  sqlite3_value **argv
){
  RhvecScanCursor *c = (RhvecScanCursor*)pCur;
  RhvecScanVtab *vt = (RhvecScanVtab*)pCur->pVtab;
  sqlite3 *db = vt->db;
  RhvecConfig cfg;
  const char *zTbl, *zCol;
  int k = -1, i;
  double qnorm2 = 0.0;
  float *qF = 0, *rowF = 0;
  char *zSql = 0;
  sqlite3_stmt *pStmt = 0;
  char *zErr = 0;
  int rc;
  (void)idxStr;
  (void)argc;

  c->nRes = 0;
  c->iRow = 0;

  zTbl = (const char*)sqlite3_value_text(argv[0]);
  zCol = (const char*)sqlite3_value_text(argv[1]);
  if( idxNum & 1 ) k = sqlite3_value_int(argv[3]);

  rc = rhvecConfigLookup(db, zTbl, zCol, &cfg);
  if( rc==SQLITE_NOTFOUND ){
    vt->base.zErrMsg = sqlite3_mprintf(
      "vector_full_scan: no vector_init for \"%s\".\"%s\"", zTbl, zCol);
    return SQLITE_ERROR;
  }
  if( rc!=SQLITE_OK ) return rc;

  qF = (float*)sqlite3_malloc64((sqlite3_int64)sizeof(float)*(cfg.nDim>0?cfg.nDim:1));
  rowF = (float*)sqlite3_malloc64((sqlite3_int64)sizeof(float)*(cfg.nDim>0?cfg.nDim:1));
  if( qF==0 || rowF==0 ){ rc = SQLITE_NOMEM; goto done; }

  rc = rhvecDecodeQuery(&cfg, argv[2], qF, &zErr);
  if( rc!=SQLITE_OK ){ vt->base.zErrMsg = zErr; goto done; }
  for(i=0; i<cfg.nDim; i++) qnorm2 += (double)qF[i]*qF[i];

  /* Top-k mode: pre-size the result array to k and keep a bounded heap. */
  if( k>=0 ){
    rc = rhvecReserve(c, k>0 ? k : 1);
    if( rc!=SQLITE_OK ) goto done;
  }

  zSql = sqlite3_mprintf("SELECT rowid, \"%w\" FROM \"%w\"", zCol, zTbl);
  if( zSql==0 ){ rc = SQLITE_NOMEM; goto done; }
  rc = sqlite3_prepare_v2(db, zSql, -1, &pStmt, 0);
  if( rc!=SQLITE_OK ){
    vt->base.zErrMsg = sqlite3_mprintf("%s", sqlite3_errmsg(db));
    goto done;
  }

  while( sqlite3_step(pStmt)==SQLITE_ROW ){
    sqlite3_int64 rowid;
    const void *pv;
    sqlite3_int64 nb;
    int d;
    double dist, order;
    if( sqlite3_column_type(pStmt,1)==SQLITE_NULL ) continue;
    rowid = sqlite3_column_int64(pStmt, 0);
    nb = sqlite3_column_bytes(pStmt, 1);
    pv = sqlite3_column_blob(pStmt, 1);
    d = rhvecDimFromBytes(cfg.type, nb);
    if( d!=cfg.nDim ) continue;   /* skip rows whose vector doesn't fit */
    rhvecDecodeToF32(cfg.type, pv, nb, cfg.nDim, rowF);
    rhvecScanScore(cfg.metric, qF, qnorm2, rowF, cfg.nDim, &dist, &order);
    if( k>=0 ){
      rhvecOffer(c, k, rowid, dist, order);
    }else{
      rc = rhvecPush(c, rowid, dist, order);
      if( rc!=SQLITE_OK ) goto done;
    }
  }

  /* The heap leaves the k results unordered; sort the (small) result set. */
  if( k>=0 ) qsort(c->aRes, c->nRes, sizeof(RhvecMatch), rhvecCmpOrder);
  rc = SQLITE_OK;

done:
  if( pStmt ) sqlite3_finalize(pStmt);
  sqlite3_free(zSql);
  sqlite3_free(qF);
  sqlite3_free(rowF);
  return rc;
}

/*
** vector_quantize_scan: approximate KNN over the TurboQuant store. The
** quantized pass estimates the metric from <Pi q, dequant(code)> and keeps the
** k*OVERSAMPLE best candidates in a bounded heap; those are then reranked with
** the exact base-table vectors and the true top-k returned. Reads the
** preloaded in-memory set when present, else the shadow table. Supports
** l2 / squared_l2 / cosine / dot.
*/
static int rhvecQuantScanFilter(
  sqlite3_vtab_cursor *pCur,
  int idxNum,
  const char *idxStr,
  int argc,
  sqlite3_value **argv
){
  RhvecScanCursor *c = (RhvecScanCursor*)pCur;
  RhvecScanVtab *vt = (RhvecScanVtab*)pCur->pVtab;
  sqlite3 *db = vt->db;
  RhvecConfig cfg;
  RhvecQuantMeta meta;
  RhvecQuantSet set;
  const char *zTbl, *zCol;
  int k = -1, i, haveCache, codeBytes, mCand;
  double qnorm = 0.0, qnorm2 = 0.0, invSqrtD;
  float *qF = 0, *qr = 0, *yUnit = 0, *rowF = 0, *Pi = 0;
  float aLevels[256];
  char *zErr = 0, *zSql = 0;
  char *zMapTbl = 0, *zMapCol = 0;
  sqlite3_stmt *pStmt = 0, *pRr = 0;
  int rc;
  (void)idxStr;
  (void)argc;

  c->nRes = 0;
  c->iRow = 0;
  zTbl = (const char*)sqlite3_value_text(argv[0]);
  zCol = (const char*)sqlite3_value_text(argv[1]);
  if( idxNum & 1 ) k = sqlite3_value_int(argv[3]);

  /* vector_search: (zTbl,zCol) name the user-facing TEXT column; resolve to the
  ** storage sidecar that actually holds the vectors. The other modules pass
  ** the storage (tbl,col) directly. */
  if( vt->isSearch ){
    rc = rhvecSearchMapLookup(db, zTbl, zCol, &zMapTbl, &zMapCol);
    if( rc==SQLITE_NOTFOUND ){
      vt->base.zErrMsg = sqlite3_mprintf(
        "vector_search: no semantic index for \"%s\".\"%s\" (run the indexer)",
        zTbl, zCol);
      return SQLITE_ERROR;
    }
    if( rc!=SQLITE_OK ) return rc;
    zTbl = zMapTbl;
    zCol = zMapCol;
  }

  rc = rhvecConfigLookup(db, zTbl, zCol, &cfg);
  if( rc==SQLITE_NOTFOUND ){
    vt->base.zErrMsg = sqlite3_mprintf(
      "vector_quantize_scan: no vector_init for \"%s\".\"%s\"", zTbl, zCol);
    rc = SQLITE_ERROR;
    goto done;
  }
  if( rc!=SQLITE_OK ) goto done;
  if( rhvecQuantMetaLookup(db, zTbl, zCol, &meta)!=SQLITE_OK ){
    vt->base.zErrMsg = sqlite3_mprintf(
      "vector_quantize_scan: \"%s\".\"%s\" is not quantized (call vector_quantize)",
      zTbl, zCol);
    rc = SQLITE_ERROR;
    goto done;
  }
  if( cfg.metric==RHVEC_L1 || cfg.metric==RHVEC_HAMMING ){
    vt->base.zErrMsg = sqlite3_mprintf(
      "vector_quantize_scan: only l2/squared_l2/cosine/dot are supported");
    rc = SQLITE_ERROR;
    goto done;
  }

  codeBytes = rhvecQuantCodeBytes(meta.nDim, meta.qbits);
  invSqrtD = 1.0/sqrt((double)(meta.nDim>0 ? meta.nDim : 1));
  rhvecCodebook(meta.qbits, aLevels);

  qF = (float*)sqlite3_malloc64((sqlite3_int64)sizeof(float)*(cfg.nDim>0?cfg.nDim:1));
  qr = (float*)sqlite3_malloc64((sqlite3_int64)sizeof(float)*(cfg.nDim>0?cfg.nDim:1));
  yUnit = (float*)sqlite3_malloc64((sqlite3_int64)sizeof(float)*(cfg.nDim>0?cfg.nDim:1));
  rowF = (float*)sqlite3_malloc64((sqlite3_int64)sizeof(float)*(cfg.nDim>0?cfg.nDim:1));
  Pi = rhvecBuildRotation(meta.seed, meta.nDim);
  if( qF==0 || qr==0 || yUnit==0 || rowF==0 || Pi==0 ){ rc = SQLITE_NOMEM; goto done; }

  rc = rhvecDecodeQuery(&cfg, argv[2], qF, &zErr);
  if( rc!=SQLITE_OK ){ vt->base.zErrMsg = zErr; goto done; }
  for(i=0; i<cfg.nDim; i++) qnorm2 += (double)qF[i]*qF[i];
  qnorm = sqrt(qnorm2);
  rhvecRotate(Pi, cfg.nDim, qF, qr);   /* rotate the query once (O(d^2)) */

  /* candidate budget: with k, keep the k*OVERSAMPLE nearest by estimate. */
  mCand = (k>=0) ? (k>0 ? k*RHVEC_RERANK_OVERSAMPLE : 1) : -1;
  if( mCand>=0 ){
    rc = rhvecReserve(c, mCand);
    if( rc!=SQLITE_OK ) goto done;
  }

  haveCache = rhvecQuantCacheGet(zTbl, zCol, &set);
  if( haveCache ){
    for(i=0; i<set.nRows; i++){
      const unsigned char *code = set.aCode + (sqlite3_int64)i*set.codeBytes;
      double dotUnit = 0.0, distEst, orderEst;
      int j;
      rhvecDequantUnit(code, cfg.nDim, meta.qbits, aLevels, (float)invSqrtD, yUnit);
      for(j=0; j<cfg.nDim; j++) dotUnit += (double)qr[j]*yUnit[j];
      rhvecEstFromDot(cfg.metric, set.aScale[i], dotUnit, qnorm, qnorm2,
                      &distEst, &orderEst);
      if( mCand>=0 ){
        rhvecOffer(c, mCand, set.aRowid[i], distEst, orderEst);
      }else{
        rc = rhvecPush(c, set.aRowid[i], distEst, orderEst);
        if( rc!=SQLITE_OK ) goto done;
      }
    }
  }else{
    rc = sqlite3_prepare_v2(db,
      "SELECT rid, scale, code FROM " RHVEC_QUANT_TABLE
      " WHERE tbl=?1 AND col=?2", -1, &pStmt, 0);
    if( rc!=SQLITE_OK ){ vt->base.zErrMsg = sqlite3_mprintf("%s", sqlite3_errmsg(db)); goto done; }
    sqlite3_bind_text(pStmt, 1, zTbl, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(pStmt, 2, zCol, -1, SQLITE_TRANSIENT);
    while( sqlite3_step(pStmt)==SQLITE_ROW ){
      sqlite3_int64 rowid = sqlite3_column_int64(pStmt, 0);
      double scale = sqlite3_column_double(pStmt, 1);
      const unsigned char *code = (const unsigned char*)sqlite3_column_blob(pStmt, 2);
      int nc = sqlite3_column_bytes(pStmt, 2);
      double dotUnit = 0.0, distEst, orderEst;
      int j;
      if( code==0 || nc<codeBytes ) continue;
      rhvecDequantUnit(code, cfg.nDim, meta.qbits, aLevels, (float)invSqrtD, yUnit);
      for(j=0; j<cfg.nDim; j++) dotUnit += (double)qr[j]*yUnit[j];
      rhvecEstFromDot(cfg.metric, scale, dotUnit, qnorm, qnorm2, &distEst, &orderEst);
      if( mCand>=0 ){
        rhvecOffer(c, mCand, rowid, distEst, orderEst);
      }else{
        rc = rhvecPush(c, rowid, distEst, orderEst);
        if( rc!=SQLITE_OK ) goto done;
      }
    }
    sqlite3_finalize(pStmt);
    pStmt = 0;
  }

  /* Rerank the candidate set with the exact base-table vectors. */
  if( k>=0 ){
    zSql = sqlite3_mprintf("SELECT \"%w\" FROM \"%w\" WHERE rowid=?1", zCol, zTbl);
    if( zSql==0 ){ rc = SQLITE_NOMEM; goto done; }
    rc = sqlite3_prepare_v2(db, zSql, -1, &pRr, 0);
    if( rc!=SQLITE_OK ){ vt->base.zErrMsg = sqlite3_mprintf("%s", sqlite3_errmsg(db)); goto done; }
    for(i=0; i<c->nRes; i++){
      double dist = 1.0e300;
      sqlite3_reset(pRr);
      sqlite3_bind_int64(pRr, 1, c->aRes[i].rowid);
      if( sqlite3_step(pRr)==SQLITE_ROW && sqlite3_column_type(pRr,0)!=SQLITE_NULL ){
        const void *pv = sqlite3_column_blob(pRr, 0);
        sqlite3_int64 nb = sqlite3_column_bytes(pRr, 0);
        if( rhvecDimFromBytes(cfg.type, nb)==cfg.nDim ){
          rhvecDecodeToF32(cfg.type, pv, nb, cfg.nDim, rowF);
          dist = rhvecDistanceF32(cfg.metric, qF, rowF, cfg.nDim);
        }
      }
      c->aRes[i].distance = dist;
      c->aRes[i].order = (cfg.metric==RHVEC_DOT) ? -dist : dist;
    }
    qsort(c->aRes, c->nRes, sizeof(RhvecMatch), rhvecCmpOrder);
    if( c->nRes>k ) c->nRes = k;
  }
  rc = SQLITE_OK;

done:
  if( pStmt ) sqlite3_finalize(pStmt);
  if( pRr ) sqlite3_finalize(pRr);
  sqlite3_free(zSql);
  sqlite3_free(qF);
  sqlite3_free(qr);
  sqlite3_free(yUnit);
  sqlite3_free(rowF);
  sqlite3_free(Pi);
  sqlite3_free(zMapTbl);
  sqlite3_free(zMapCol);
  return rc;
}

static int rhvecScanNext(sqlite3_vtab_cursor *pCur){
  ((RhvecScanCursor*)pCur)->iRow++;
  return SQLITE_OK;
}

static int rhvecScanEof(sqlite3_vtab_cursor *pCur){
  RhvecScanCursor *c = (RhvecScanCursor*)pCur;
  return c->iRow >= c->nRes;
}

static int rhvecScanColumn(
  sqlite3_vtab_cursor *pCur,
  sqlite3_context *ctx,
  int iCol
){
  RhvecScanCursor *c = (RhvecScanCursor*)pCur;
  const RhvecMatch *m = &c->aRes[c->iRow];
  switch( iCol ){
    case RHVEC_SCOL_ROWID:    sqlite3_result_int64(ctx, m->rowid); break;
    case RHVEC_SCOL_DISTANCE: sqlite3_result_double(ctx, m->distance); break;
    default:                  sqlite3_result_null(ctx); break;
  }
  return SQLITE_OK;
}

static int rhvecScanRowid(sqlite3_vtab_cursor *pCur, sqlite3_int64 *pRowid){
  *pRowid = ((RhvecScanCursor*)pCur)->iRow + 1;
  return SQLITE_OK;
}

static sqlite3_module rhvecFullScanModule = {
  /* iVersion    */ 0,
  /* xCreate     */ 0,           /* eponymous-only: used as a function */
  /* xConnect    */ rhvecScanConnect,
  /* xBestIndex  */ rhvecScanBestIndex,
  /* xDisconnect */ rhvecScanDisconnect,
  /* xDestroy    */ 0,
  /* xOpen       */ rhvecScanOpen,
  /* xClose      */ rhvecScanClose,
  /* xFilter     */ rhvecScanFilter,
  /* xNext       */ rhvecScanNext,
  /* xEof        */ rhvecScanEof,
  /* xColumn     */ rhvecScanColumn,
  /* xRowid      */ rhvecScanRowid,
  /* xUpdate     */ 0,
  /* xBegin      */ 0,
  /* xSync       */ 0,
  /* xCommit     */ 0,
  /* xRollback   */ 0,
  /* xFindFunction*/ 0,
  /* xRename     */ 0,
  /* xSavepoint  */ 0,
  /* xRelease    */ 0,
  /* xRollbackTo */ 0,
  /* xShadowName */ 0,
  /* xIntegrity  */ 0
};

/* Same shape as full scan; only xFilter differs (quantized + rerank). */
static sqlite3_module rhvecQuantScanModule = {
  /* iVersion    */ 0,
  /* xCreate     */ 0,
  /* xConnect    */ rhvecScanConnect,
  /* xBestIndex  */ rhvecScanBestIndex,
  /* xDisconnect */ rhvecScanDisconnect,
  /* xDestroy    */ 0,
  /* xOpen       */ rhvecScanOpen,
  /* xClose      */ rhvecScanClose,
  /* xFilter     */ rhvecQuantScanFilter,
  /* xNext       */ rhvecScanNext,
  /* xEof        */ rhvecScanEof,
  /* xColumn     */ rhvecScanColumn,
  /* xRowid      */ rhvecScanRowid,
  /* xUpdate     */ 0,
  /* xBegin      */ 0,
  /* xSync       */ 0,
  /* xCommit     */ 0,
  /* xRollback   */ 0,
  /* xFindFunction*/ 0,
  /* xRename     */ 0,
  /* xSavepoint  */ 0,
  /* xRelease    */ 0,
  /* xRollbackTo */ 0,
  /* xShadowName */ 0,
  /* xIntegrity  */ 0
};

int rhvecRegisterScanModules(sqlite3 *db){
  int rc = sqlite3_create_module(db, "vector_full_scan", &rhvecFullScanModule, 0);
  if( rc==SQLITE_OK ){
    rc = sqlite3_create_module(db, "vector_quantize_scan", &rhvecQuantScanModule, 0);
  }
  /* vector_search shares the quantized-scan module but registers with a
  ** non-NULL pAux so xConnect flags it (isSearch): its (tbl,col) call args are
  ** the user-facing text column, resolved through _rhvec_search_map, and a TEXT
  ** query is embedded on the fly via the host model. */
  if( rc==SQLITE_OK ){
    rc = sqlite3_create_module(db, "vector_search", &rhvecQuantScanModule, (void*)1);
  }
  return rc;
}
