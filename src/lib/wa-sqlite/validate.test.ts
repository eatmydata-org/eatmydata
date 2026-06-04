import { describe, it, expect } from 'vitest';
import {
    assertSqliteBytes,
    DataSourceUnreadableError,
    isUnreadableDbError,
    looksLikeSqliteHeader,
    SQLITE_HEADER,
} from './validate';

const headerBytes = (extra = 0): Uint8Array => {
    const buf = new Uint8Array(SQLITE_HEADER.length + extra);
    for (let i = 0; i < SQLITE_HEADER.length; i++) buf[i] = SQLITE_HEADER.charCodeAt(i);
    return buf;
};

const ascii = (s: string): Uint8Array => new Uint8Array([...s].map((c) => c.charCodeAt(0)));

describe('looksLikeSqliteHeader', () => {
    it('accepts the SQLite magic header', () => {
        expect(looksLikeSqliteHeader(headerBytes(100))).toBe(true);
    });
    it('rejects HTML (the SPA-fallback failure mode)', () => {
        expect(looksLikeSqliteHeader(ascii('<!DOCTYPE html><html>...'))).toBe(false);
    });
    it('rejects empty / too-short buffers', () => {
        expect(looksLikeSqliteHeader(new Uint8Array(0))).toBe(false);
        expect(looksLikeSqliteHeader(ascii('SQLite'))).toBe(false);
    });
    it('accepts an ArrayBuffer as well as a Uint8Array', () => {
        const u8 = headerBytes(10);
        const ab = new ArrayBuffer(u8.byteLength);
        new Uint8Array(ab).set(u8);
        expect(looksLikeSqliteHeader(ab)).toBe(true);
    });
});

describe('assertSqliteBytes', () => {
    it('passes a real header through', () => {
        expect(() => assertSqliteBytes(headerBytes(50), 'demo')).not.toThrow();
    });
    it('throws DataSourceUnreadableError for an empty download', () => {
        try {
            assertSqliteBytes(new Uint8Array(0), 'Demo "contoso"');
            throw new Error('expected to throw');
        } catch (e) {
            expect(e).toBeInstanceOf(DataSourceUnreadableError);
            expect((e as Error).message).toMatch(/empty/i);
        }
    });
    it('throws DataSourceUnreadableError for an HTML body and previews it', () => {
        try {
            assertSqliteBytes(ascii('<!DOCTYPE html><title>x</title>'), 'Demo "x"');
            throw new Error('expected to throw');
        } catch (e) {
            expect(e).toBeInstanceOf(DataSourceUnreadableError);
            const msg = (e as Error).message;
            expect(msg).toMatch(/not a valid SQLite database/i);
            expect(msg).toContain('<!DOCTYPE html>');
        }
    });
});

describe('isUnreadableDbError', () => {
    it('recognises our own error', () => {
        expect(isUnreadableDbError(new DataSourceUnreadableError('x'))).toBe(true);
    });
    it('recognises an error reconstructed across the Comlink boundary (name only)', () => {
        // Comlink rebuilds thrown errors as a plain Error carrying name+message.
        const wireError = Object.assign(new Error('whatever'), {
            name: 'DataSourceUnreadableError',
        });
        expect(isUnreadableDbError(wireError)).toBe(true);
    });
    it('recognises raw sqlite NOTADB/CORRUPT messages by text', () => {
        expect(isUnreadableDbError(new Error('file is not a database'))).toBe(true);
        expect(isUnreadableDbError(new Error('database disk image is malformed'))).toBe(true);
        expect(isUnreadableDbError(new Error('Invalid SQL: file is not a database'))).toBe(true);
    });
    it('does NOT match ordinary SQL errors or busy errors', () => {
        expect(isUnreadableDbError(new Error('near "SELEC": syntax error'))).toBe(false);
        expect(isUnreadableDbError(new Error('database is locked'))).toBe(false);
        expect(isUnreadableDbError(null)).toBe(false);
        expect(isUnreadableDbError(undefined)).toBe(false);
    });
});
