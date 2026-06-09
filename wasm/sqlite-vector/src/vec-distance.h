/*
** rh vector-search extension — distance metrics.
**
** Scalar kernels only (no SIMD). Clean-room; see vector.h. All kernels operate
** on float vectors decoded from the stored BLOB (rhvecDecodeToF32), so every
** element type shares one code path.
*/
#ifndef RH_VEC_DISTANCE_H
#define RH_VEC_DISTANCE_H

#include "sqlite3.h"
#include "vec-types.h"

/* Distance / similarity metrics. "Distance" semantics (smaller = nearer) hold
** for every metric EXCEPT DOT, which is a similarity (larger = nearer); the
** scan layer accounts for that when ordering. */
typedef enum RhvecMetric {
  RHVEC_L2 = 0,       /* Euclidean distance                     */
  RHVEC_SQUARED_L2,   /* squared Euclidean (no sqrt)            */
  RHVEC_COSINE,       /* 1 - cosine similarity                  */
  RHVEC_DOT,          /* dot product (similarity)               */
  RHVEC_L1,           /* Manhattan distance                     */
  RHVEC_HAMMING       /* count of differing coordinates         */
} RhvecMetric;

/* Parse a metric name (case-insensitive: L2, SQUARED_L2, COSINE, DOT, L1,
** HAMMING). Returns SQLITE_OK or SQLITE_ERROR. */
int rhvecParseMetric(const char *z, RhvecMetric *pMetric);
const char *rhvecMetricName(RhvecMetric m);

/* Compute the metric between two decoded float vectors of length n. */
double rhvecDistanceF32(RhvecMetric metric, const float *a, const float *b, int n);

/* Register vector_distance(a, b, type, metric). */
int rhvecRegisterDistanceFuncs(sqlite3 *db);

#endif /* RH_VEC_DISTANCE_H */
