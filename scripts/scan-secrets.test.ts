import { describe, it, expect } from 'vitest';
import { scanText, DETECTORS } from './scan-secrets.ts';

// Fixtures are assembled at runtime (concatenation / repeat) so the literal
// secret patterns never appear in this file's source — otherwise the scanner
// would flag its own test on a `--all` sweep.
const FAKE = {
    openrouter: 'sk-or-v1-' + 'a'.repeat(64),
    gemini: 'AQ.' + 'Ab12Cd34'.repeat(6), // AQ. + 48 chars
    googleAiza: 'AIza' + 'B'.repeat(35),
    openai: 'sk-' + 'X'.repeat(28),
    anthropic: 'sk-ant-' + 'Z'.repeat(40),
    aws: 'AKIA' + 'ABCDEFGHIJKLMNOP',
    github: 'ghp_' + 'q'.repeat(36),
    slack: 'xoxb-' + '1234567890-0987654321-abcdEFGHijklMNOP',
    stripe: 'sk_live_' + 'k'.repeat(24),
    jwt: ['eyJ' + 'abcdefghij', 'eyJ' + 'klmnopqrst', 'uvwxyz0123'].join('.'),
    uuid: '123e4567-e89b-12d3-' + 'a456-426614174000',
    privateKey: '-----BEGIN RSA ' + 'PRIVATE KEY-----',
    email: 'alice.smith' + '@' + 'acme.io',
    highEntropyValue: 'Gh7kL2mNp9qR4zT8wbY1',
};

function ids(text: string): string[] {
    return scanText(text).map((f) => f.detectorId);
}

describe('scanText — high-severity credentials', () => {
    it.each([
        ['openrouter-key', FAKE.openrouter],
        ['google-gemini-key', FAKE.gemini],
        ['google-api-key', FAKE.googleAiza],
        ['openai-key', FAKE.openai],
        ['anthropic-key', FAKE.anthropic],
        ['aws-access-key', FAKE.aws],
        ['github-token', FAKE.github],
        ['slack-token', FAKE.slack],
        ['stripe-key', FAKE.stripe],
    ])('detects %s', (id, secret) => {
        const found = scanText(`const k = '${secret}';`);
        expect(found.map((f) => f.detectorId)).toContain(id);
        expect(found.find((f) => f.detectorId === id)!.severity).toBe('high');
    });

    it('detects a private key block', () => {
        expect(ids(FAKE.privateKey)).toContain('private-key-block');
    });

    it('never echoes the full secret in the preview', () => {
        const [hit] = scanText(`x = '${FAKE.openrouter}'`);
        expect(hit.preview).not.toContain(FAKE.openrouter);
        expect(hit.preview).toContain('redacted');
    });
});

describe('scanText — emails', () => {
    it('flags a real-looking email', () => {
        const found = scanText('contact ' + FAKE.email + ' for access');
        expect(found.map((f) => f.detectorId)).toContain('email');
        expect(found[0].preview).toContain('@acme.io');
        expect(found[0].preview).not.toContain('alice.smith');
    });

    it('suppresses reserved example/test domains by default', () => {
        expect(ids('user bob' + '@example.com placeholder')).not.toContain('email');
        expect(ids('user x' + '@host.invalid')).not.toContain('email');
    });

    it('keeps example emails when skipExampleEmails is off', () => {
        const found = scanText('bob' + '@example.com', { skipExampleEmails: false });
        expect(found.map((f) => f.detectorId)).toContain('email');
    });
});

describe('scanText — generic assignment & jwt', () => {
    it('flags a high-entropy secret assignment', () => {
        const line = 'const password = ' + JSON.stringify(FAKE.highEntropyValue) + ';';
        expect(ids(line)).toContain('generic-secret-assignment');
    });

    it('ignores obvious placeholders', () => {
        const line = 'const apiKey = ' + JSON.stringify('your-api-key-here-xx') + ';';
        expect(ids(line)).not.toContain('generic-secret-assignment');
    });

    it('detects a JWT', () => {
        expect(ids(`token=${FAKE.jwt}`)).toContain('jwt');
    });
});

describe('scanText — user ids (uuid, low severity)', () => {
    it('flags a UUID', () => {
        const found = scanText(`userId: "${FAKE.uuid}"`);
        const u = found.find((f) => f.detectorId === 'uuid');
        expect(u).toBeDefined();
        expect(u!.severity).toBe('low');
    });
});

describe('scanText — dedup & allowlist', () => {
    it('reports an sk-or key once (specific wins over generic sk-)', () => {
        const found = scanText(`'${FAKE.openrouter}'`);
        expect(found).toHaveLength(1);
        expect(found[0].detectorId).toBe('openrouter-key');
    });

    it('honors an inline secret-scan-allow pragma', () => {
        expect(scanText(`const k = '${FAKE.openrouter}'; // secret-scan-allow`)).toHaveLength(0);
        expect(scanText(`k = '${FAKE.github}' // pragma: allowlist secret`)).toHaveLength(0);
    });

    it('reports correct 1-based line and column', () => {
        const text = `line one\nconst k = '${FAKE.aws}';`;
        const [hit] = scanText(text);
        expect(hit.line).toBe(2);
        expect(hit.column).toBe(text.split('\n')[1].indexOf('AKIA') + 1);
    });
});

describe('detector table integrity', () => {
    it('every detector regex is global (exec loops rely on it)', () => {
        for (const d of DETECTORS) expect(d.pattern.global, d.id).toBe(true);
    });

    it('detector ids are unique', () => {
        const seen = new Set(DETECTORS.map((d) => d.id));
        expect(seen.size).toBe(DETECTORS.length);
    });
});
