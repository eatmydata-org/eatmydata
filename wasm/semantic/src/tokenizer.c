/*
** Uncased WordPiece tokenizer, matching llama.cpp's WPM tokenizer
** (src/llama-vocab.cpp llm_tokenizer_wpm) codepoint-for-codepoint:
**
**   1. decode UTF-8 -> codepoints
**   2. per-codepoint NFD-first map (accent strip: é -> e)
**   3. preprocess: lowercase; split on whitespace; punctuation / ASCII-symbol /
**      CJK become single-character words; skip NUL / U+FFFD / control
**   4. for each word, prepend a phantom space "▁" (U+2581) and greedy
**      longest-match against the GGUF vocab (which is pre-transformed: word
**      pieces carry the "▁", continuations are bare). A word with any
**      unmatched position becomes a single [UNK].
**
** [CLS] is prepended and [SEP] appended; the result is truncated to n_ctx.
**
** Offsets: when the caller requests them (token-classification needs char spans),
** the tokenizer also returns, per emitted token id, the [start,end) BYTE offset
** of the ORIGINAL input bytes that token covers ([CLS]/[SEP] -> -1). Subwords land
** on codepoint boundaries, so we track each kept codepoint's original byte span +
** its byte position within the (transformed) word, then map each subword's
** word-byte range back. The embedding path passes NULL and skips all of this, so
** its token ids — the llama.cpp gate — are untouched.
*/
#include "semantic.h"
#include "semantic-internal.h"
#include "unicode-data.h"

#include <stdlib.h>
#include <string.h>

#define UC_WHITESPACE 0x0100u /* synthesized at lookup, not a category bit */

/* ---- vocab hash (open addressing, FNV-1a over the raw token bytes) ---- */

static uint32_t fnv1a(const char *b, int n) {
  uint32_t h = 2166136261u;
  for (int i = 0; i < n; i++) { h ^= (unsigned char)b[i]; h *= 16777619u; }
  return h;
}

int sem_vocab_lookup(const sem_vocab *v, const char *bytes, int len) {
  uint32_t mask = (uint32_t)v->cap - 1;
  uint32_t i = fnv1a(bytes, len) & mask;
  for (;;) {
    int32_t id = v->buckets[i];
    if (id < 0) return -1;
    if ((int)v->tok_len[id] == len &&
        memcmp(v->arena + v->tok_off[id], bytes, (size_t)len) == 0)
      return id;
    i = (i + 1) & mask;
  }
}

/* ---- UTF-8 ---- */

/* Decode one codepoint. Returns bytes consumed; malformed -> U+FFFD, consume 1. */
static int utf8_next(const unsigned char *s, int len, uint32_t *cpt) {
  unsigned char c = s[0];
  if (c < 0x80) { *cpt = c; return 1; }
  if ((c & 0xE0) == 0xC0 && len >= 2 && (s[1] & 0xC0) == 0x80) {
    uint32_t v = ((uint32_t)(c & 0x1F) << 6) | (s[1] & 0x3F);
    if (v >= 0x80) { *cpt = v; return 2; }
  } else if ((c & 0xF0) == 0xE0 && len >= 3 &&
             (s[1] & 0xC0) == 0x80 && (s[2] & 0xC0) == 0x80) {
    uint32_t v = ((uint32_t)(c & 0x0F) << 12) | ((uint32_t)(s[1] & 0x3F) << 6) | (s[2] & 0x3F);
    if (v >= 0x800 && !(v >= 0xD800 && v <= 0xDFFF)) { *cpt = v; return 3; }
  } else if ((c & 0xF8) == 0xF0 && len >= 4 && (s[1] & 0xC0) == 0x80 &&
             (s[2] & 0xC0) == 0x80 && (s[3] & 0xC0) == 0x80) {
    uint32_t v = ((uint32_t)(c & 0x07) << 18) | ((uint32_t)(s[1] & 0x3F) << 12) |
                 ((uint32_t)(s[2] & 0x3F) << 6) | (s[3] & 0x3F);
    if (v >= 0x10000 && v <= 0x10FFFF) { *cpt = v; return 4; }
  }
  *cpt = 0xFFFD;
  return 1;
}

static int utf8_enc(uint32_t cp, char *out) {
  if (cp < 0x80) { out[0] = (char)cp; return 1; }
  if (cp < 0x800) {
    out[0] = (char)(0xC0 | (cp >> 6)); out[1] = (char)(0x80 | (cp & 0x3F)); return 2;
  }
  if (cp < 0x10000) {
    out[0] = (char)(0xE0 | (cp >> 12)); out[1] = (char)(0x80 | ((cp >> 6) & 0x3F));
    out[2] = (char)(0x80 | (cp & 0x3F)); return 3;
  }
  out[0] = (char)(0xF0 | (cp >> 18)); out[1] = (char)(0x80 | ((cp >> 12) & 0x3F));
  out[2] = (char)(0x80 | ((cp >> 6) & 0x3F)); out[3] = (char)(0x80 | (cp & 0x3F)); return 4;
}

/* ---- table lookups (binary search the generated tables) ---- */

static uint32_t uc_flags(uint32_t cpt) {
  /* largest range with start <= cpt */
  int lo = 0, hi = bge_uc_ranges_flags_count - 1, k = 0;
  while (lo <= hi) {
    int mid = (lo + hi) >> 1;
    if (bge_uc_ranges_flags[mid].start <= cpt) { k = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  uint32_t fl = bge_uc_ranges_flags[k].flags;
  /* whitespace OR-ed on top of the category flags */
  int wlo = 0, whi = bge_uc_whitespace_count - 1;
  while (wlo <= whi) {
    int mid = (wlo + whi) >> 1;
    uint32_t w = bge_uc_whitespace[mid];
    if (w == cpt) { fl |= UC_WHITESPACE; break; }
    if (w < cpt) wlo = mid + 1; else whi = mid - 1;
  }
  return fl;
}

static uint32_t uc_pair(const bge_uc_pair *tbl, int n, uint32_t cpt) {
  int lo = 0, hi = n - 1;
  while (lo <= hi) {
    int mid = (lo + hi) >> 1;
    uint32_t k = tbl[mid].key;
    if (k == cpt) return tbl[mid].val;
    if (k < cpt) lo = mid + 1; else hi = mid - 1;
  }
  return cpt; /* identity if absent */
}

static uint32_t uc_tolower(uint32_t cpt) { return uc_pair(bge_uc_lowercase, bge_uc_lowercase_count, cpt); }
static uint32_t uc_nfd(uint32_t cpt)     { return uc_pair(bge_uc_nfd, bge_uc_nfd_count, cpt); }

static int is_chinese(uint32_t c) {
  return (c >= 0x04E00 && c <= 0x09FFF) || (c >= 0x03400 && c <= 0x04DBF) ||
         (c >= 0x20000 && c <= 0x2A6DF) || (c >= 0x2A700 && c <= 0x2B73F) ||
         (c >= 0x2B740 && c <= 0x2B81F) || (c >= 0x2B920 && c <= 0x2CEAF) ||
         (c >= 0x0F900 && c <= 0x0FAFF) || (c >= 0x2F800 && c <= 0x2FA1F);
}

/* ---- a growable int32 list ---- */

typedef struct { int32_t *a; int n, cap; } ivec;
static int iv_push(ivec *v, int32_t x) {
  if (v->n == v->cap) {
    int nc = v->cap ? v->cap * 2 : 64;
    int32_t *na = (int32_t *)realloc(v->a, (size_t)nc * sizeof(int32_t));
    if (!na) return -1;
    v->a = na; v->cap = nc;
  }
  v->a[v->n++] = x;
  return 0;
}

/* WordPiece a single word (UTF-8 bytes, no phantom space yet) into `ids`.
** Mirrors llama.cpp: prepend "▁", greedy longest-match, whole-word [UNK] on any
** miss. When `wbs`/`wbe` are non-NULL, also pushes each emitted subword's
** [start,end) byte range WITHIN `word` (the phantom "▁" excluded). Returns 0
** or -1 (OOM). */
static int wordpiece(const sem_vocab *v, const char *word, int wlen, ivec *ids,
                     ivec *wbs, ivec *wbe) {
  if (wlen <= 0) return 0;
  int n1 = wlen + 3;                 /* "▁" is 3 bytes */
  char stackbuf[256];
  char *w1 = (n1 + 1 <= (int)sizeof(stackbuf)) ? stackbuf : (char *)malloc((size_t)n1 + 1);
  if (!w1) return -1;
  w1[0] = (char)0xE2; w1[1] = (char)0x96; w1[2] = (char)0x81;  /* U+2581 */
  memcpy(w1 + 3, word, (size_t)wlen);

  int start = ids->n;
  int wb_start = wbs ? wbs->n : 0;
  int matched_all = 1;
  int i = 0;
  while (i < n1) {
    int jmax = i + v->max_token_len + 1;
    if (jmax > n1) jmax = n1;
    int hit = 0;
    for (int j = jmax; j > i; j--) {
      int id = sem_vocab_lookup(v, w1 + i, j - i);
      if (id >= 0) {
        if (iv_push(ids, id) != 0) goto oom;
        if (wbs) {
          int ws = i < 3 ? 0 : i - 3;   /* phantom occupies w1[0..2] */
          if (iv_push(wbs, ws) != 0 || iv_push(wbe, j - 3) != 0) goto oom;
        }
        hit = 1; i = j; break;
      }
    }
    if (!hit) { ids->n = start; if (wbs) { wbs->n = wb_start; wbe->n = wb_start; } matched_all = 0; break; }
  }
  if (!matched_all) {
    if (iv_push(ids, v->unk_id) != 0) goto oom;
    if (wbs) { if (iv_push(wbs, 0) != 0 || iv_push(wbe, wlen) != 0) goto oom; }
  }
  if (w1 != stackbuf) free(w1);
  return 0;
oom:
  if (w1 != stackbuf) free(w1);
  return -1;
}

int sem_tokenize(const sem_vocab *v, const char *text, int len, int n_ctx,
                 int32_t **out_ids, int32_t **out_starts, int32_t **out_ends,
                 int *out_n) {
  if (!text) return SEM_ERR_INPUT;
  if (len < 0) len = (int)strlen(text);
  const int track = (out_starts != NULL && out_ends != NULL);

  const unsigned char *s = (const unsigned char *)text;
  int rc = SEM_OK;

  /* word scratch: current word bytes (no phantom space), flushed on boundary. */
  char *word = NULL;
  int wlen = 0, wcap = 0;
  ivec ids = { NULL, 0, 0 };
  ivec st = { NULL, 0, 0 };   /* per-id start byte offset (track only) */
  ivec en = { NULL, 0, 0 };   /* per-id end byte offset                */
  ivec wbs = { NULL, 0, 0 };  /* per-flush scratch: subword word-byte starts */
  ivec wbe = { NULL, 0, 0 };
  /* per-codepoint maps for the current word (track only) */
  int *cp_wb = NULL, *cp_ss = NULL, *cp_se = NULL, cp_n = 0, cp_cap = 0;

  #define PUSH_ID_OFF(id, os, oe) do {                                        \
      if (iv_push(&ids, (id)) != 0) { rc = SEM_ERR_OOM; goto done; }          \
      if (track && (iv_push(&st, (os)) != 0 || iv_push(&en, (oe)) != 0)) {    \
        rc = SEM_ERR_OOM; goto done; }                                        \
    } while (0)

  #define WORD_PUSH(p, k, ss, se) do {                                        \
      if (track) {                                                            \
        if (cp_n == cp_cap) {                                                 \
          int ncp = cp_cap ? cp_cap * 2 : 64;                                 \
          int *a = (int *)realloc(cp_wb, (size_t)ncp * sizeof(int));          \
          int *b = (int *)realloc(cp_ss, (size_t)ncp * sizeof(int));          \
          int *c = (int *)realloc(cp_se, (size_t)ncp * sizeof(int));          \
          if (!a || !b || !c) { cp_wb=a?a:cp_wb; cp_ss=b?b:cp_ss; cp_se=c?c:cp_se; rc = SEM_ERR_OOM; goto done; } \
          cp_wb = a; cp_ss = b; cp_se = c; cp_cap = ncp;                      \
        }                                                                     \
        cp_wb[cp_n] = wlen; cp_ss[cp_n] = (ss); cp_se[cp_n] = (se); cp_n++;   \
      }                                                                       \
      if (wlen + (k) > wcap) {                                                \
        int nc = wcap ? wcap * 2 : 64;                                        \
        while (nc < wlen + (k)) nc *= 2;                                      \
        char *nw = (char *)realloc(word, (size_t)nc);                         \
        if (!nw) { rc = SEM_ERR_OOM; goto done; }                            \
        word = nw; wcap = nc;                                                 \
      }                                                                       \
      memcpy(word + wlen, (p), (size_t)(k)); wlen += (k);                     \
    } while (0)

  #define WORD_FLUSH() do {                                                   \
      if (wlen > 0) {                                                         \
        wbs.n = 0; wbe.n = 0;                                                 \
        if (wordpiece(v, word, wlen, &ids, track ? &wbs : NULL,               \
                      track ? &wbe : NULL) != 0) { rc = SEM_ERR_OOM; goto done; } \
        if (track) {                                                          \
          for (int k = 0; k < wbs.n; k++) {                                   \
            int ws = wbs.a[k], we = wbe.a[k];                                 \
            int c0 = 0; while (c0 < cp_n && cp_wb[c0] < ws) c0++;             \
            int c1 = c0; while (c1 + 1 < cp_n && cp_wb[c1 + 1] < we) c1++;    \
            int os = (c0 < cp_n) ? cp_ss[c0] : -1;                           \
            int oe = (c1 < cp_n) ? cp_se[c1] : os;                           \
            if (iv_push(&st, os) != 0 || iv_push(&en, oe) != 0) { rc = SEM_ERR_OOM; goto done; } \
          }                                                                   \
        }                                                                     \
        wlen = 0; cp_n = 0;                                                   \
      }                                                                       \
    } while (0)

  PUSH_ID_OFF(v->cls_id, -1, -1);

  for (int pos = 0; pos < len; ) {
    int src0 = pos;
    uint32_t cpt;
    pos += utf8_next(s + pos, len - pos, &cpt);
    cpt = uc_nfd(cpt);                       /* NFD-first (accent strip) */
    uint32_t fl = uc_flags(cpt);

    if (fl & UC_WHITESPACE) { WORD_FLUSH(); continue; }
    if (cpt == 0 || cpt == 0xFFFD || (fl & BGE_UC_CONTROL)) continue;

    char enc[4];
    int ne = utf8_enc(uc_tolower(cpt), enc);

    if ((fl & BGE_UC_PUNCTUATION) || (cpt < 0x7F && (fl & BGE_UC_SYMBOL)) || is_chinese(cpt)) {
      WORD_FLUSH();                  /* finish previous word */
      WORD_PUSH(enc, ne, src0, pos); /* single-char word ... */
      WORD_FLUSH();                  /* ... emitted on its own */
    } else {
      WORD_PUSH(enc, ne, src0, pos);
    }
  }
  WORD_FLUSH();

  /* truncate content so [CLS] + content + [SEP] <= n_ctx */
  if (ids.n > n_ctx - 1) {
    ids.n = n_ctx - 1;
    if (track) { st.n = n_ctx - 1; en.n = n_ctx - 1; }
  }
  PUSH_ID_OFF(v->sep_id, -1, -1);

done:
  free(word); free(cp_wb); free(cp_ss); free(cp_se);
  free(wbs.a); free(wbe.a);
  #undef PUSH_ID_OFF
  #undef WORD_PUSH
  #undef WORD_FLUSH
  if (rc != SEM_OK) { free(ids.a); free(st.a); free(en.a); return rc; }
  *out_ids = ids.a;
  *out_n = ids.n;
  if (track) { *out_starts = st.a; *out_ends = en.a; }
  return SEM_OK;
}
