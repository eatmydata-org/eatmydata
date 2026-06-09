/*
** rh vector-search extension for wa-sqlite — public surface.
**
** Clean-room reimplementation. No code is taken from sqliteai/sqlite-vector
** (Elastic License 2.0); only its public SQL API shape is matched. The
** quantizer follows the TurboQuant paper (Zandieh, Daliri, Hadian, Mirrokni,
** "TurboQuant: Online Vector Quantization with Near-optimal Distortion Rate",
** arXiv:2504.19874). See the project CLAUDE.md for provenance.
**
** The extension compiles straight into wa-sqlite.wasm and is registered on
** every connection via sqlite3_auto_extension() from analyst_wa_init(). It is
** scalar-only (no SIMD) by design — the target is wasm32-wasi.
*/
#ifndef RH_VECTOR_H
#define RH_VECTOR_H

#include "sqlite3.h"

#define RH_VECTOR_VERSION "0.1.0"

/* sqlite3_api_routines is declared in sqlite3ext.h, which we deliberately do
** not pull into callers of this header (e.g. runtime_shim.c, which links
** against core sqlite directly). Forward-declare it so the init prototype is
** self-contained; the typedef in vector.c is the same struct. */
struct sqlite3_api_routines;

/*
** Auto-extension entry point. Registers every vector_* SQL function and the
** scan virtual-table modules on the given connection. Returns an SQLite error
** code. Registered once, by address, in analyst_wa_init().
*/
int rh_vector_init(sqlite3 *db, char **pzErrMsg,
                   const struct sqlite3_api_routines *pApi);

#endif /* RH_VECTOR_H */
