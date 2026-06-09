// Regex-only PII recognizers, inspired by Microsoft Presidio's
// PatternRecognizer set. Covers the common structured types — emails,
// phone numbers, network identifiers, financial numbers, US/UK
// government IDs, popular crypto/secret tokens — so the worker can
// still highlight obvious PII when the user opts out of downloading
// the TinyBERT model.
//
// Each recognizer has an optional validator (Luhn for cards, MOD-97
// for IBAN, ABA checksum for routing numbers, etc.) — score weights
// patterns by how confident the match is in isolation; the resolver
// uses score + length to drop overlapping matches.

import type { PiiEntity, AnalyzeStats } from './worker';

interface Recognizer {
    type: string;
    /** Must have the `g` flag. */
    pattern: RegExp;
    /** 0..1, used for overlap resolution and surfaced to the UI. */
    score: number;
    /** Optional post-match validator. Receives the full match string. */
    validate?: (match: string) => boolean;
}

function luhn(s: string): boolean {
    const d = s.replace(/\D/g, '');
    if (d.length < 13 || d.length > 19) return false;
    let sum = 0;
    let alt = false;
    for (let i = d.length - 1; i >= 0; i--) {
        let v = d.charCodeAt(i) - 48;
        if (alt) {
            v *= 2;
            if (v > 9) v -= 9;
        }
        sum += v;
        alt = !alt;
    }
    return sum % 10 === 0;
}

// ABA routing-number check: weighted sum of digits must be 0 mod 10.
function abaRouting(s: string): boolean {
    const d = s.replace(/\D/g, '');
    if (d.length !== 9) return false;
    const sum =
        3 * (+d[0]! + +d[3]! + +d[6]!) +
        7 * (+d[1]! + +d[4]! + +d[7]!) +
        1 * (+d[2]! + +d[5]! + +d[8]!);
    return sum % 10 === 0;
}

// ISO 7064 MOD-97-10 for IBAN. Move first 4 chars to end, convert
// letters (A=10..Z=35) to digits, take mod 97; valid IBAN gives 1.
function ibanMod97(raw: string): boolean {
    const s = raw.replace(/\s/g, '').toUpperCase();
    if (s.length < 15 || s.length > 34) return false;
    const rearranged = s.slice(4) + s.slice(0, 4);
    let r = 0;
    for (let i = 0; i < rearranged.length; i++) {
        const c = rearranged.charCodeAt(i);
        let v: number;
        if (c >= 48 && c <= 57) v = c - 48;
        else if (c >= 65 && c <= 90) v = c - 55;
        else return false;
        r = v > 9 ? (r * 100 + v) % 97 : (r * 10 + v) % 97;
    }
    return r === 1;
}

function ipv6Shape(s: string): boolean {
    if (s.indexOf(':::') >= 0) return false;
    const dc = (s.match(/::/g) ?? []).length;
    if (dc > 1) return false;
    const parts = s.split(':');
    if (parts.length > 8) return false;
    let nonEmpty = 0;
    for (const p of parts) {
        if (p.length > 4) return false;
        if (p) {
            if (!/^[0-9A-Fa-f]+$/.test(p)) return false;
            nonEmpty++;
        }
    }
    // Require at least two real hex groups so we don't classify a
    // single-token leftover ("a:b") as IPv6.
    if (nonEmpty < 2) return false;
    if (dc === 0) return parts.length === 8;
    return parts.length <= 8;
}

// ISO YYYY-MM-DD, US MM/DD/YYYY, or short MM/YY exp dates.
// PII date pattern: the three calendar alternatives (ISO / US slash / MM-YY
// expiry) must stay literal to keep exact match boundaries; input is bounded
// short text.
// prettier-ignore
// eslint-disable-next-line sonarjs/regex-complexity
const DATE_PATTERN = /\b(?:\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])|(?:0?[1-9]|1[0-2])\/(?:0?[1-9]|[12]\d|3[01])\/\d{2,4}|(?:0[1-9]|1[0-2])\/\d{2}(?:\d{2})?)\b/g;

export const RECOGNIZERS: readonly Recognizer[] = [
    // --- Network / digital ---
    {
        type: 'email',
        pattern:
            /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+\b/g,
        score: 0.9,
    },
    {
        type: 'url',
        pattern: /\b(?:https?|ftp):\/\/[^\s<>"'`)]+/g,
        score: 0.75,
    },
    {
        type: 'ip_address',
        pattern:
            /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g,
        score: 0.8,
    },
    {
        type: 'ipv6_address',
        pattern: /(?<![A-Za-z0-9:])(?:[A-Fa-f0-9]{0,4}:){2,7}[A-Fa-f0-9]{0,4}(?![A-Za-z0-9:])/g,
        score: 0.7,
        validate: ipv6Shape,
    },
    {
        type: 'mac_address',
        pattern: /\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/g,
        score: 0.9,
    },
    {
        type: 'domain_name',
        // Labels are length-bounded ({0,61}) and dot-separated, so backtracking
        // is bounded; input is also capped to MAX_SCAN_CHARS in analyzeRegex.
        // (eslint-disable-line on the literal so it survives prettier reflow.)
        pattern:
            /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|io|co|edu|gov|info|biz|app|dev|ai|uk|us|de|fr|jp|ca|au)\b/gi, // eslint-disable-line sonarjs/regex-complexity -- bounded + input-capped
        score: 0.45,
    },

    // --- Phone numbers ---
    {
        // International form with explicit "+CC".
        type: 'phone_number',
        pattern: /\+\d{1,3}(?:[\s.()-]+\d{1,4}){2,5}(?!\d)/g,
        score: 0.75,
    },
    {
        // North-American 10-digit form: (415) 555-0132, 415-555-0132.
        type: 'phone_number',
        pattern: /\b(?:\(\d{3}\)\s?\d{3}[-.\s]\d{4}|\d{3}[-.\s]\d{3}[-.\s]\d{4})\b/g,
        score: 0.65,
    },

    // --- Financial ---
    {
        type: 'credit_debit_card',
        pattern: /\b(?:\d[ -]?){12,18}\d\b/g,
        score: 0.85,
        validate: luhn,
    },
    {
        type: 'us_bank_routing',
        pattern: /\b\d{9}\b/g,
        score: 0.6,
        validate: abaRouting,
    },
    {
        type: 'iban_code',
        pattern: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{1,4}){2,8}\b/g,
        score: 0.85,
        validate: ibanMod97,
    },
    {
        type: 'swift_code',
        pattern: /\b[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?\b/g,
        score: 0.6,
    },
    {
        type: 'bitcoin_address',
        pattern: /\b(?:bc1[a-z0-9]{25,87}|[13][A-HJ-NP-Za-km-z1-9]{25,34})\b/g,
        score: 0.6,
    },
    {
        type: 'ethereum_address',
        pattern: /\b0x[a-fA-F0-9]{40}\b/g,
        score: 0.9,
    },

    // --- US identifiers ---
    {
        type: 'us_ssn',
        pattern: /\b(?!000|666|9\d{2})\d{3}[- ](?!00)\d{2}[- ](?!0000)\d{4}\b/g,
        score: 0.9,
    },
    {
        type: 'us_itin',
        pattern: /\b9\d{2}[- ](?:7\d|8[0-8])[- ]\d{4}\b/g,
        score: 0.85,
    },
    {
        type: 'us_passport',
        pattern: /\b\d{9}\b/g,
        score: 0.35,
    },
    {
        type: 'us_driver_license',
        pattern: /\b[A-Z]\d{6,8}\b/g,
        score: 0.4,
    },
    {
        type: 'us_zip',
        pattern: /\b\d{5}(?:-\d{4})?\b/g,
        score: 0.45,
    },

    // --- UK identifiers ---
    {
        type: 'uk_nin',
        pattern: /\b[A-CEGHJ-PR-TW-Z]{2} ?\d{2} ?\d{2} ?\d{2} ?[A-D]\b/g,
        score: 0.75,
    },
    {
        type: 'uk_nhs',
        pattern: /\b\d{3}[ -]\d{3}[ -]\d{4}\b/g,
        score: 0.5,
    },
    {
        type: 'uk_postcode',
        pattern: /\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/g,
        score: 0.65,
    },

    // --- Secrets / API keys ---
    {
        type: 'aws_access_key',
        pattern: /\b(?:AKIA|ASIA|AIDA|AGPA|AROA|AIPA|ANPA|ANVA)[0-9A-Z]{16}\b/g,
        score: 0.95,
    },
    {
        type: 'github_token',
        pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_\w{20,}\b|\bgithub_pat_\w{22,}\b/g,
        score: 0.95,
    },
    {
        type: 'api_key',
        pattern: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}\b/g,
        score: 0.9,
    },
    {
        type: 'jwt',
        pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
        score: 0.9,
    },
    {
        type: 'private_key_pem',
        pattern:
            /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY-----/g,
        score: 0.99,
    },

    // --- Misc identifiers / temporal ---
    {
        type: 'uuid',
        pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
        score: 0.9,
    },
    {
        type: 'date',
        pattern: DATE_PATTERN,
        score: 0.65,
    },
    {
        type: 'time',
        pattern: /\b(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?\b/g,
        score: 0.55,
    },
];

interface Candidate {
    type: string;
    start: number;
    end: number;
    score: number;
}

function resolveOverlaps(matches: Candidate[]): Candidate[] {
    if (matches.length < 2) return matches;
    // Higher score wins; on tie, longer span; on tie, earlier start.
    const sorted = [...matches].sort((a, b) => {
        if (a.score !== b.score) return b.score - a.score;
        const la = a.end - a.start;
        const lb = b.end - b.start;
        if (la !== lb) return lb - la;
        return a.start - b.start;
    });
    const accepted: Candidate[] = [];
    for (const m of sorted) {
        let conflict = false;
        for (const a of accepted) {
            if (m.start < a.end && m.end > a.start) {
                conflict = true;
                break;
            }
        }
        if (!conflict) accepted.push(m);
    }
    return accepted.sort((a, b) => a.start - b.start);
}

// Upper bound on the text scanned per call. Regex PII detection is a
// best-effort highlight; an unbounded pass over pathological input risks
// super-linear backtracking (sonarjs/slow-regex, /regex-complexity) hanging
// the worker. Beyond this we scan the prefix and report truncation rather
// than risk a freeze. 200k chars comfortably covers normal review pastes.
const MAX_SCAN_CHARS = 200_000;

export function analyzeRegex(text: string): { entities: PiiEntity[]; stats: AnalyzeStats } {
    if (!text.trim()) return { entities: [], stats: { inferMs: 0, rawSpanCount: 0 } };
    const truncated = text.length > MAX_SCAN_CHARS;
    const scan = truncated ? text.slice(0, MAX_SCAN_CHARS) : text;
    const t0 = performance.now();
    const candidates: Candidate[] = [];
    for (const r of RECOGNIZERS) {
        // Patterns are declared global so .exec advances lastIndex; reset
        // first in case a previous run left it nonzero.
        r.pattern.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = r.pattern.exec(scan)) !== null) {
            if (m[0].length === 0) {
                r.pattern.lastIndex++;
                continue;
            }
            if (r.validate && !r.validate(m[0])) continue;
            candidates.push({
                type: r.type,
                start: m.index,
                end: m.index + m[0].length,
                score: r.score,
            });
        }
    }
    const resolved = resolveOverlaps(candidates);
    const entities: PiiEntity[] = resolved.map((c) => ({
        entity_type: c.type,
        start: c.start,
        end: c.end,
        score: c.score,
        text: scan.slice(c.start, c.end),
    }));
    return {
        entities,
        stats: {
            inferMs: performance.now() - t0,
            rawSpanCount: candidates.length,
            ...(truncated ? { truncated } : {}),
        },
    };
}
