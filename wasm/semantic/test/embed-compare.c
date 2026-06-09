/*
** embed-compare — compare two embedding vectors for the bge-embed verification.
**
**   embed-compare <a> <b> [min_cosine] [max_abs_diff]
**
** Each file is parsed leniently as a stream of floats (any non-numeric bytes
** are skipped), so it accepts bge-cli's space-separated output AND
** llama-embedding's `--embd-output-format array` ([[f, f, …]]). Prints cosine
** similarity and max |Δ|; exits non-zero if cosine < min_cosine (default
** 0.9999) or max|Δ| > max_abs_diff (default 0.01). Plain C, no deps.
*/
#include <math.h>
#include <stdio.h>
#include <stdlib.h>

/* Extract every float token from a file; skips brackets/commas/labels. */
static double *parse_floats(const char *path, int *out_n) {
  FILE *f = fopen(path, "rb");
  if (!f) { fprintf(stderr, "embed-compare: cannot open %s\n", path); return NULL; }
  fseek(f, 0, SEEK_END); long sz = ftell(f); fseek(f, 0, SEEK_SET);
  char *buf = (char *)malloc((size_t)sz + 1);
  if (!buf || fread(buf, 1, (size_t)sz, f) != (size_t)sz) { free(buf); fclose(f); return NULL; }
  buf[sz] = '\0';
  fclose(f);

  int cap = 512, n = 0;
  double *v = (double *)malloc((size_t)cap * sizeof(double));
  char *p = buf;
  while (*p) {
    char *end;
    double d = strtod(p, &end);
    if (end == p) { p++; continue; }   /* not a number here — skip one byte */
    if (n == cap) { cap *= 2; v = (double *)realloc(v, (size_t)cap * sizeof(double)); }
    v[n++] = d;
    p = end;
  }
  free(buf);
  *out_n = n;
  return v;
}

int main(int argc, char **argv) {
  if (argc < 3) {
    fprintf(stderr, "usage: embed-compare <a> <b> [min_cosine] [max_abs_diff]\n");
    return 2;
  }
  double min_cos = argc > 3 ? atof(argv[3]) : 0.9999;
  double max_abs = argc > 4 ? atof(argv[4]) : 0.01;

  int na = 0, nb = 0;
  double *a = parse_floats(argv[1], &na);
  double *b = parse_floats(argv[2], &nb);
  if (!a || !b) return 1;
  if (na == 0 || nb == 0) { fprintf(stderr, "embed-compare: no floats parsed (a=%d b=%d)\n", na, nb); return 1; }
  if (na != nb) { fprintf(stderr, "embed-compare: length mismatch a=%d b=%d\n", na, nb); return 1; }

  double dot = 0, na2 = 0, nb2 = 0, maxd = 0;
  for (int i = 0; i < na; i++) {
    dot += a[i] * b[i];
    na2 += a[i] * a[i];
    nb2 += b[i] * b[i];
    double d = fabs(a[i] - b[i]);
    if (d > maxd) maxd = d;
  }
  double cos = (na2 > 0 && nb2 > 0) ? dot / (sqrt(na2) * sqrt(nb2)) : 0.0;

  int ok = (cos >= min_cos) && (maxd <= max_abs);
  printf("dim=%d cosine=%.8f max_abs_diff=%.6g  [%s] (min_cos=%.5f max_abs=%.4g)\n",
         na, cos, maxd, ok ? "PASS" : "FAIL", min_cos, max_abs);
  free(a); free(b);
  return ok ? 0 : 1;
}
