/**
 * Node/vitest coverage for the bge-embed wasm loader (src/lib/bge-embed/runtime.ts).
 *
 * Exercises the JS↔wasm bridge end to end — instantiate bge-embed.wasm, load the
 * GGUF, bge_init, and embed text — and checks the OUTPUT is a valid, semantically
 * meaningful, deterministic embedding. The strict 1:1-vs-llama.cpp gate lives in
 * the native harness (`make embed-verify`); since the wasm is the SAME C compiled
 * for wasm32, this test's job is the JS marshaling + that the module runs.
 *
 * Soft-skips when the GGUF asset is absent (it is gitignored — run
 * `make embed-model` and `make semantic` first).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setBgeLoaders, warmupBgeEmbed, isBgeEmbedReady, bgeDim, embedTextsSync } from './runtime';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../../..');
const WASM = resolve(ROOT, 'src/assets/wasm/semantic.wasm');
// Prefer the shipped Q8_0 weights; fall back to F16 if that's what's on disk.
const GGUF_Q8 = resolve(ROOT, 'src/assets/models/bge-small-en-v1.5-q8_0.gguf');
const GGUF_F16 = resolve(ROOT, 'src/assets/models/bge-small-en-v1.5-f16.gguf');
const GGUF = existsSync(GGUF_Q8) ? GGUF_Q8 : GGUF_F16;

const ASSETS_PRESENT = existsSync(WASM) && existsSync(GGUF);
const d = describe.skipIf(!ASSETS_PRESENT);

// Two near-synonym pairs; the pairs are unrelated to each other.
const SAMPLES = [
    'The cat sat quietly on the warm windowsill.', // 0 ~ 1
    'A feline rested calmly by the sunny window.', // 1 ~ 0
    'Quarterly revenue grew 12% year over year.', // 2 ~ 3
    'Our Q3 sales rose compared with the prior year.', // 3 ~ 2
];

function dot(a: number[], b: number[]): number {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
    return s;
}

d('bge-embed wasm loader', () => {
    let vecs: number[][] = [];

    beforeAll(async () => {
        // Node fetch can't resolve the browser asset URLs; inject fs loaders.
        setBgeLoaders({
            wasm: async () => await readFile(WASM),
            gguf: async () => new Uint8Array(await readFile(GGUF)),
        });
        await warmupBgeEmbed();
        vecs = embedTextsSync(SAMPLES);
    });

    it('warms up and reports the 384-dim model', () => {
        expect(isBgeEmbedReady()).toBe(true);
        expect(bgeDim()).toBe(384);
    });

    it('embeds every sample into an L2-normalized vector', () => {
        expect(vecs.length).toBe(SAMPLES.length);
        for (const v of vecs) {
            expect(v.length).toBe(384);
            expect(Math.abs(dot(v, v) - 1)).toBeLessThan(1e-3); // ‖v‖² ≈ 1
        }
    });

    it('captures semantic structure (synonyms beat unrelated pairs)', () => {
        const within = (dot(vecs[0]!, vecs[1]!) + dot(vecs[2]!, vecs[3]!)) / 2;
        const cross = (dot(vecs[0]!, vecs[2]!) + dot(vecs[1]!, vecs[3]!)) / 2;
        expect(within).toBeGreaterThan(cross + 0.05);
    });

    it('is deterministic across calls', () => {
        const again = embedTextsSync(SAMPLES[0]!);
        expect(again[0]).toEqual(vecs[0]);
    });
});
