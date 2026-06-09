/*
** Native memory-leak / use-after-free harness for the in-tree rh vector
** extension. NOT part of the wasm build — it compiles the same C sources
** against the downloaded SQLite amalgamation with the SYSTEM allocator and
** memory statistics ON (the shipped wasm build sets
** SQLITE_DEFAULT_MEMSTATUS=0). Because the extension allocates exclusively
** through sqlite3_malloc/_free, `sqlite3_memory_used()` tracks every byte it
** holds: we warm the schema once, snapshot the high-water, hammer every
** vtab/scan/error path in a loop, and assert the allocation does not grow —
** a per-iteration leak (a missed sqlite3_free, an un-finalized stmt) shows as
** a positive delta. Built under -fsanitize=address it also catches
** use-after-free / heap overflow / double-free.
**
** Build + run via `make vector-leakcheck` (needs `make wa-sqlite` first so the
** amalgamation is present under build/sqlite-amalgamation/).
**
** Exercises in particular the vector_search additions: _rhvec_search_map
** resolution (the zMapTbl/zMapCol sqlite3_mprintf pair) on the success path,
** the config-missing goto-done path (that the map strings are still freed),
** the NOTFOUND error path, and the TEXT->embed branch via a stubbed
** analyst_embed_query (the env import the JS runtime supplies in the browser).
*/
#include "sqlite3.h"

#include <stdio.h>
#include <stdlib.h>

extern int rh_vector_init(sqlite3 *, char **, const sqlite3_api_routines *);

/*
** In the wasm build this is an env import backed by the in-thread ONNX model
** (see src/lib/wa-sqlite/runtime.ts / semantic-embed-host.ts). Natively we stub
** it with a deterministic vector so the embed code path — and every allocation
** downstream of it — is exercised under the sanitizer. Returns 0 (ok).
*/
int analyst_embed_query(const char *zText, int nText, float *aOut, int nDim){
  int i;
  (void)zText;
  (void)nText;
  for(i=0; i<nDim; i++) aOut[i] = (float)(((i*7 + 3) % 11) - 5) * 0.1f;
  return 0;
}

#define DIM 8
#define NROWS 128
#define ITERS 500

static void die(const char *what, sqlite3 *db){
  fprintf(stderr, "FAIL %s: %s\n", what, db ? sqlite3_errmsg(db) : "(no db)");
  exit(1);
}

static void run(sqlite3 *db, const char *sql){
  char *zErr = 0;
  if( sqlite3_exec(db, sql, 0, 0, &zErr)!=SQLITE_OK ){
    fprintf(stderr, "SQL FAIL: %s\n  %s\n", zErr ? zErr : "?", sql);
    sqlite3_free(zErr);
    exit(1);
  }
}

/* Drive a query to completion (stepping the vtab), ignoring rows. When
** wantErr, an error at prepare/step is expected and tolerated. */
static void drain(sqlite3 *db, const char *sql, int wantErr){
  sqlite3_stmt *st = 0;
  int rc = sqlite3_prepare_v2(db, sql, -1, &st, 0);
  if( rc!=SQLITE_OK ){
    sqlite3_finalize(st);
    if( wantErr ) return;
    fprintf(stderr, "prepare FAIL (rc=%d): %s\n  %s\n", rc, sqlite3_errmsg(db), sql);
    exit(1);
  }
  do { rc = sqlite3_step(st); } while( rc==SQLITE_ROW );
  sqlite3_finalize(st);
  if( !wantErr && rc!=SQLITE_DONE ){
    fprintf(stderr, "step FAIL (rc=%d): %s\n  %s\n", rc, sqlite3_errmsg(db), sql);
    exit(1);
  }
}

/* A deterministic DIM-vector for a seed, as a JSON array literal. Caller frees. */
static char *vecJson(int seed){
  double v[DIM];
  int i;
  char *z;
  for(i=0; i<DIM; i++) v[i] = (double)(((seed*31 + i*7) % 23) - 11);
  z = sqlite3_mprintf("[%g,%g,%g,%g,%g,%g,%g,%g]",
                      v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7]);
  if( z==0 ){ fprintf(stderr, "OOM\n"); exit(1); }
  return z;
}

/* One pass over every allocation-bearing path. */
static void onePass(sqlite3 *db){
  char *q = vecJson(9001);
  char *sql;

  /* vector_search: map resolution (zMapTbl/zMapCol) + JSON query + scan. */
  sql = sqlite3_mprintf(
    "SELECT rowid,distance FROM vector_search('product','name',vector_as_f32('%s'),10)", q);
  drain(db, sql, 0);
  sqlite3_free(sql);

  /* vector_search: map resolution + TEXT->embed branch (stubbed) + scan. */
  drain(db, "SELECT rowid,distance FROM vector_search('product','name','find me dogs',10)", 0);

  /* vector_search: map NOTFOUND error path (zMapTbl/zMapCol stay 0). */
  drain(db, "SELECT rowid,distance FROM vector_search('product','unmapped','dogs',10)", 1);

  /* vector_search: map OK but the store has no vector_init -> config NOTFOUND
  ** goto-done path. Asserts the map strings are freed on that early exit. */
  drain(db, "SELECT rowid,distance FROM vector_search('product','badcol','dogs',10)", 1);

  /* Plain quantized scan (no map) + a TEXT->embed on the full scan. */
  sql = sqlite3_mprintf(
    "SELECT rowid,distance FROM vector_quantize_scan('_rhvec_emb_p_name','vec',"
    "vector_as_f32('%s'),10)", q);
  drain(db, sql, 0);
  sqlite3_free(sql);
  drain(db, "SELECT rowid,distance FROM vector_full_scan('_rhvec_emb_p_name','vec','dogs',5)", 0);

  sqlite3_free(q);
}

int main(void){
  sqlite3 *db = 0;
  int i;
  sqlite3_int64 before, after, hi;

  sqlite3_auto_extension((void(*)(void))rh_vector_init);
  if( sqlite3_open(":memory:", &db)!=SQLITE_OK ) die("open", db);

  run(db, "CREATE TABLE product(id INTEGER PRIMARY KEY, name TEXT)");
  run(db, "CREATE TABLE _rhvec_emb_p_name(rowid INTEGER PRIMARY KEY, vec BLOB)");
  run(db, "CREATE TABLE _rhvec_nostore(rowid INTEGER PRIMARY KEY, vec BLOB)");
  run(db, "CREATE TABLE _rhvec_search_map(base_tbl TEXT, base_col TEXT,"
          " store_tbl TEXT, store_col TEXT, model TEXT, dim INTEGER, metric TEXT,"
          " PRIMARY KEY(base_tbl,base_col))");

  for(i=1; i<=NROWS; i++){
    char *json = vecJson(i);
    char *sql = sqlite3_mprintf(
      "INSERT INTO product(id,name) VALUES(%d,'item %d');"
      "INSERT INTO _rhvec_emb_p_name(rowid,vec) VALUES(%d,vector_as_f32('%s'))",
      i, i, i, json);
    run(db, sql);
    sqlite3_free(sql);
    sqlite3_free(json);
  }
  /* A row in the no-vector_init store, plus its map entry (the goto-done case). */
  {
    char *json = vecJson(1);
    char *sql = sqlite3_mprintf(
      "INSERT INTO _rhvec_nostore(rowid,vec) VALUES(1,vector_as_f32('%s'))", json);
    run(db, sql);
    sqlite3_free(sql);
    sqlite3_free(json);
  }

  run(db, "SELECT vector_init('_rhvec_emb_p_name','vec','dimension=8, distance=cosine')");
  run(db, "SELECT vector_quantize('_rhvec_emb_p_name','vec','qtype=turbo,qbits=4')");
  run(db, "INSERT INTO _rhvec_search_map VALUES"
          "('product','name','_rhvec_emb_p_name','vec','bge-small-en-v1.5',8,'cosine'),"
          "('product','badcol','_rhvec_nostore','vec','bge-small-en-v1.5',8,'cosine')");

  /* Warm one pass so schema/page-cache high-water is already allocated. */
  onePass(db);
  before = sqlite3_memory_used();
  for(i=0; i<ITERS; i++) onePass(db);
  after = sqlite3_memory_used();
  hi = sqlite3_memory_highwater(0);

  if( sqlite3_close(db)!=SQLITE_OK ){ fprintf(stderr, "close did not release everything\n"); return 1; }
  sqlite3_shutdown();

  fprintf(stderr, "[vector-leakcheck] mem used before=%lld after=%lld delta=%lld highwater=%lld over %d iters\n",
          (long long)before, (long long)after, (long long)(after-before), (long long)hi, ITERS);
  if( after - before > 4096 ){
    fprintf(stderr, "[vector-leakcheck] LEAK: sqlite3_malloc grew %lld bytes across %d iterations\n",
            (long long)(after-before), ITERS);
    return 1;
  }
  printf("[vector-leakcheck] OK — no sqlite3_malloc growth across %d iterations\n", ITERS);
  return 0;
}
