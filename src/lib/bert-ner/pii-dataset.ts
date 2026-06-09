/**
 * A small hand-labeled PII dataset + an overlap-based scorer, used by the NER
 * quality test (src/lib/bert-ner/quality.test.ts) and the /tests browser testbed.
 *
 * Each case marks gold PII spans by SUBSTRING (`value`, with an optional `nth`
 * occurrence) rather than raw offsets, so hand-labeling is reliable — `resolveSpans`
 * computes the char offsets via indexOf and throws loudly if a value is missing
 * (a typo fails the dataset, not the model). Texts are seeded from the original
 * /pii samples plus a spread of entity types and a few PII-free negatives.
 *
 * Scoring is DETECTION-oriented (the headline question: "did we flag the PII
 * characters?"): a gold span counts as detected if ANY predicted span overlaps it,
 * and a predicted span is a false positive only if it overlaps NO gold span. This
 * rewards catching PII and doesn't punish a model that over-segments one entity
 * into several tokens. `scoreTyped` additionally requires the entity family to
 * match (regex "email" and NER "EMAIL_ADDRESS" both normalize to "EMAIL").
 */

export interface GoldSpan {
    /** Canonical entity family (PERSON, EMAIL, CREDIT_CARD, …). */
    type: string;
    /** The exact PII substring as it appears in `text`. */
    value: string;
    /** 0-based occurrence of `value` to use when it appears more than once. */
    nth?: number;
}

export interface PiiCase {
    label: string;
    text: string;
    spans: GoldSpan[];
}

export interface ResolvedSpan {
    type: string;
    start: number;
    end: number;
}

/** A predicted span, as produced by the analyze() pipeline (char offsets). */
export interface PredSpan {
    entity_type: string;
    start: number;
    end: number;
}

export const PII_DATASET: PiiCase[] = [
    // --- the four original /pii samples ---
    {
        label: 'Customer service ticket',
        text:
            'Hi, my name is Alice Smith and I live at 742 Evergreen Terrace, ' +
            'Springfield, OR 62704, USA. You can reach me on +1 (415) 555-0132 ' +
            'or at alice.smith@example.com. My account number is 8810-447-2219.',
        spans: [
            { type: 'PERSON', value: 'Alice Smith' },
            { type: 'LOCATION', value: '742 Evergreen Terrace' },
            { type: 'LOCATION', value: 'Springfield' },
            { type: 'PHONE', value: '+1 (415) 555-0132' },
            { type: 'EMAIL', value: 'alice.smith@example.com' },
        ],
    },
    {
        label: 'KYC-style intake',
        text:
            'Applicant: John Doe, DOB 1987-03-14, age 38. ' +
            'SSN 123-45-6789, driver license D1234567 (CA), passport AB1234567. ' +
            'Card on file: 4012 8888 8888 1881, CVV 321, exp 04/27. ' +
            'Routing 021000021, SWIFT CHASUS33.',
        spans: [
            { type: 'PERSON', value: 'John Doe' },
            { type: 'DATE_TIME', value: '1987-03-14' },
            { type: 'SSN', value: '123-45-6789' },
            { type: 'CREDIT_CARD', value: '4012 8888 8888 1881' },
        ],
    },
    {
        label: 'Account creation + network',
        text:
            "New user 'maria_h' registered with password Hunter2! and email " +
            'maria.hernandez@example.org. Phone +44 20 7946 0958, address ' +
            '10 Downing Street, London, SW1A 2AA. Logged in from 192.168.1.42 ' +
            'and 2001:db8::1; MAC 3c:22:fb:91:0a:7e; API key sk_live_a1b2c3d4e5f6.',
        spans: [
            { type: 'EMAIL', value: 'maria.hernandez@example.org' },
            { type: 'PHONE', value: '+44 20 7946 0958' },
            { type: 'LOCATION', value: '10 Downing Street' },
            // eslint-disable-next-line sonarjs/no-hardcoded-ip -- test fixture: example IP
            { type: 'IP_ADDRESS', value: '192.168.1.42' },
            { type: 'IP_ADDRESS', value: '2001:db8::1' },
            { type: 'MAC_ADDRESS', value: '3c:22:fb:91:0a:7e' },
        ],
    },
    {
        label: 'Clinical + employment record',
        text:
            'Patient Sarah Chen, female, blood type O+, MRN 778-3321, ' +
            'health plan 8810-447. Works as a Software Engineer at Acme Corp ' +
            '(employee ID E-44219), currently employed. Native language English, ' +
            'lives in Toronto, Ontario, Canada. Visit on 2025-04-12 at 14:30.',
        spans: [
            { type: 'PERSON', value: 'Sarah Chen' },
            { type: 'ORGANIZATION', value: 'Acme Corp' },
            { type: 'LOCATION', value: 'Toronto' },
            { type: 'DATE_TIME', value: '2025-04-12' },
        ],
    },

    // --- names & honorifics ---
    {
        label: 'Names, mixed',
        text: 'Please CC Dr. Robert Müller and Priya Patel on the thread about the Q3 audit.',
        spans: [
            { type: 'PERSON', value: 'Robert Müller' },
            { type: 'PERSON', value: 'Priya Patel' },
        ],
    },
    {
        label: 'Signature block',
        text: 'Best regards,\nJames O’Connor\nSenior Analyst, Globex International',
        spans: [
            { type: 'PERSON', value: 'James O’Connor' },
            { type: 'ORGANIZATION', value: 'Globex International' },
        ],
    },

    // --- emails & urls ---
    {
        label: 'Emails only',
        text: 'Forward the invoice to billing@northwind.co and cc finance.team@northwind.co please.', // secret-scan-allow -- example emails, PII-detection fixture
        spans: [
            { type: 'EMAIL', value: 'billing@northwind.co' }, // secret-scan-allow -- example email, PII-detection fixture
            { type: 'EMAIL', value: 'finance.team@northwind.co' }, // secret-scan-allow -- example email, PII-detection fixture
        ],
    },
    {
        label: 'URL + profile',
        text: 'My portfolio is at https://www.jane-doe.dev/work and GitHub github.com/janedoe.',
        spans: [
            { type: 'URL', value: 'https://www.jane-doe.dev/work' },
            { type: 'URL', value: 'github.com/janedoe' },
        ],
    },

    // --- phones ---
    {
        label: 'US phone variants',
        text: 'Call me at (212) 555-0188 or my cell 646-555-0199 after 5pm.',
        spans: [
            { type: 'PHONE', value: '(212) 555-0188' },
            { type: 'PHONE', value: '646-555-0199' },
        ],
    },
    {
        label: 'Intl phone',
        text: 'Our Berlin office: +49 30 901820. Ask for Klaus.',
        spans: [
            { type: 'PHONE', value: '+49 30 901820' },
            { type: 'PERSON', value: 'Klaus' },
        ],
    },

    // --- financial / govt ids ---
    {
        label: 'Credit cards',
        text: 'Visa 4111 1111 1111 1111 expiring 12/26; backup Mastercard 5500005555555559.',
        spans: [
            { type: 'CREDIT_CARD', value: '4111 1111 1111 1111' },
            { type: 'CREDIT_CARD', value: '5500005555555559' },
        ],
    },
    {
        label: 'IBAN + SWIFT',
        text: 'Wire to IBAN DE89 3704 0044 0532 0130 00 (BIC COBADEFFXXX) by Friday.',
        spans: [{ type: 'IBAN', value: 'DE89 3704 0044 0532 0130 00' }],
    },
    {
        label: 'SSN + ITIN',
        text: 'Taxpayer SSN 078-05-1120; spouse ITIN 900-70-0000 on the joint return.',
        spans: [
            { type: 'SSN', value: '078-05-1120' },
            { type: 'US_ITIN', value: '900-70-0000' },
        ],
    },
    {
        label: 'Driver license + passport',
        text: 'License Y1234567 issued in Texas; US passport 310928461 expires 2030.',
        spans: [
            { type: 'US_DRIVER_LICENSE', value: 'Y1234567' },
            { type: 'US_PASSPORT', value: '310928461' },
            { type: 'LOCATION', value: 'Texas' },
        ],
    },

    // --- network / credentials ---
    {
        label: 'IPv4 + IPv6 + MAC',
        text: 'Server reachable at 10.0.12.7 and fe80::1ff:fe23:4567:890a; NIC 00:1b:44:11:3a:b7.',
        spans: [
            // eslint-disable-next-line sonarjs/no-hardcoded-ip -- test fixture: example IP
            { type: 'IP_ADDRESS', value: '10.0.12.7' },
            // eslint-disable-next-line sonarjs/no-hardcoded-ip -- test fixture: example IP
            { type: 'IP_ADDRESS', value: 'fe80::1ff:fe23:4567:890a' },
            { type: 'MAC_ADDRESS', value: '00:1b:44:11:3a:b7' },
        ],
    },
    {
        label: 'Secrets',
        // eslint-disable-next-line no-secrets/no-secrets
        text: 'export AWS_SECRET=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY and token ghp_16C7e42F292c6912E7710c838347Ae178B4a.', // secret-scan-allow -- example tokens, PII-detection fixture
        spans: [
            { type: 'PASSWORD', value: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
            { type: 'PASSWORD', value: 'ghp_16C7e42F292c6912E7710c838347Ae178B4a' }, // secret-scan-allow -- example token, PII-detection fixture
        ],
    },

    // --- locations & orgs ---
    {
        label: 'Address block',
        text: 'Ship to 1600 Amphitheatre Parkway, Mountain View, CA 94043, attention Logistics.',
        spans: [
            { type: 'LOCATION', value: '1600 Amphitheatre Parkway' },
            { type: 'LOCATION', value: 'Mountain View' },
        ],
    },
    {
        label: 'Orgs',
        text: 'The merger between Initech and Umbrella Corporation closed last quarter.',
        spans: [
            { type: 'ORGANIZATION', value: 'Initech' },
            { type: 'ORGANIZATION', value: 'Umbrella Corporation' },
        ],
    },

    // --- dates / ages ---
    {
        label: 'Dates and age',
        text: 'Born on March 3, 1990 (age 35); last login 2024-11-30 09:15 UTC.',
        spans: [
            { type: 'DATE_TIME', value: 'March 3, 1990' },
            { type: 'AGE', value: '35' },
            { type: 'DATE_TIME', value: '2024-11-30' },
        ],
    },

    // --- multi-entity dense ---
    {
        label: 'Dense mixed',
        text:
            'Customer Olivia Brown (olivia.brown@mail.com, +1-202-555-0143) paid with ' + // secret-scan-allow -- example email, PII-detection fixture
            'card 6011 0009 9013 9424 from 203.0.113.7 on 2023-07-04.',
        spans: [
            { type: 'PERSON', value: 'Olivia Brown' },
            { type: 'EMAIL', value: 'olivia.brown@mail.com' }, // secret-scan-allow -- example email, PII-detection fixture
            { type: 'PHONE', value: '+1-202-555-0143' },
            { type: 'CREDIT_CARD', value: '6011 0009 9013 9424' },
            { type: 'IP_ADDRESS', value: '203.0.113.7' },
            { type: 'DATE_TIME', value: '2023-07-04' },
        ],
    },

    // --- negatives (no PII) ---
    {
        label: 'Negative: generic prose',
        text: 'The quarterly report shows revenue grew while operating costs stayed flat.',
        spans: [],
    },
    {
        label: 'Negative: numbers without identity',
        text: 'Order 12 units at $4.50 each; total comes to fifty-four dollars before tax.',
        spans: [],
    },
    {
        label: 'Negative: product talk',
        text: 'Our new dashboard loads faster and the export button finally works on mobile.',
        spans: [],
    },
];

/** Resolve a case's gold spans to char offsets via indexOf; throws on a missing value. */
export function resolveSpans(c: PiiCase): ResolvedSpan[] {
    return c.spans.map((s) => {
        const nth = s.nth ?? 0;
        let from = -1;
        for (let i = 0; i <= nth; i++) {
            from = c.text.indexOf(s.value, from + 1);
            if (from < 0) break;
        }
        if (from < 0) {
            throw new Error(
                `[pii-dataset] value not found in "${c.label}": ${JSON.stringify(s.value)} (nth=${nth})`,
            );
        }
        return { type: s.type, start: from, end: from + s.value.length };
    });
}

/**
 * Ordered family rules: the first whose `match(u)` (on the upper-cased label) is
 * true wins. Order is significant — it preserves the original if-chain precedence
 * (e.g. EMAIL before PHONE, IP before MAC, etc.).
 */
const TYPE_RULES: ReadonlyArray<{ family: string; match: (u: string) => boolean }> = [
    { family: 'EMAIL', match: (u) => u.includes('EMAIL') },
    { family: 'PHONE', match: (u) => u.includes('PHONE') },
    { family: 'CREDIT_CARD', match: (u) => u.includes('CREDIT') || u.includes('CARD') },
    { family: 'IBAN', match: (u) => u.includes('IBAN') },
    { family: 'SSN', match: (u) => u.includes('SSN') },
    { family: 'US_ITIN', match: (u) => u.includes('ITIN') },
    { family: 'US_PASSPORT', match: (u) => u.includes('PASSPORT') },
    { family: 'US_DRIVER_LICENSE', match: (u) => u.includes('DRIVER') || u.includes('LICENSE') },
    { family: 'IP_ADDRESS', match: (u) => u.includes('IP') || u === 'IPV4' || u === 'IPV6' },
    { family: 'MAC_ADDRESS', match: (u) => u.includes('MAC') },
    { family: 'URL', match: (u) => u.includes('URL') || u.includes('DOMAIN') },
    { family: 'PERSON', match: (u) => u.includes('PERSON') || u === 'NAME' },
    {
        family: 'LOCATION',
        match: (u) => u.includes('LOCATION') || u.includes('ADDRESS') || u === 'GPE' || u === 'LOC',
    },
    { family: 'ORGANIZATION', match: (u) => u.includes('ORG') },
    { family: 'DATE_TIME', match: (u) => u.includes('DATE') || u.includes('TIME') },
    { family: 'AGE', match: (u) => u.includes('AGE') },
    {
        family: 'PASSWORD',
        match: (u) =>
            u.includes('PASSWORD') ||
            u.includes('KEY') ||
            u.includes('TOKEN') ||
            u.includes('SECRET'),
    },
];

/** Normalize a detector's label (NER tag or regex name) to a coarse PII family. */
export function normalizeType(t: string): string {
    const u = t.toUpperCase();
    return TYPE_RULES.find((r) => r.match(u))?.family ?? u;
}

export interface Score {
    tp: number;
    fp: number;
    fn: number;
    precision: number;
    recall: number;
    f1: number;
}

function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
    return a.start < b.end && b.start < a.end;
}

/**
 * Detection score (type-agnostic): a gold is a TP if ANY pred overlaps it; a pred
 * is a FP if it overlaps NO gold. Aggregate micro-counts across cases by summing.
 */
export function scoreDetection(preds: PredSpan[], golds: ResolvedSpan[]): Score {
    const tp = golds.filter((g) => preds.some((p) => overlaps(p, g))).length;
    const fn = golds.length - tp;
    const fp = preds.filter((p) => !golds.some((g) => overlaps(p, g))).length;
    return finalize(tp, fp, fn);
}

/** Type-aware score: overlap AND matching normalized family. */
export function scoreTyped(preds: PredSpan[], golds: ResolvedSpan[]): Score {
    const match = (p: PredSpan, g: ResolvedSpan) =>
        overlaps(p, g) && normalizeType(p.entity_type) === normalizeType(g.type);
    const tp = golds.filter((g) => preds.some((p) => match(p, g))).length;
    const fn = golds.length - tp;
    const fp = preds.filter((p) => !golds.some((g) => match(p, g))).length;
    return finalize(tp, fp, fn);
}

function finalize(tp: number, fp: number, fn: number): Score {
    const precision = tp + fp > 0 ? tp / (tp + fp) : 1;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 1;
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
    return { tp, fp, fn, precision, recall, f1 };
}

/** Sum per-case micro-counts into one corpus-level score. */
export function microScore(scores: Score[]): Score {
    const tp = scores.reduce((s, x) => s + x.tp, 0);
    const fp = scores.reduce((s, x) => s + x.fp, 0);
    const fn = scores.reduce((s, x) => s + x.fn, 0);
    return finalize(tp, fp, fn);
}
