/*
** rh vector-search extension — per-column configuration implementation.
**
** Clean-room (see vector.h). SQLite conventions: sqlite3_malloc/str/mprintf,
** prepared statements, public API only.
*/
#include "sqlite3.h"
#include "vec-config.h"
#include "vec-types.h"
#include "vec-distance.h"

#include <stdlib.h>
#include <string.h>

#define RHVEC_CONFIG_TABLE "_rhvec_config"
#define RHVEC_SEARCH_MAP_TABLE "_rhvec_search_map"

static int rhvecIsSpace(char c){
  return c==' ' || c=='\t' || c=='\n' || c=='\r';
}

int rhvecNextOption(const char **pz, char *zKey, int nKey, char *zVal, int nVal){
  const char *z = *pz;
  int i;
  zKey[0] = 0;
  zVal[0] = 0;
  while( *z && (rhvecIsSpace(*z) || *z==',') ) z++;
  if( *z==0 ){ *pz = z; return 0; }
  /* key: up to '=' or ',' or end */
  i = 0;
  while( *z && *z!='=' && *z!=',' ){
    if( i<nKey-1 ) zKey[i++] = *z;
    z++;
  }
  /* trim trailing space on key */
  while( i>0 && rhvecIsSpace(zKey[i-1]) ) i--;
  zKey[i] = 0;
  if( *z=='=' ){
    z++;
    while( *z && rhvecIsSpace(*z) ) z++;
    i = 0;
    while( *z && *z!=',' ){
      if( i<nVal-1 ) zVal[i++] = *z;
      z++;
    }
    while( i>0 && rhvecIsSpace(zVal[i-1]) ) i--;
    zVal[i] = 0;
  }
  *pz = z;
  return 1;
}

int rhvecConfigEnsureTable(sqlite3 *db){
  return sqlite3_exec(
    db,
    "CREATE TABLE IF NOT EXISTS " RHVEC_CONFIG_TABLE
    "(tbl TEXT NOT NULL, col TEXT NOT NULL, dim INTEGER NOT NULL,"
    " vtype TEXT NOT NULL, metric TEXT NOT NULL, PRIMARY KEY(tbl,col))",
    0, 0, 0
  );
}

int rhvecConfigLookup(
  sqlite3 *db,
  const char *zTbl,
  const char *zCol,
  RhvecConfig *pCfg
){
  sqlite3_stmt *pStmt = 0;
  int rc;
  rc = sqlite3_prepare_v2(
    db,
    "SELECT dim, vtype, metric FROM " RHVEC_CONFIG_TABLE
    " WHERE tbl=?1 AND col=?2",
    -1, &pStmt, 0
  );
  if( rc!=SQLITE_OK ){
    /* Most likely the config table does not exist yet: nothing configured. */
    sqlite3_finalize(pStmt);
    return SQLITE_NOTFOUND;
  }
  sqlite3_bind_text(pStmt, 1, zTbl, -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(pStmt, 2, zCol, -1, SQLITE_TRANSIENT);
  rc = sqlite3_step(pStmt);
  if( rc==SQLITE_ROW ){
    const char *zType = (const char*)sqlite3_column_text(pStmt, 1);
    const char *zMetric = (const char*)sqlite3_column_text(pStmt, 2);
    pCfg->nDim = sqlite3_column_int(pStmt, 0);
    if( rhvecParseType(zType, &pCfg->type)!=SQLITE_OK
     || rhvecParseMetric(zMetric, &pCfg->metric)!=SQLITE_OK ){
      sqlite3_finalize(pStmt);
      return SQLITE_ERROR;
    }
    sqlite3_finalize(pStmt);
    return SQLITE_OK;
  }
  sqlite3_finalize(pStmt);
  return SQLITE_NOTFOUND;
}

int rhvecSearchMapLookup(
  sqlite3 *db,
  const char *zBaseTbl,
  const char *zBaseCol,
  char **pzStoreTbl,
  char **pzStoreCol
){
  sqlite3_stmt *pStmt = 0;
  int rc;
  *pzStoreTbl = 0;
  *pzStoreCol = 0;
  rc = sqlite3_prepare_v2(
    db,
    "SELECT store_tbl, store_col FROM " RHVEC_SEARCH_MAP_TABLE
    " WHERE base_tbl=?1 AND base_col=?2",
    -1, &pStmt, 0
  );
  if( rc!=SQLITE_OK ){
    /* Most likely the map table does not exist yet: nothing indexed. */
    sqlite3_finalize(pStmt);
    return SQLITE_NOTFOUND;
  }
  sqlite3_bind_text(pStmt, 1, zBaseTbl, -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(pStmt, 2, zBaseCol, -1, SQLITE_TRANSIENT);
  rc = sqlite3_step(pStmt);
  if( rc==SQLITE_ROW ){
    const char *zT = (const char*)sqlite3_column_text(pStmt, 0);
    const char *zC = (const char*)sqlite3_column_text(pStmt, 1);
    char *t = sqlite3_mprintf("%s", zT ? zT : "");
    char *c = sqlite3_mprintf("%s", zC ? zC : "");
    sqlite3_finalize(pStmt);
    if( t==0 || c==0 ){
      sqlite3_free(t);
      sqlite3_free(c);
      return SQLITE_NOMEM;
    }
    *pzStoreTbl = t;
    *pzStoreCol = c;
    return SQLITE_OK;
  }
  sqlite3_finalize(pStmt);
  return SQLITE_NOTFOUND;
}

/*
** vector_init(table TEXT, column TEXT, options TEXT) -> NULL
**
** Records configuration for a vector column. options is a comma-separated list
** of key=value: dimension (required), type (default FLOAT32), distance
** (default L2).
*/
static void rhvecInitFunc(
  sqlite3_context *ctx,
  int argc,
  sqlite3_value **argv
){
  sqlite3 *db = sqlite3_context_db_handle(ctx);
  const char *zTbl, *zCol, *zOpts;
  const char *z;
  char zKey[64], zVal[64];
  int nDim = -1;
  RhvecType type = RHVEC_F32;
  RhvecMetric metric = RHVEC_L2;
  sqlite3_stmt *pStmt = 0;
  int rc;
  (void)argc;

  if( sqlite3_value_type(argv[0])==SQLITE_NULL
   || sqlite3_value_type(argv[1])==SQLITE_NULL ){
    sqlite3_result_error(ctx, "vector_init: table and column are required", -1);
    return;
  }
  zTbl = (const char*)sqlite3_value_text(argv[0]);
  zCol = (const char*)sqlite3_value_text(argv[1]);
  zOpts = (const char*)sqlite3_value_text(argv[2]);

  z = zOpts ? zOpts : "";
  while( rhvecNextOption(&z, zKey, sizeof(zKey), zVal, sizeof(zVal)) ){
    if( sqlite3_stricmp(zKey,"dimension")==0 || sqlite3_stricmp(zKey,"dim")==0 ){
      nDim = atoi(zVal);
    }else if( sqlite3_stricmp(zKey,"type")==0 ){
      if( rhvecParseType(zVal, &type)!=SQLITE_OK ){
        sqlite3_result_error(ctx, "vector_init: unknown type", -1);
        return;
      }
    }else if( sqlite3_stricmp(zKey,"distance")==0 || sqlite3_stricmp(zKey,"metric")==0 ){
      if( rhvecParseMetric(zVal, &metric)!=SQLITE_OK ){
        sqlite3_result_error(ctx, "vector_init: unknown distance metric", -1);
        return;
      }
    }else{
      char *zErr = sqlite3_mprintf("vector_init: unknown option '%s'", zKey);
      sqlite3_result_error(ctx, zErr, -1);
      sqlite3_free(zErr);
      return;
    }
  }
  if( nDim<=0 ){
    sqlite3_result_error(ctx, "vector_init: a positive 'dimension' is required", -1);
    return;
  }

  rc = rhvecConfigEnsureTable(db);
  if( rc!=SQLITE_OK ){
    sqlite3_result_error(ctx, sqlite3_errmsg(db), -1);
    return;
  }
  rc = sqlite3_prepare_v2(
    db,
    "INSERT OR REPLACE INTO " RHVEC_CONFIG_TABLE
    "(tbl,col,dim,vtype,metric) VALUES(?1,?2,?3,?4,?5)",
    -1, &pStmt, 0
  );
  if( rc!=SQLITE_OK ){
    sqlite3_result_error(ctx, sqlite3_errmsg(db), -1);
    return;
  }
  sqlite3_bind_text(pStmt, 1, zTbl, -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(pStmt, 2, zCol, -1, SQLITE_TRANSIENT);
  sqlite3_bind_int(pStmt, 3, nDim);
  sqlite3_bind_text(pStmt, 4, rhvecTypeName(type), -1, SQLITE_STATIC);
  sqlite3_bind_text(pStmt, 5, rhvecMetricName(metric), -1, SQLITE_STATIC);
  rc = sqlite3_step(pStmt);
  sqlite3_finalize(pStmt);
  if( rc!=SQLITE_DONE ){
    sqlite3_result_error(ctx, sqlite3_errmsg(db), -1);
    return;
  }
  sqlite3_result_null(ctx);
}

int rhvecRegisterConfigFuncs(sqlite3 *db){
  return sqlite3_create_function(
    db, "vector_init", 3,
    SQLITE_UTF8 | SQLITE_DIRECTONLY,
    0, rhvecInitFunc, 0, 0
  );
}
