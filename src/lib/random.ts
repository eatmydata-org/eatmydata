/**
 * Cryptographically-strong randomness, used app-wide in place of
 * `Math.random()` (enforced by the `sonarjs/pseudo-random` lint rule).
 *
 * Backed by `crypto.getRandomValues`, which exists in every context this app
 * runs in — the browser main thread, Web/Shared/Dedicated Workers, and
 * Node ≥18 (`globalThis.crypto`). There is deliberately no `Math.random`
 * fallback: if Web Crypto were missing we'd rather fail loudly than silently
 * degrade to a weak PRNG.
 */

/** Uniform float in `[0, 1)` with 32 bits of entropy. */
export function randomFloat(): number {
    const u = new Uint32Array(1);
    crypto.getRandomValues(u);
    return u[0]! / 0x1_0000_0000;
}

/** Uniform unsigned 32-bit integer in `[0, 2³²)`. */
export function randomUint32(): number {
    const u = new Uint32Array(1);
    crypto.getRandomValues(u);
    return u[0]!;
}

/**
 * Uniform integer in `[0, maxExclusive)`. Returns 0 for non-positive bounds.
 * The modulo bias is negligible and these call sites are non-cryptographic
 * (jitter, index selection), so a plain scale-and-floor is fine.
 */
export function randomInt(maxExclusive: number): number {
    if (maxExclusive <= 0) return 0;
    return Math.floor(randomFloat() * maxExclusive);
}

/** Lowercase hex token of `bytes` random bytes (2 hex chars per byte). */
export function randomToken(bytes = 8): string {
    const b = new Uint8Array(bytes);
    crypto.getRandomValues(b);
    let s = '';
    for (const x of b) s += x.toString(16).padStart(2, '0');
    return s;
}
