/*
** rh vector-search extension — registration entry point and utility
** functions. Clean-room; see vector.h for provenance and CLAUDE.md.
**
** Built as a statically-linked (SQLITE_CORE) extension: SQLITE_EXTENSION_INIT*
** are no-ops and sqlite3_* resolve to the real core symbols. Coding style and
** memory/string handling follow the SQLite source conventions
** (https://www.sqlite.org/codingstyle.html): allocate via sqlite3_malloc64,
** build text via sqlite3_str / sqlite3_mprintf, never libc malloc/sprintf.
*/
#define SQLITE_CORE 1
#include "sqlite3ext.h"
SQLITE_EXTENSION_INIT1

#include "vector.h"
#include "vec-types.h"
#include "vec-distance.h"
#include "vec-config.h"
#include "vec-quantize.h"
#include "vec-scan.h"

/*
** vector_version() -> TEXT
**
** Returns the extension version string. Constant, so SQLITE_STATIC is safe.
*/
static void rhvecVersionFunc(
  sqlite3_context *ctx,
  int argc,
  sqlite3_value **argv
){
  (void)argc;
  (void)argv;
  sqlite3_result_text(ctx, RH_VECTOR_VERSION, -1, SQLITE_STATIC);
}

/*
** vector_backend() / vector_turboquant_backend() -> TEXT
**
** The active distance/quantization kernel backend. This build is scalar-only
** (wasm32-wasi, no SIMD), so both report "scalar".
*/
static void rhvecBackendFunc(
  sqlite3_context *ctx,
  int argc,
  sqlite3_value **argv
){
  (void)argc;
  (void)argv;
  sqlite3_result_text(ctx, "scalar", -1, SQLITE_STATIC);
}

/*
** Register a deterministic, innocuous scalar function with nArg arguments.
** Centralizes the flag set so every vector_* function is registered the same
** way. Returns the sqlite3_create_function result code.
*/
static int rhvecCreateScalar(
  sqlite3 *db,
  const char *zName,
  int nArg,
  void (*xFunc)(sqlite3_context*,int,sqlite3_value**)
){
  return sqlite3_create_function(
    db, zName, nArg,
    SQLITE_UTF8 | SQLITE_DETERMINISTIC | SQLITE_INNOCUOUS,
    0, xFunc, 0, 0
  );
}

/*
** Auto-extension entry point. Registers the utility functions; later phases
** extend this with the encoders, config, quantizers, and scan vtab modules.
*/
int rh_vector_init(
  sqlite3 *db,
  char **pzErrMsg,
  const struct sqlite3_api_routines *pApi
){
  int rc;
  SQLITE_EXTENSION_INIT2((const sqlite3_api_routines*)pApi);
  (void)pzErrMsg;

  rc = rhvecCreateScalar(db, "vector_version", 0, rhvecVersionFunc);
  if( rc==SQLITE_OK ){
    rc = rhvecCreateScalar(db, "vector_backend", 0, rhvecBackendFunc);
  }
  if( rc==SQLITE_OK ){
    rc = rhvecCreateScalar(db, "vector_turboquant_backend", 0,
                           rhvecBackendFunc);
  }
  if( rc==SQLITE_OK ) rc = rhvecRegisterTypeFuncs(db);
  if( rc==SQLITE_OK ) rc = rhvecRegisterDistanceFuncs(db);
  if( rc==SQLITE_OK ) rc = rhvecRegisterConfigFuncs(db);
  if( rc==SQLITE_OK ) rc = rhvecRegisterQuantizeFuncs(db);
  if( rc==SQLITE_OK ) rc = rhvecRegisterScanModules(db);
  return rc;
}
