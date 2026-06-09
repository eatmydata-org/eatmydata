/*
** rh vector-search extension — distance metrics implementation.
**
** Clean-room (see vector.h). Scalar kernels; accumulation is in double so the
** result matches a straightforward reference implementation to float precision.
*/
#include "sqlite3.h"
#include "vec-distance.h"
#include "vec-types.h"

#include <math.h>
#include <stdint.h>

int rhvecParseMetric(const char *z, RhvecMetric *pMetric){
  if( z==0 ) return SQLITE_ERROR;
  if( sqlite3_stricmp(z,"l2")==0 || sqlite3_stricmp(z,"euclidean")==0 ){
    *pMetric = RHVEC_L2;
  }else if( sqlite3_stricmp(z,"squared_l2")==0 || sqlite3_stricmp(z,"l2sq")==0 ){
    *pMetric = RHVEC_SQUARED_L2;
  }else if( sqlite3_stricmp(z,"cosine")==0 ){
    *pMetric = RHVEC_COSINE;
  }else if( sqlite3_stricmp(z,"dot")==0 || sqlite3_stricmp(z,"inner")==0 ){
    *pMetric = RHVEC_DOT;
  }else if( sqlite3_stricmp(z,"l1")==0 || sqlite3_stricmp(z,"manhattan")==0 ){
    *pMetric = RHVEC_L1;
  }else if( sqlite3_stricmp(z,"hamming")==0 ){
    *pMetric = RHVEC_HAMMING;
  }else{
    return SQLITE_ERROR;
  }
  return SQLITE_OK;
}

const char *rhvecMetricName(RhvecMetric m){
  switch( m ){
    case RHVEC_L2:         return "l2";
    case RHVEC_SQUARED_L2: return "squared_l2";
    case RHVEC_COSINE:     return "cosine";
    case RHVEC_DOT:        return "dot";
    case RHVEC_L1:         return "l1";
    case RHVEC_HAMMING:    return "hamming";
  }
  return "?";
}

double rhvecDistanceF32(RhvecMetric metric, const float *a, const float *b, int n){
  int i;
  switch( metric ){
    case RHVEC_DOT: {
      double s = 0.0;
      for(i=0; i<n; i++) s += (double)a[i] * (double)b[i];
      return s;
    }
    case RHVEC_SQUARED_L2: {
      double s = 0.0;
      for(i=0; i<n; i++){
        double d = (double)a[i] - (double)b[i];
        s += d*d;
      }
      return s;
    }
    case RHVEC_L2: {
      double s = 0.0;
      for(i=0; i<n; i++){
        double d = (double)a[i] - (double)b[i];
        s += d*d;
      }
      return sqrt(s);
    }
    case RHVEC_L1: {
      double s = 0.0;
      for(i=0; i<n; i++) s += fabs((double)a[i] - (double)b[i]);
      return s;
    }
    case RHVEC_HAMMING: {
      double s = 0.0;
      for(i=0; i<n; i++) if( a[i]!=b[i] ) s += 1.0;
      return s;
    }
    case RHVEC_COSINE: {
      double dot = 0.0, na = 0.0, nb = 0.0;
      for(i=0; i<n; i++){
        dot += (double)a[i] * (double)b[i];
        na  += (double)a[i] * (double)a[i];
        nb  += (double)b[i] * (double)b[i];
      }
      if( na==0.0 || nb==0.0 ) return 1.0;
      return 1.0 - dot/(sqrt(na)*sqrt(nb));
    }
  }
  return 0.0;
}

/*
** vector_distance(a BLOB, b BLOB, type TEXT, metric TEXT) -> REAL
**
** Decodes both blobs as `type` and returns the `metric` between them. A
** convenience for brute-force search via plain SQL
** (ORDER BY vector_distance(col, :q, 'f32', 'cosine') LIMIT k) and the test
** surface for the kernels; the scan virtual tables share the same kernels.
*/
static void rhvecDistanceFunc(
  sqlite3_context *ctx,
  int argc,
  sqlite3_value **argv
){
  RhvecType type;
  RhvecMetric metric;
  const void *pa, *pb;
  sqlite3_int64 na, nb;
  int dim, dimB;
  float *aF, *bF;
  double result;
  (void)argc;

  if( sqlite3_value_type(argv[0])==SQLITE_NULL
   || sqlite3_value_type(argv[1])==SQLITE_NULL ){
    sqlite3_result_null(ctx);
    return;
  }
  if( rhvecParseType((const char*)sqlite3_value_text(argv[2]), &type)!=SQLITE_OK ){
    sqlite3_result_error(ctx, "vector_distance: unknown vector type", -1);
    return;
  }
  if( rhvecParseMetric((const char*)sqlite3_value_text(argv[3]), &metric)!=SQLITE_OK ){
    sqlite3_result_error(ctx, "vector_distance: unknown metric", -1);
    return;
  }
  na = sqlite3_value_bytes(argv[0]);
  nb = sqlite3_value_bytes(argv[1]);
  pa = sqlite3_value_blob(argv[0]);
  pb = sqlite3_value_blob(argv[1]);
  dim  = rhvecDimFromBytes(type, na);
  dimB = rhvecDimFromBytes(type, nb);
  if( dim<0 || dimB<0 ){
    sqlite3_result_error(ctx, "vector_distance: malformed vector blob", -1);
    return;
  }
  if( dim!=dimB || na!=nb ){
    sqlite3_result_error(ctx, "vector_distance: dimension mismatch", -1);
    return;
  }
  aF = (float*)sqlite3_malloc64((sqlite3_int64)sizeof(float)*(dim>0?dim:1));
  bF = (float*)sqlite3_malloc64((sqlite3_int64)sizeof(float)*(dim>0?dim:1));
  if( aF==0 || bF==0 ){
    sqlite3_free(aF);
    sqlite3_free(bF);
    sqlite3_result_error_nomem(ctx);
    return;
  }
  rhvecDecodeToF32(type, pa, na, dim, aF);
  rhvecDecodeToF32(type, pb, nb, dim, bF);
  result = rhvecDistanceF32(metric, aF, bF, dim);
  sqlite3_free(aF);
  sqlite3_free(bF);
  sqlite3_result_double(ctx, result);
}

int rhvecRegisterDistanceFuncs(sqlite3 *db){
  return sqlite3_create_function(
    db, "vector_distance", 4,
    SQLITE_UTF8 | SQLITE_DETERMINISTIC | SQLITE_INNOCUOUS,
    0, rhvecDistanceFunc, 0, 0
  );
}
