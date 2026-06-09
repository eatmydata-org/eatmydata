/*
** rh vector-search extension — scan virtual tables.
**
** Eponymous table-valued functions for nearest-neighbour search:
**   vector_full_scan(table, column, query[, k])       -> (rowid, distance)
**   vector_quantize_scan(table, column, query[, k])   -> (rowid, distance)
**   vector_search(table, column, query[, k])          -> (rowid, distance)
** The first two read the column's config (vec-config) and the base table on the
** same connection; `query` is a vector BLOB or JSON array. vector_search adds
** two things over vector_quantize_scan: (table,column) name the user-facing
** TEXT column and are resolved to the storage sidecar via _rhvec_search_map,
** and a TEXT `query` is embedded on the fly via the host on-device model
** (analyst_embed_query). Clean-room (see vector.h).
*/
#ifndef RH_VEC_SCAN_H
#define RH_VEC_SCAN_H

#include "sqlite3.h"

int rhvecRegisterScanModules(sqlite3 *db);

#endif /* RH_VEC_SCAN_H */
