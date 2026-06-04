// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { sanitizeHtml } from './sanitize-html';

describe('sanitizeHtml', () => {
    it('keeps safe presentational markup', () => {
        const out = sanitizeHtml('<p>Hello <strong>world</strong> <em>!</em></p>');
        expect(out).toBe('<p>Hello <strong>world</strong> <em>!</em></p>');
    });

    it('strips <script> tags', () => {
        const out = sanitizeHtml('<p>ok</p><script>alert(1)</script>');
        expect(out).toContain('<p>ok</p>');
        expect(out.toLowerCase()).not.toContain('<script');
        expect(out).not.toContain('alert(1)');
    });

    it('strips inline event handlers', () => {
        const out = sanitizeHtml('<img src="x" onerror="alert(1)">');
        expect(out.toLowerCase()).not.toContain('onerror');
        expect(out).not.toContain('alert(1)');
    });

    it('strips javascript: URLs', () => {
        const out = sanitizeHtml('<a href="javascript:alert(1)">click</a>');
        expect(out.toLowerCase()).not.toContain('javascript:');
    });

    it('drops <svg> active-content vectors (HTML profile only)', () => {
        const out = sanitizeHtml('<svg><script>alert(1)</script></svg>');
        expect(out.toLowerCase()).not.toContain('<svg');
        expect(out.toLowerCase()).not.toContain('<script');
    });

    it('drops target (links open in-place; no reverse-tabnabbing vector)', () => {
        const out = sanitizeHtml('<a href="https://example.com" target="_blank">x</a>');
        expect(out.toLowerCase()).not.toContain('target');
    });

    it('preserves a safe external link', () => {
        const out = sanitizeHtml('<a href="https://example.com/page">link</a>');
        expect(out).toContain('href="https://example.com/page"');
    });

    it('returns empty string for empty input', () => {
        expect(sanitizeHtml('')).toBe('');
    });
});
