/**
 * Pure decode helpers shared by the NER worker path and the quality test.
 *
 * The `semantic` C engine returns, per content token, an argmax label id, a
 * softmax score, and the [start,end) BYTE offsets into the UTF-8 input. This
 * module turns that into character-offset entity spans:
 *   1. LABELS maps the label id -> its BIO tag (the model's id2label).
 *   2. byteToCharMap converts a UTF-8 byte offset to a UTF-16 string index
 *      (JS string indexing), since the engine works in bytes and the UI in chars.
 *   3. aggregateBio folds contiguous B-/I- runs of the same tag into one span —
 *      the exact logic the transformers.js path used, now fed by precise C
 *      offsets instead of fuzzy subword string-matching.
 */

/**
 * The 51 BIO labels, id-ordered (the PII model's `config.json` id2label). The C
 * engine returns the argmax id; this is the single source of truth for the tag
 * strings. Index 0 is the "O" (outside) class.
 */
export const LABELS: readonly string[] = [
    'O',
    'B-AGE',
    'I-AGE',
    'B-COORDINATE',
    'I-COORDINATE',
    'B-CREDIT_CARD',
    'I-CREDIT_CARD',
    'B-DATE_TIME',
    'I-DATE_TIME',
    'B-EMAIL_ADDRESS',
    'I-EMAIL_ADDRESS',
    'B-FINANCIAL',
    'I-FINANCIAL',
    'B-HONORIFIC',
    'I-HONORIFIC',
    'B-IBAN_CODE',
    'I-IBAN_CODE',
    'B-IMEI',
    'I-IMEI',
    'B-IP_ADDRESS',
    'I-IP_ADDRESS',
    'B-LOCATION',
    'I-LOCATION',
    'B-MAC_ADDRESS',
    'I-MAC_ADDRESS',
    'B-NRP',
    'I-NRP',
    'B-ORGANIZATION',
    'I-ORGANIZATION',
    'B-PASSWORD',
    'I-PASSWORD',
    'B-PERSON',
    'I-PERSON',
    'B-PHONE_NUMBER',
    'I-PHONE_NUMBER',
    'B-TITLE',
    'I-TITLE',
    'B-URL',
    'I-URL',
    'B-US_BANK_NUMBER',
    'I-US_BANK_NUMBER',
    'B-US_DRIVER_LICENSE',
    'I-US_DRIVER_LICENSE',
    'B-US_ITIN',
    'I-US_ITIN',
    'B-US_LICENSE_PLATE',
    'I-US_LICENSE_PLATE',
    'B-US_PASSPORT',
    'I-US_PASSPORT',
    'B-US_SSN',
    'I-US_SSN',
];

/** One content token from `sem_ner_infer` — byte offsets into the UTF-8 input. */
export interface NerToken {
    /** Argmax label id (index into LABELS). */
    label: number;
    /** Softmax probability of the argmax class. */
    score: number;
    /** Byte offset (inclusive) into the UTF-8 encoding of the text. */
    start: number;
    /** Byte offset (exclusive). */
    end: number;
}

/**
 * A per-token prediction in CHARACTER offsets, ready for BIO aggregation. Both
 * the C engine path (via `tokensToPlaced`) and the comparison ONNX path produce
 * these, so they share one `aggregateBio` — A/B differences then isolate to the
 * model/tokenizer, not the aggregation.
 */
export interface PlacedToken {
    /** Full BIO label string (e.g. "B-PERSON", "O"). */
    entity: string;
    score: number;
    start: number;
    end: number;
}

/** An aggregated entity span in CHARACTER (UTF-16 string index) offsets. */
export interface NerSpan {
    /** The BIO tag without its B-/I- prefix (e.g. "PERSON"). */
    entity_type: string;
    start: number;
    end: number;
    /** Mean softmax score across the tokens in the span. */
    score: number;
    text: string;
}

/**
 * Build a UTF-8-byte-offset -> UTF-16-string-index map for `text`. The C engine
 * reports byte offsets; JS string slicing wants code-unit indices. For pure ASCII
 * this is the identity; multibyte code points shift it. Returns an array of length
 * (utf8ByteLength + 1): every byte of a code point maps to that code point's
 * starting string index, and the final slot maps the end.
 */
/** UTF-8 byte length of a single code point. */
function utf8ByteLen(cp: number): number {
    if (cp < 0x80) return 1;
    if (cp < 0x800) return 2;
    if (cp < 0x10000) return 3;
    return 4;
}

/** UTF-16 code-unit length of a single code point. */
function utf16UnitLen(cp: number): number {
    return cp > 0xffff ? 2 : 1;
}

export function byteToCharMap(text: string): Int32Array {
    // Total UTF-8 byte length, computed without allocating the encoded bytes.
    let nbytes = 0;
    for (const ch of text) nbytes += utf8ByteLen(ch.codePointAt(0)!);
    const map = new Int32Array(nbytes + 1);
    let bytePos = 0;
    let charPos = 0;
    for (const ch of text) {
        const cp = ch.codePointAt(0)!;
        const blen = utf8ByteLen(cp);
        const clen = utf16UnitLen(cp); // UTF-16 code units
        for (let b = 0; b < blen; b++) map[bytePos + b] = charPos;
        bytePos += blen;
        charPos += clen;
    }
    map[nbytes] = charPos;
    return map;
}

function splitBio(label: string): readonly [prefix: 'B' | 'I' | 'O', tag: string] {
    if (label === 'O') return ['O', ''];
    if (label.length > 1 && label[1] === '-') {
        const p = label[0];
        if (p === 'B' || p === 'I') return [p, label.slice(2)];
    }
    // Lenient: treat any unprefixed label as a continuation tag.
    return ['I', label];
}

/**
 * Map the C engine's byte-offset tokens to character-offset `PlacedToken`s
 * (resolving the label id to its BIO string). Out-of-range offsets are clamped
 * defensively (the C engine should already be exact).
 */
export function tokensToPlaced(tokens: readonly NerToken[], text: string): PlacedToken[] {
    const b2c = byteToCharMap(text);
    const nbytes = b2c.length - 1;
    return tokens.map((t) => {
        const sb = Math.max(0, Math.min(t.start, nbytes));
        const eb = Math.max(sb, Math.min(t.end, nbytes));
        return { entity: LABELS[t.label] ?? 'O', score: t.score, start: b2c[sb]!, end: b2c[eb]! };
    });
}

/**
 * Fold per-token predictions into entity spans. `placed` are content tokens in
 * character offsets and text order ([CLS]/[SEP] excluded). `B-X` always opens a
 * new group; `I-X` extends the previous group if it had the same tag, else opens
 * one (lenient mode, matching HuggingFace's `simple` strategy). 'O' flushes.
 * Output spans carry the substring + the mean token score.
 */
export function aggregateBio(placed: readonly PlacedToken[], text: string): NerSpan[] {
    const out: NerSpan[] = [];
    let open: { tag: string; start: number; end: number; scoreSum: number; n: number } | null =
        null;

    const flush = () => {
        if (!open) return;
        out.push({
            entity_type: open.tag,
            start: open.start,
            end: open.end,
            score: open.scoreSum / open.n,
            text: text.slice(open.start, open.end),
        });
        open = null;
    };

    for (const p of placed) {
        if (p.entity === 'O') {
            flush();
            continue;
        }
        const [prefix, tag] = splitBio(p.entity);
        const extend = open && open.tag === tag && prefix !== 'B';
        if (extend && open) {
            open.end = p.end;
            open.scoreSum += p.score;
            open.n += 1;
        } else {
            flush();
            open = { tag, start: p.start, end: p.end, scoreSum: p.score, n: 1 };
        }
    }
    flush();
    return out;
}
