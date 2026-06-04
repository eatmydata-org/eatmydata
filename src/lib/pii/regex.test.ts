import { describe, it, expect } from 'vitest';
import { analyzeRegex } from './regex';

describe('analyzeRegex — detection', () => {
    it('finds an email and an IP address', () => {
        const { entities } = analyzeRegex('reach me at jane.doe@acme.io or 10.0.0.1');
        const types = entities.map((e) => e.entity_type);
        expect(types).toContain('email');
        expect(types).toContain('ip_address');
    });

    it('returns the matched substring for each entity', () => {
        const { entities } = analyzeRegex('ip 192.168.1.1 here');
        const ip = entities.find((e) => e.entity_type === 'ip_address');
        expect(ip?.text).toBe('192.168.1.1');
    });

    it('reports no truncation for normal input', () => {
        const { stats } = analyzeRegex('nothing sensitive here');
        expect(stats.truncated).toBeUndefined();
    });
});

describe('analyzeRegex — scan cap (ReDoS guard)', () => {
    // MAX_SCAN_CHARS is 200k; build inputs straddling it without importing it.
    const OVER = 200_001;

    it('flags truncation and only scans the prefix on oversized input', () => {
        // PII placed AFTER the cap must not be found, and truncated must be set.
        const text = 'x'.repeat(OVER) + ' secret@hidden.io';
        const { entities, stats } = analyzeRegex(text);
        expect(stats.truncated).toBe(true);
        expect(entities.find((e) => e.entity_type === 'email')).toBeUndefined();
    });

    it('still detects PII that falls within the scanned prefix', () => {
        const text = 'early@found.io ' + 'x'.repeat(OVER);
        const { entities, stats } = analyzeRegex(text);
        expect(stats.truncated).toBe(true);
        expect(entities.find((e) => e.entity_type === 'email')?.text).toBe('early@found.io');
    });
});
