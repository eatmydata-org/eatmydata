/**
 * Coverage for `legalizeI64` — the i64 dispatch-arg splitter that feeds the
 * committed wa-sqlite VFS surface (FacadeVFS.xRead/xWrite/xTruncate expect a
 * legalized (lo32, hi32) pair).
 *
 * Regression: opening an OPFS-backed database (every demo/file import) calls the
 * `libvfs_xRead` JS trampoline with the file offset at a `'j'` position. Our
 * current `wa-sqlite.wasm` (wasi-sdk-33/clang-22) lowers that i64 import param to
 * a single i32, so V8 hands JS a plain **Number**, not a BigInt — and the old
 * `big & 0xffffffffn` threw `TypeError: Cannot mix BigInt and other types, use
 * explicit conversions`, aborting the open. This can't be reproduced through the
 * Node in-memory VFS (it never calls these JS trampolines), so it's unit-tested
 * here directly against the helper, including a round-trip through `delegalize`.
 */
import { describe, expect, it } from 'vitest';
import { legalizeI64 } from './runtime';

// Mirror of FacadeVFS.js `delegalize` — reconstructs the offset from the
// signed-i32 (lo, hi) pair `legalizeI64` produces.
function delegalize(lo32: number, hi32: number): number {
    return hi32 * 0x100000000 + lo32 + (lo32 < 0 ? 2 ** 32 : 0);
}

describe('legalizeI64', () => {
    it('does NOT throw "Cannot mix BigInt" for a plain Number arg (the regression)', () => {
        // This is exactly what `libvfs_xRead` passes for an offset-0 header read.
        expect(() => legalizeI64(0)).not.toThrow();
        expect(legalizeI64(0)).toEqual([0, 0]);
    });

    it('round-trips small positive Number offsets through delegalize', () => {
        for (const offset of [0, 1, 4096, 1_000_000, 0x7fffffff]) {
            const [lo, hi] = legalizeI64(offset);
            expect(delegalize(lo, hi)).toBe(offset);
        }
    });

    it('round-trips 2–4 GB offsets that arrive as a negative i32 Number', () => {
        // V8 hands a wasm i32 with the high bit set to JS as a negative Number;
        // `>>> 0` restores the unsigned offset, hi stays 0.
        const offset2gb = 0x80000000; // 2 GiB
        const asSignedI32 = offset2gb | 0; // -2147483648, what V8 actually passes
        const [lo, hi] = legalizeI64(asSignedI32);
        expect(hi).toBe(0);
        expect(delegalize(lo, hi)).toBe(offset2gb);

        const offsetNear4gb = 0xfffff000;
        expect(delegalize(...legalizeI64(offsetNear4gb | 0))).toBe(offsetNear4gb);
    });

    it('still handles a native-i64 BigInt arg (the other ABI), incl. > 4 GB', () => {
        expect(legalizeI64(0n)).toEqual([0, 0]);
        expect(delegalize(...legalizeI64(4096n))).toBe(4096);
        // 5 GiB = 0x1_4000_0000 — only expressible via the BigInt path (a single
        // i32 can't carry it). High word is 1, low word 0x40000000.
        const fiveGb = 5n * 1024n * 1024n * 1024n;
        const [lo, hi] = legalizeI64(fiveGb);
        expect(hi).toBe(1);
        expect(lo).toBe(0x40000000);
        expect(delegalize(lo, hi)).toBe(Number(fiveGb));
    });

    it('Number and BigInt forms of the same value legalize identically', () => {
        for (const n of [0, 4096, 1_000_000, 0x7fffffff]) {
            expect(legalizeI64(n)).toEqual(legalizeI64(BigInt(n)));
        }
    });
});
