import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    beginOpenRouterOAuth,
    buildAuthorizeUrl,
    completeOpenRouterOAuth,
    consumeAuthCode,
    deriveCodeChallenge,
    exchangeCodeForKey,
    generateCodeVerifier,
    peekPendingOAuth,
} from './openrouter-oauth';

// --- pure helpers -------------------------------------------------------

describe('generateCodeVerifier', () => {
    it('produces a 43-char base64url string (32 random bytes) with no padding', () => {
        const v = generateCodeVerifier();
        expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(v).not.toContain('=');
    });

    it('is unique per call', () => {
        expect(generateCodeVerifier()).not.toBe(generateCodeVerifier());
    });
});

describe('deriveCodeChallenge', () => {
    it('matches the canonical RFC 7636 Appendix B test vector', async () => {
        // Published RFC 7636 Appendix B test vectors — public, not secrets.
        // eslint-disable-next-line no-secrets/no-secrets
        const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
        const challenge = await deriveCodeChallenge(verifier);
        // eslint-disable-next-line no-secrets/no-secrets
        expect(challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    });

    it('emits base64url (no +/=) for a verifier whose digest hits those bytes', async () => {
        const challenge = await deriveCodeChallenge(generateCodeVerifier());
        expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    });
});

describe('buildAuthorizeUrl', () => {
    it('targets openrouter.ai/auth with callback_url + S256 challenge', () => {
        const url = new URL(
            buildAuthorizeUrl({
                callbackUrl: 'https://app.example.com/settings',
                codeChallenge: 'CHALLENGE123',
            }),
        );
        expect(url.origin + url.pathname).toBe('https://openrouter.ai/auth');
        expect(url.searchParams.get('callback_url')).toBe('https://app.example.com/settings');
        expect(url.searchParams.get('code_challenge')).toBe('CHALLENGE123');
        expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    });
});

// --- exchange (mocked OpenRouter /api/v1/auth/keys) ---------------------

describe('exchangeCodeForKey', () => {
    afterEach(() => vi.unstubAllGlobals());

    function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
        const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
            Promise.resolve(handler(String(input), init)),
        );
        vi.stubGlobal('fetch', fn);
        return fn;
    }

    it('POSTs code + verifier + method as JSON and returns the key', async () => {
        // Remote mock of the documented response shape: `{ key }`.
        const fetchMock = stubFetch((url) => {
            expect(url).toBe('https://openrouter.ai/api/v1/auth/keys');
            return new Response(JSON.stringify({ key: 'sk-or-v1-abc123' }), { status: 200 });
        });

        const key = await exchangeCodeForKey({ code: 'AUTH_CODE', codeVerifier: 'VERIFIER' });

        expect(key).toBe('sk-or-v1-abc123');
        const init = fetchMock.mock.calls[0]![1]!;
        expect(init.method).toBe('POST');
        expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
        expect(JSON.parse(String(init.body))).toEqual({
            code: 'AUTH_CODE',
            code_verifier: 'VERIFIER',
            code_challenge_method: 'S256',
        });
    });

    it('throws with status + body on a non-2xx response', async () => {
        stubFetch(() => new Response('bad code', { status: 400, statusText: 'Bad Request' }));
        await expect(exchangeCodeForKey({ code: 'x', codeVerifier: 'y' })).rejects.toThrow(
            /400 Bad Request — bad code/,
        );
    });

    it('throws when the response is 2xx but carries no key', async () => {
        stubFetch(() => new Response(JSON.stringify({ data: {} }), { status: 200 }));
        await expect(exchangeCodeForKey({ code: 'x', codeVerifier: 'y' })).rejects.toThrow(
            /returned no key/,
        );
    });
});

// --- browser orchestration (stubbed location / sessionStorage / history) -

function makeSessionStorage(): Storage {
    const map = new Map<string, string>();
    return {
        getItem: (k) => map.get(k) ?? null,
        setItem: (k, v) => void map.set(k, String(v)),
        removeItem: (k) => void map.delete(k),
        clear: () => map.clear(),
        key: (i) => [...map.keys()][i] ?? null,
        get length() {
            return map.size;
        },
    } as Storage;
}

describe('OAuth orchestration', () => {
    let assigned: string | null;
    let replaced: string | null;

    beforeEach(() => {
        assigned = null;
        replaced = null;
        vi.stubGlobal('sessionStorage', makeSessionStorage());
        vi.stubGlobal('location', {
            origin: 'https://app.example.com',
            pathname: '/settings',
            search: '',
            hash: '',
            assign: (url: string) => {
                assigned = url;
            },
        });
        vi.stubGlobal('history', {
            replaceState: (_s: unknown, _t: string, url: string) => {
                replaced = url;
            },
        });
    });

    afterEach(() => vi.unstubAllGlobals());

    it('beginOpenRouterOAuth stashes the verifier and redirects with a matching challenge', async () => {
        await beginOpenRouterOAuth('openrouter');

        const pending = peekPendingOAuth();
        expect(pending?.providerId).toBe('openrouter');
        expect(pending?.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);

        expect(assigned).not.toBeNull();
        const url = new URL(assigned!);
        expect(url.origin + url.pathname).toBe('https://openrouter.ai/auth');
        // Callback is on the current origin — its host is what OpenRouter shows
        // as the app name on the consent page (production → "eatmydata.ai").
        expect(url.searchParams.get('callback_url')).toBe('https://app.example.com/settings');
        expect(url.searchParams.get('code_challenge_method')).toBe('S256');
        // The redirected challenge is the SHA-256 of the stashed verifier.
        expect(url.searchParams.get('code_challenge')).toBe(
            await deriveCodeChallenge(pending!.verifier),
        );
    });

    it('consumeAuthCode returns the code and strips it from the URL', () => {
        (location as { search: string }).search = '?code=THE_CODE&foo=bar';
        expect(consumeAuthCode()).toBe('THE_CODE');
        // `code` removed, other params preserved.
        expect(replaced).toBe('/settings?foo=bar');
    });

    it('consumeAuthCode returns null when there is no code param', () => {
        (location as { search: string }).search = '?foo=bar';
        expect(consumeAuthCode()).toBeNull();
        expect(replaced).toBeNull();
    });

    it('completeOpenRouterOAuth exchanges the stashed verifier and clears it', async () => {
        await beginOpenRouterOAuth('openrouter'); // stashes verifier
        const fetchMock = vi.fn(() =>
            Promise.resolve(new Response(JSON.stringify({ key: 'sk-or-v1-xyz' }), { status: 200 })),
        );
        vi.stubGlobal('fetch', fetchMock);

        const result = await completeOpenRouterOAuth('AUTH_CODE');

        expect(result).toEqual({ providerId: 'openrouter', key: 'sk-or-v1-xyz' });
        // Verifier consumed — a second attempt has nothing to exchange.
        expect(peekPendingOAuth()).toBeNull();
        await expect(completeOpenRouterOAuth('AUTH_CODE')).rejects.toThrow(/No pending/);
    });

    it('completeOpenRouterOAuth throws when no verifier was stashed', async () => {
        await expect(completeOpenRouterOAuth('AUTH_CODE')).rejects.toThrow(/No pending/);
    });
});
