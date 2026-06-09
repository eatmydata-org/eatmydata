/*
** sem-cli — native driver for the semantic module (test/verification only).
**
**   sem-cli <model.gguf> "<text>"            embed -> dim floats, space-separated
**   sem-cli --raw <model.gguf> "<text>"      embed -> raw float32[dim] to stdout
**   sem-cli --tokens <model.gguf> "<text>"   tokenize -> token ids, space-separated
**   sem-cli --ner <model.gguf> "<text>"      token-classify -> one line per content
**                                            token: "labelid start end score"
**
** The float-text form feeds embed-compare against llama-embedding; --tokens feeds
** the tokenizer check against llama-tokenize; --ner feeds the NER F1 scorer. Loads
** the whole GGUF into memory and hands it to sem_init (same contract as the wasm
** caller).
*/
#include "semantic.h"
#include "semantic-internal.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static uint8_t *read_file(const char *path, long *out_len) {
  FILE *f = fopen(path, "rb");
  if (!f) { fprintf(stderr, "sem-cli: cannot open %s\n", path); return NULL; }
  fseek(f, 0, SEEK_END);
  long n = ftell(f);
  fseek(f, 0, SEEK_SET);
  uint8_t *buf = (uint8_t *)malloc((size_t)n);
  if (!buf || fread(buf, 1, (size_t)n, f) != (size_t)n) {
    fprintf(stderr, "sem-cli: read failed %s\n", path);
    free(buf); fclose(f); return NULL;
  }
  fclose(f);
  *out_len = n;
  return buf;
}

int main(int argc, char **argv) {
  int mode_raw = 0, mode_tokens = 0, mode_ner = 0;
  int ai = 1;
  for (; ai < argc; ai++) {
    if (strcmp(argv[ai], "--raw") == 0) mode_raw = 1;
    else if (strcmp(argv[ai], "--tokens") == 0) mode_tokens = 1;
    else if (strcmp(argv[ai], "--ner") == 0) mode_ner = 1;
    else break;
  }
  if (argc - ai < 2) {
    fprintf(stderr, "usage: sem-cli [--raw|--tokens|--ner] <model.gguf> <text>\n");
    return 2;
  }
  const char *model_path = argv[ai];
  const char *text = argv[ai + 1];

  long len = 0;
  uint8_t *gguf = read_file(model_path, &len);
  if (!gguf) return 1;

  int rc = sem_init(gguf, (int)len);
  free(gguf); /* sem_init does not retain the buffer */
  if (rc != SEM_OK) { fprintf(stderr, "sem-cli: sem_init: %s\n", sem_strerror(rc)); return 1; }

  if (mode_tokens) {
    const sem_vocab *v = sem_debug_vocab();
    int32_t *ids = NULL; int n = 0;
    rc = sem_tokenize(v, text, -1, SEM_MAX_CTX, &ids, NULL, NULL, &n);
    if (rc != SEM_OK) { fprintf(stderr, "sem-cli: tokenize: %s\n", sem_strerror(rc)); return 1; }
    for (int i = 0; i < n; i++) printf("%s%d", i ? " " : "", ids[i]);
    printf("\n");
    free(ids);
    return 0;
  }

  if (mode_ner) {
    int max = SEM_MAX_CTX;
    int32_t *out = (int32_t *)malloc((size_t)max * 4 * sizeof(int32_t));
    if (!out) return 1;
    int n = sem_ner_infer(text, -1, out, max);
    if (n < 0) { fprintf(stderr, "sem-cli: ner: %s\n", sem_strerror(n)); free(out); return 1; }
    const int32_t *lab = out, *st = out + max, *en = out + 2 * max;
    const float *sc = (const float *)(out + 3 * max);
    for (int i = 0; i < n; i++)
      printf("%d %d %d %.6f\n", lab[i], st[i], en[i], (double)sc[i]);
    free(out);
    return 0;
  }

  int dim = sem_dim();
  float *vec = (float *)malloc((size_t)dim * sizeof(float));
  if (!vec) return 1;
  rc = sem_embed(text, -1, vec);
  if (rc != SEM_OK) { fprintf(stderr, "sem-cli: sem_embed: %s\n", sem_strerror(rc)); free(vec); return 1; }

  if (mode_raw) {
    fwrite(vec, sizeof(float), (size_t)dim, stdout);
  } else {
    for (int i = 0; i < dim; i++) printf("%s%.7g", i ? " " : "", (double)vec[i]);
    printf("\n");
  }
  free(vec);
  return 0;
}
