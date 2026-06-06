/**
 * OpenRouter OAuth PKCE flow — let a user "Connect OpenRouter" from Settings
 * and have the resulting user-controlled API key dropped straight into their
 * `apiKeys` map, with no manual copy/paste of a key.
 *
 * Flow (see https://openrouter.ai/docs/guides/overview/auth/oauth):
 *   1. Generate a high-entropy `code_verifier` and its `code_challenge`
 *      (base64url(SHA-256(verifier))).
 *   2. Stash the verifier (+ the target provider id) in sessionStorage — it
 *      must survive the full-page redirect to openrouter.ai and back, and
 *      sessionStorage is tab-scoped, so a peer tab can't race on it.
 *   3. Navigate to `https://openrouter.ai/auth?callback_url=…&code_challenge=…
 *      &code_challenge_method=S256`.
 *   4. OpenRouter authenticates the user and redirects back to `callback_url`
 *      with `?code=<authCode>`.
 *   5. POST `{ code, code_verifier, code_challenge_method }` to
 *      `…/api/v1/auth/keys`; the JSON response's `key` field is the API key.
 *
 * The module is split into pure helpers (verifier/challenge/url/exchange —
 * unit-tested against a mocked OpenRouter) and the browser-only orchestration
 * (`beginOpenRouterOAuth`, `consumeAuthCode`, `completeOpenRouterOAuth`) that
 * touches `location`/`sessionStorage`.
 */

const AUTH_BASE = 'https://openrouter.ai/auth';
const KEYS_ENDPOINT = 'https://openrouter.ai/api/v1/auth/keys';
/** Always S256 — `plain` is supported by OpenRouter but offers no protection. */
const CODE_CHALLENGE_METHOD = 'S256';
/** sessionStorage slot holding the in-flight PKCE verifier + target provider. */
const PENDING_KEY = 'openrouter-oauth-pending';
/** Query param OpenRouter appends to the callback URL. */
const CODE_PARAM = 'code';

/** The PKCE state stashed across the redirect to openrouter.ai and back. */
export interface PendingOAuth {
    /** The raw PKCE `code_verifier`, exchanged for the key on return. */
    verifier: string;
    /** Provider-instance id whose `apiKeys` entry the returned key fills. */
    providerId: string;
}

// --- pure helpers (unit-tested) -----------------------------------------

/** base64url (RFC 4648 §5) — base64 with +/→-_ and stripped `=` padding. */
function base64Url(bytes: Uint8Array): string {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/** A fresh high-entropy PKCE `code_verifier` (43 chars from 32 random bytes). */
export function generateCodeVerifier(): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return base64Url(bytes);
}

/** `code_challenge` = base64url(SHA-256(verifier)). */
export async function deriveCodeChallenge(verifier: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return base64Url(new Uint8Array(digest));
}

/** Build the `https://openrouter.ai/auth?…` URL the user is redirected to. */
export function buildAuthorizeUrl(opts: { callbackUrl: string; codeChallenge: string }): string {
    const url = new URL(AUTH_BASE);
    url.searchParams.set('callback_url', opts.callbackUrl);
    url.searchParams.set('code_challenge', opts.codeChallenge);
    url.searchParams.set('code_challenge_method', CODE_CHALLENGE_METHOD);
    return url.toString();
}

/**
 * Exchange an authorization `code` (+ the `code_verifier` it was challenged
 * with) for an OpenRouter API key. Throws (never returns empty) on a non-2xx
 * response or a missing `key` field, so callers surface the failure loudly.
 */
export async function exchangeCodeForKey(opts: {
    code: string;
    codeVerifier: string;
    signal?: AbortSignal;
}): Promise<string> {
    const res = await fetch(KEYS_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            code: opts.code,
            code_verifier: opts.codeVerifier,
            code_challenge_method: CODE_CHALLENGE_METHOD,
        }),
        signal: opts.signal,
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(
            `OpenRouter key exchange failed: ${res.status} ${res.statusText}` +
                (body ? ` — ${body.slice(0, 200)}` : ''),
        );
    }
    const json = (await res.json()) as { key?: unknown };
    if (typeof json.key !== 'string' || !json.key) {
        throw new Error('OpenRouter key exchange returned no key.');
    }
    return json.key;
}

// --- browser orchestration (location + sessionStorage) ------------------

/**
 * Callback URL OpenRouter redirects back to — this Settings page, on whatever
 * origin the app is currently served from.
 *
 * OpenRouter has no app-name parameter: it derives the consent-page app name
 * (and the default label on the issued key) from the requesting app's URL. So
 * served from production this reads "eatmydata.ai"; on a localhost dev server
 * it's the unbranded local case OpenRouter documents (it recommends
 * `http://localhost:3000` as the callback for local-first apps). Using
 * `location.origin` keeps the redirect landing back on the same tab in every
 * environment instead of bouncing dev/staging to production.
 */
function callbackUrl(): string {
    return `${location.origin}/settings`;
}

function savePending(p: PendingOAuth): void {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(p));
}

/** Read the stashed PKCE state without clearing it (status display). */
export function peekPendingOAuth(): PendingOAuth | null {
    const raw = sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    try {
        const p = JSON.parse(raw) as PendingOAuth;
        return typeof p?.verifier === 'string' && typeof p?.providerId === 'string' ? p : null;
    } catch (e) {
        console.error('[openrouter-oauth] corrupt pending state in sessionStorage', e);
        return null;
    }
}

function clearPending(): void {
    sessionStorage.removeItem(PENDING_KEY);
}

/**
 * Kick off the flow: derive a fresh verifier/challenge, stash the verifier for
 * `providerId`, and navigate the tab to OpenRouter's auth page. Does not
 * return in practice — the page is replaced by the redirect.
 */
export async function beginOpenRouterOAuth(providerId: string): Promise<void> {
    const verifier = generateCodeVerifier();
    const challenge = await deriveCodeChallenge(verifier);
    savePending({ verifier, providerId });
    location.assign(buildAuthorizeUrl({ callbackUrl: callbackUrl(), codeChallenge: challenge }));
}

/**
 * If the current URL carries an OAuth `?code=…`, return it and strip it from
 * the address bar (via `history.replaceState`) so a reload can't re-trigger
 * the one-time exchange. Returns null when there is no pending callback.
 */
export function consumeAuthCode(): string | null {
    const params = new URLSearchParams(location.search);
    const code = params.get(CODE_PARAM);
    if (!code) return null;
    params.delete(CODE_PARAM);
    const qs = params.toString();
    const query = qs ? `?${qs}` : '';
    history.replaceState(null, '', `${location.pathname}${query}${location.hash}`);
    return code;
}

/**
 * Complete the flow on return: read the stashed verifier (clearing it so it
 * can't be reused), exchange `code` for the key, and return it together with
 * the provider id it should fill. Throws if no verifier is stashed (the
 * callback arrived without a matching `beginOpenRouterOAuth`).
 */
export async function completeOpenRouterOAuth(
    code: string,
): Promise<{ providerId: string; key: string }> {
    const pending = peekPendingOAuth();
    if (!pending) {
        throw new Error('No pending OpenRouter connection — start again from Settings.');
    }
    clearPending();
    const key = await exchangeCodeForKey({ code, codeVerifier: pending.verifier });
    return { providerId: pending.providerId, key };
}
