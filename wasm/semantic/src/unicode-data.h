/*
** Unicode lookup tables for the WPM tokenizer's text preprocessing.
**
** The .c counterpart is GENERATED — do not edit by hand. Regenerate with:
**   python wasm/bge-embed/tools/gen-unicode-data.py > wasm/bge-embed/src/unicode-data.c
** (it reads UnicodeData.txt + Python's unicodedata, mirroring the public
** algorithm llama.cpp's scripts/gen-unicode-data.py uses, so tokenization
** matches the llama.cpp WPM tokenizer codepoint-for-codepoint).
**
** Three tables drive preprocessing:
**   - ranges_flags : codepoint -> Unicode general-category flags (run-length
**     encoded; the flags at entry i apply to [start_i, start_{i+1}-1]).
**   - whitespace   : sorted codepoints treated as whitespace (\t\n\r, NBSP, …),
**     OR-ed onto the category flags at lookup time.
**   - lowercase    : simple lowercase mapping (cpt -> cpt).
**   - nfd          : first codepoint of each codepoint's NFD decomposition
**     (cpt -> base letter); this is the accent-strip step (é -> e).
*/
#ifndef BGE_UNICODE_DATA_H
#define BGE_UNICODE_DATA_H

#include <stdint.h>

/* General-category flag bits (match llama.cpp's unicode_cpt_flags layout). */
#define BGE_UC_UNDEFINED   0x0001
#define BGE_UC_NUMBER      0x0002
#define BGE_UC_LETTER      0x0004
#define BGE_UC_SEPARATOR   0x0008
#define BGE_UC_MARK        0x0010
#define BGE_UC_PUNCTUATION 0x0020
#define BGE_UC_SYMBOL      0x0040
#define BGE_UC_CONTROL     0x0080

typedef struct { uint32_t start; uint16_t flags; } bge_uc_range_flags;
typedef struct { uint32_t key; uint32_t val; } bge_uc_pair;

/* Run-length category table: flags[i] applies for start[i] <= cpt < start[i+1].
** Sentinel final entry has start = 0x110000. Sorted ascending by start. */
extern const bge_uc_range_flags bge_uc_ranges_flags[];
extern const int                bge_uc_ranges_flags_count;

/* Sorted ascending. */
extern const uint32_t bge_uc_whitespace[];
extern const int      bge_uc_whitespace_count;

/* Sorted ascending by key. */
extern const bge_uc_pair bge_uc_lowercase[];
extern const int         bge_uc_lowercase_count;

/* Sorted ascending by key. cpt -> first codepoint of NFD(cpt). */
extern const bge_uc_pair bge_uc_nfd[];
extern const int         bge_uc_nfd_count;

#endif /* BGE_UNICODE_DATA_H */
