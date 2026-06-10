/*
** semantic — self-contained C inference for small BERT encoders, no ggml / no
** ONNX. ONE engine, ONE wasm (semantic.wasm), driving two model families off a
** GGUF whose geometry it reads at runtime:
**
**   * EMBED       (bge-small-en-v1.5): 12L/384/12h, CLS-pool + L2-normalize ->
**                 sem_dim() floats. (gelu = tanh-approx, matches llama.cpp.)
**   * TOKEN_CLS   (bert-small-pii):    4L/512/8h + a per-token classifier head,
**                 softmax -> argmax label id + score + char offsets per token.
**                 (gelu = exact erf, matches the ONNX export.)
**
** Both share the GGUF reader, the WordPiece tokenizer, the Unicode tables, and
** the BERT encoder; only the geometry (runtime, from metadata) and the output
** head differ. A GGUF carrying a `classifier.weight` tensor is TOKEN_CLS; one
** without is EMBED.
**
** Single-threaded and SIMD128 (wasm) / scalar (native); the SAME sources compile
** natively for the llama.cpp embedding comparison harness under wasm/semantic/test/.
**
** Public ABI (reactor wasm exports + native callers):
**   int  sem_init      (const uint8_t *gguf, int len);
**   int  sem_kind      (void);                                 // SEM_KIND_*
**   int  sem_dim       (void);                                 // hidden size
**   int  sem_num_labels(void);                                 // 0 unless TOKEN_CLS
**   int  sem_embed     (const char *text, int len, float *out);          // EMBED
**   int  sem_ner_infer (const char *text, int len, int32_t *out, int max);// TOKEN_CLS
**   const char *sem_strerror(int rc);
**
** All entry points return SEM_OK (0) / a value >= 0, or a negative error code.
** A single global model instance is held between sem_init and process exit;
** calling sem_init again replaces it.
*/
#ifndef SEMANTIC_H
#define SEMANTIC_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Error codes. 0 == success; everything else is negative. */
enum {
  SEM_OK            =  0,
  SEM_ERR_GGUF      = -1,  /* malformed GGUF container */
  SEM_ERR_ARCH      = -2,  /* not bert / unsupported hyperparameters */
  SEM_ERR_TENSOR    = -3,  /* a required weight is missing or wrong shape/type */
  SEM_ERR_OOM       = -4,  /* allocation failed */
  SEM_ERR_NOT_INIT  = -5,  /* inference called before a successful sem_init */
  SEM_ERR_INPUT     = -6,  /* bad argument (null/negative) */
  SEM_ERR_TOKENIZE  = -7,  /* tokenization produced no usable tokens */
  SEM_ERR_KIND      = -8   /* wrong entry point for the loaded model kind */
};

/* Model kind, inferred from the GGUF tensors/metadata at load. */
enum {
  SEM_KIND_EMBED     = 0,  /* CLS-pool + L2-normalize sentence embedding (BERT) */
  SEM_KIND_TOKEN_CLS = 1,  /* per-token classification (NER, BERT) */
  SEM_KIND_STATIC    = 2   /* Model2Vec static embedding: token-table gather+mean */
};

/*
** Parse `gguf` (len bytes), validate it is a supported BERT encoder, read its
** geometry from metadata, convert all weights to f32 in owned memory, and build
** the WordPiece vocabulary. The input buffer is NOT retained — the caller may
** free it after this returns.
*/
int sem_init(const uint8_t *gguf, int len);

/* SEM_KIND_* of the loaded model. SEM_ERR_NOT_INIT (<0) if not initialized. */
int sem_kind(void);

/* Hidden size / embedding dimensionality. Valid (>0) after sem_init. */
int sem_dim(void);

/* Classifier label count for TOKEN_CLS models; 0 for EMBED. */
int sem_num_labels(void);

/*
** EMBED or STATIC (Model2Vec). Embed `text` (len bytes of UTF-8; len<0 => strlen).
** Writes sem_dim() L2-normalized floats to `out`. EMBED runs the BERT encoder +
** CLS pool; STATIC gathers the Model2Vec token table over the content subwords and
** mean-pools (no [CLS]/[SEP]). Text past the model context is truncated. Returns
** SEM_OK or <0 (SEM_ERR_KIND if the loaded model is TOKEN_CLS).
*/
int sem_embed(const char *text, int len, float *out);

/*
** TOKEN_CLS only. Run the encoder + classifier over `text` and, for each CONTENT
** token (the [CLS]/[SEP] framing is excluded), write its argmax label id, max
** softmax score, and [start,end) BYTE offsets into the input text.
**
** `out` is a single caller-provided buffer of at least `4 * max_tokens` int32
** slots, laid out as four contiguous blocks of `max_tokens`:
**   out[0       .. max)    labels  (int32, 0..num_labels-1)
**   out[max     .. 2*max)  starts  (int32, byte offset)
**   out[2*max   .. 3*max)  ends    (int32, byte offset, exclusive)
**   out[3*max   .. 4*max)  scores  (float32, reinterpret the int32 bits)
** Returns the number of content tokens written (>=0, capped at max_tokens) or
** <0 (SEM_ERR_KIND if the loaded model is EMBED).
*/
int sem_ner_infer(const char *text, int len, int32_t *out, int max_tokens);

/* Human-readable message for an rc returned above. Never NULL. */
const char *sem_strerror(int rc);

#ifdef __cplusplus
}
#endif

#endif /* SEMANTIC_H */
