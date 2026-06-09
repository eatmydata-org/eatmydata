/**
 * Node/vitest coverage for the bert-ner wasm loader (src/lib/bert-ner/runtime.ts).
 *
 * Exercises the JS↔wasm bridge end to end — instantiate semantic.wasm, load the
 * token-classification GGUF, sem_init, classify text — and checks the per-token
 * output is well-formed (in-range labels, monotone byte offsets) and deterministic,
 * and that the BIO decode surfaces an obvious entity. The semantic engine's
 * embedding side is gated against llama.cpp natively (`make semantic-verify`); this
 * is the JS marshaling + NER-head check.
 *
 * Soft-skips when the assets are absent (gitignored — run `make semantic` and
 * `make ner-model` first).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    setBertNerLoaders,
    warmupBertNer,
    isBertNerReady,
    nerNumLabels,
    inferTokensSync,
} from './runtime';
import { aggregateBio, tokensToPlaced } from './decode';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../../..');
const WASM = resolve(ROOT, 'src/assets/wasm/semantic.wasm');
const GGUF_Q8 = resolve(ROOT, 'src/assets/models/bert-small-pii-detection-q8_0.gguf');
const GGUF_F32 = resolve(ROOT, 'src/assets/models/bert-small-pii-detection-f32.gguf');
const GGUF = existsSync(GGUF_Q8) ? GGUF_Q8 : GGUF_F32;

const ASSETS_PRESENT = existsSync(WASM) && existsSync(GGUF);
const d = describe.skipIf(!ASSETS_PRESENT);

d('bert-ner wasm loader', () => {
    beforeAll(async () => {
        setBertNerLoaders({
            wasm: async () => await readFile(WASM),
            gguf: async () => new Uint8Array(await readFile(GGUF)),
        });
        await warmupBertNer();
    });

    it('warms up and reports the 51-label token-classification model', () => {
        expect(isBertNerReady()).toBe(true);
        expect(nerNumLabels()).toBe(51);
    });

    it('returns well-formed per-token output', () => {
        const text = 'Email me at john@acme.io please.'; // secret-scan-allow -- test fixture
        const nbytes = Buffer.byteLength(text, 'utf8');
        const toks = inferTokensSync(text);
        expect(toks.length).toBeGreaterThan(0);
        for (const t of toks) {
            expect(t.label).toBeGreaterThanOrEqual(0);
            expect(t.label).toBeLessThan(51);
            expect(t.start).toBeGreaterThanOrEqual(0);
            expect(t.end).toBeGreaterThan(t.start);
            expect(t.end).toBeLessThanOrEqual(nbytes);
            expect(t.score).toBeGreaterThan(0);
            expect(t.score).toBeLessThanOrEqual(1);
        }
        // offsets should be non-overlapping and in order
        for (let i = 1; i < toks.length; i++)
            expect(toks[i]!.start).toBeGreaterThanOrEqual(toks[i - 1]!.end);
    });

    it('detects an email via the BIO decode', () => {
        const text = 'Email me at john@acme.io please.'; // secret-scan-allow -- test fixture
        const spans = aggregateBio(tokensToPlaced(inferTokensSync(text), text), text);
        expect(spans.some((s) => s.entity_type.includes('EMAIL'))).toBe(true);
    });

    it('is deterministic across calls', () => {
        const a = inferTokensSync('John Doe lives in Paris and works at Initech.');
        const b = inferTokensSync('John Doe lives in Paris and works at Initech.');
        expect(b).toEqual(a);
    });
});
