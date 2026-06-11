#include <sqlite3.h>
#include "vector.h"
#include "semantic.h"

__attribute__((used, visibility("default")))
int analyst_wa_init(void) {
    int rc = sqlite3_initialize();
    if (rc != SQLITE_OK) return rc;
    /* Register the rh vector-search extension on every connection opened
    ** hereafter. sqlite3_auto_extension survives SQLITE_OMIT_LOAD_EXTENSION
    ** and, under SQLITE_OMIT_AUTOINIT, must run after sqlite3_initialize. */
    return sqlite3_auto_extension((void (*)(void))rh_vector_init);
}

/*
** BGE retrieval is asymmetric: the QUERY is embedded with this instruction
** prefix while stored passages are embedded RAW (the indexer does not add it).
** Omitting it on the query measurably lowers recall. See bge-small-en-v1.5.
*/
static const char RH_BGE_QUERY_PREFIX[] =
    "Represent this sentence for searching relevant passages: ";

/*
** Embed a query phrase for the `vector_search` vtab. Defined HERE (not a JS env
** import) because the semantic engine (BGE encoder + Model2Vec static embedder)
** is compiled straight into wa-sqlite.wasm — the vtab's `xFilter` calls this
** synchronously and we run `sem_embed` in the same module/memory, no JS hop.
** `zText` is the UTF-8 query (nText bytes); `aOut` receives `nDim` float32 values.
**
** Return codes match what vec-scan.c already handles:
**   0  success (embedding written to aOut)
**   1  model not available/warmed — sem_init has not run yet (the embedder is
**      lazy-loaded from JS only for a DB that carries a semantic index). In
**      Node/vitest sem_init is never called, so this returns 1 and the vtab
**      raises a clean "not warmed up" error, exactly as the old hook did.
**   2  dimension mismatch
**   3  allocation/embed failure
*/
__attribute__((used, visibility("default")))
int analyst_embed_query(const char *zText, int nText, float *aOut, int nDim) {
    int kind = sem_kind();
    if ((kind != SEM_KIND_EMBED && kind != SEM_KIND_STATIC) || sem_dim() <= 0)
        return 1;                     /* not warmed */
    if (sem_dim() != nDim) return 2;  /* dim mismatch */
    if (kind == SEM_KIND_STATIC) {
        /* Model2Vec is SYMMETRIC (bag-of-words static table): the query is embedded
        ** RAW, exactly like stored passages — the BGE asymmetric instruction prefix
        ** would just inject extra tokens into the mean and hurt recall. */
        int rc = sem_embed(zText, nText, aOut);
        return rc == SEM_OK ? 0 : 3;
    }
    char *z = sqlite3_mprintf("%s%.*s", RH_BGE_QUERY_PREFIX, nText, zText);
    if (!z) return 3;
    int rc = sem_embed(z, -1, aOut); /* len<0 => strlen; writes sem_dim() floats */
    sqlite3_free(z);
    return rc == SEM_OK ? 0 : 3;
}
