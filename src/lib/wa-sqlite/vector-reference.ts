/**
 * Independent reference implementations for the rh vector extension, used as
 * the oracle in vector.test.ts. These are intentionally written from scratch
 * (not derived from the C) so a test failure means the C and the spec actually
 * disagree — not that both share a bug.
 *
 * Covers the BLOB codec (decode of every element type) and the exact distance
 * metrics. Endianness matches the C side: little-endian, which is what typed
 * arrays use on every platform we run on.
 */

/** Normalize whatever wa-sqlite hands back for a BLOB cell into a Uint8Array. */
export function asBytes(v: unknown): Uint8Array {
    if (v instanceof Uint8Array) return v;
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    if (Array.isArray(v)) return Uint8Array.from(v as number[]);
    throw new Error(`not a blob: ${Object.prototype.toString.call(v)}`);
}

/** IEEE-754 half (uint16) -> number, via DataView round-trip math. */
export function f16ToF32(h: number): number {
    const sign = h & 0x8000 ? -1 : 1;
    const exp = (h >> 10) & 0x1f;
    const mant = h & 0x3ff;
    if (exp === 0) return sign * Math.pow(2, -14) * (mant / 1024);
    if (exp === 0x1f) return mant ? NaN : sign * Infinity;
    return sign * Math.pow(2, exp - 15) * (1 + mant / 1024);
}

/** bfloat16 (uint16) -> number: place in the high 16 bits of a float32. */
export function bf16ToF32(b: number): number {
    const buf = new ArrayBuffer(4);
    new Uint32Array(buf)[0] = b << 16;
    return new Float32Array(buf)[0];
}

export type RefType = 'f32' | 'f16' | 'bf16' | 'i8' | 'u8' | 'bit';

/** Decode a packed vector BLOB of the given element type into numbers. */
export function decode(type: RefType, bytes: Uint8Array, dim: number): number[] {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const out: number[] = [];
    switch (type) {
        case 'f32':
            for (let i = 0; i < dim; i++) out.push(dv.getFloat32(i * 4, true));
            return out;
        case 'f16':
            for (let i = 0; i < dim; i++) out.push(f16ToF32(dv.getUint16(i * 2, true)));
            return out;
        case 'bf16':
            for (let i = 0; i < dim; i++) out.push(bf16ToF32(dv.getUint16(i * 2, true)));
            return out;
        case 'i8':
            for (let i = 0; i < dim; i++) out.push(dv.getInt8(i));
            return out;
        case 'u8':
            for (let i = 0; i < dim; i++) out.push(dv.getUint8(i));
            return out;
        case 'bit':
            for (let i = 0; i < dim; i++) {
                out.push((bytes[i >> 3] >> (i & 7)) & 1);
            }
            return out;
    }
}

/* ---- exact distance metrics (oracle for Phase 3) ---- */

export function dot(a: number[], b: number[]): number {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
}

export function squaredL2(a: number[], b: number[]): number {
    let s = 0;
    for (let i = 0; i < a.length; i++) {
        const d = a[i] - b[i];
        s += d * d;
    }
    return s;
}

export function l2(a: number[], b: number[]): number {
    return Math.sqrt(squaredL2(a, b));
}

export function l1(a: number[], b: number[]): number {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
    return s;
}

/** Cosine *distance* = 1 - cosine similarity. */
export function cosineDistance(a: number[], b: number[]): number {
    const na = Math.sqrt(dot(a, a));
    const nb = Math.sqrt(dot(b, b));
    if (na === 0 || nb === 0) return 1;
    return 1 - dot(a, b) / (na * nb);
}

/** Hamming distance over bit vectors (number[] of 0/1). */
export function hamming(a: number[], b: number[]): number {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] === b[i] ? 0 : 1;
    return s;
}
