/*
** rh vector-search extension — per-column configuration.
**
** vector_init(table, column, options) records the dimension, element type, and
** distance metric for a vector column in a shadow table (`_rhvec_config`) so it
** survives across connections. The scan virtual tables read it back. Clean-room
** (see vector.h).
*/
#ifndef RH_VEC_CONFIG_H
#define RH_VEC_CONFIG_H

#include "sqlite3.h"
#include "vec-types.h"
#include "vec-distance.h"

typedef struct RhvecConfig {
  int nDim;
  RhvecType type;
  RhvecMetric metric;
} RhvecConfig;

/* Create the `_rhvec_config` shadow table if absent. */
int rhvecConfigEnsureTable(sqlite3 *db);

/* Look up the config for (zTbl,zCol). SQLITE_OK fills *pCfg; SQLITE_NOTFOUND if
** there is no row (or no config table yet); otherwise an error code. */
int rhvecConfigLookup(sqlite3 *db, const char *zTbl, const char *zCol,
                      RhvecConfig *pCfg);

/*
** Resolve a user-facing (base table, base column) — what an LLM writes in
** vector_search('product','name',...) — to the storage (table, column) that
** physically holds the embedding vectors, via the `_rhvec_search_map` shadow
** table (created + populated by the JS import-time indexer; this C side only
** reads it). On SQLITE_OK, *pzStoreTbl / *pzStoreCol are sqlite3_malloc'd and
** owned by the caller (free with sqlite3_free). SQLITE_NOTFOUND if there is no
** map row (or no map table yet). The base column is never indexed in place —
** see CLAUDE.md "SQLite has no hidden columns" rationale.
*/
int rhvecSearchMapLookup(sqlite3 *db, const char *zBaseTbl, const char *zBaseCol,
                         char **pzStoreTbl, char **pzStoreCol);

/*
** Advance *pz past one "key=value" (or bare "key") token of a comma-separated
** options string, writing the trimmed, lowercased-as-given key and value into
** the caller's buffers (NUL-terminated, truncated if too long). Returns 1 when
** a token was produced, 0 at end of string. Shared by vector_init and
** vector_quantize.
*/
int rhvecNextOption(const char **pz, char *zKey, int nKey, char *zVal, int nVal);

/* Register vector_init(). */
int rhvecRegisterConfigFuncs(sqlite3 *db);

#endif /* RH_VEC_CONFIG_H */
