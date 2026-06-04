#!/usr/bin/env -S node --experimental-strip-types --no-warnings
/**
 * Extract Gemini per-token pricing from the Google AI pricing page using
 * the `claude` CLI (Sonnet) as a prompt-based extractor.
 *
 * Google AI Studio has no pricing API, so the in-app "Download prices"
 * button for a Google provider applies a committed static map. This script
 * regenerates that map: you download the pricing page yourself and feed the
 * HTML in — the script never fetches the network for the page.
 *
 *   # 1. Save the page (browser "Save As", or curl):
 *   curl -sL https://ai.google.dev/gemini-api/docs/pricing -o /tmp/gemini.html
 *   # 2. Extract → src/lib/agent/providers/gemini-prices.json
 *   node --experimental-strip-types scripts/extract-gemini-prices.ts \
 *        --html /tmp/gemini.html
 *
 * Options:
 *   --html <path>     (required) the pre-downloaded pricing-page HTML
 *   --models a,b,c    model ids to extract (default: keys already in the
 *                     committed JSON, so it refreshes the current set)
 *   --out <path>      output JSON (default the committed map)
 *   --model <id>      claude model (default claude-sonnet-4-6)
 *
 * Requires the `claude` CLI on PATH (dev-machine only — not used at runtime).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = resolve(HERE, '../src/lib/agent/providers/gemini-prices.json');
const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-6';

interface Args {
    html: string;
    models?: string[];
    out: string;
    claudeModel: string;
}

function parseArgs(): Args {
    const argv = process.argv.slice(2);
    let html: string | undefined;
    let models: string[] | undefined;
    let out = DEFAULT_OUT;
    let claudeModel = DEFAULT_CLAUDE_MODEL;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--html') html = argv[++i];
        else if (a === '--models')
            models = argv[++i]
                ?.split(',')
                .map((s) => s.trim())
                .filter(Boolean);
        else if (a === '--out') out = resolve(argv[++i]!);
        else if (a === '--model') claudeModel = argv[++i]!;
        else throw new Error(`Unknown argument: ${a}`);
    }
    if (!html) throw new Error('Missing required --html <path-to-downloaded-pricing-page.html>');
    return { html: resolve(html), models, out, claudeModel };
}

/** Per-token pricing, mirroring `ModelPricing` in settings-types.ts. */
interface Pricing {
    prompt: number;
    completion: number;
    cacheRead?: number;
    reasoning?: number;
}

function defaultModelIds(outPath: string): string[] {
    try {
        const existing = JSON.parse(readFileSync(outPath, 'utf-8')) as Record<string, unknown>;
        return Object.keys(existing);
    } catch {
        return [
            'gemini-2.5-pro',
            'gemini-2.5-flash',
            'gemini-2.5-flash-lite',
            'gemini-2.0-flash',
            'gemini-2.0-flash-lite',
        ];
    }
}

function buildPrompt(html: string, modelIds: string[]): string {
    return [
        'You are a precise data extractor. Below is the raw HTML of the Google',
        'Gemini API pricing page. Extract pricing for EXACTLY these model ids:',
        '',
        modelIds.map((m) => `  - ${m}`).join('\n'),
        '',
        'Rules:',
        '- Prices on the page are quoted per 1,000,000 (1M) tokens in USD.',
        '  Convert each to USD PER SINGLE TOKEN by dividing by 1,000,000.',
        '- "prompt" = input/prompt price per token. "completion" = output price per token.',
        '- If the page lists a cached-input price, include it as "cacheRead" (per token).',
        '- If a model bills reasoning/thinking output separately, include "reasoning" (per token);',
        '  otherwise omit it.',
        '- If a model has tiered prices (e.g. by prompt length), use the standard/base tier.',
        '- If a model id is not on the page, OMIT it from the output (do not guess).',
        '',
        'Output ONLY a single raw JSON object (no prose, no markdown fences) of the shape:',
        '{ "<modelId>": { "prompt": <number>, "completion": <number>, "cacheRead"?: <number>, "reasoning"?: <number> }, ... }',
        '',
        '--- BEGIN PRICING PAGE HTML ---',
        html,
        '--- END PRICING PAGE HTML ---',
    ].join('\n');
}

/** Strip ```json fences and grab the outermost {...} object from a string. */
function extractJsonObject(text: string): string {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const body = fenced ? fenced[1]! : text;
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start === -1 || end === -1 || end < start) {
        throw new Error('No JSON object found in the extractor output');
    }
    return body.slice(start, end + 1);
}

function runClaude(prompt: string, claudeModel: string): string {
    const res = spawnSync('claude', ['-p', '--model', claudeModel, '--output-format', 'json'], {
        input: prompt,
        encoding: 'utf-8',
        maxBuffer: 64 * 1024 * 1024,
    });
    if (res.error) {
        throw new Error(`Failed to run \`claude\` CLI (is it on PATH?): ${res.error.message}`);
    }
    if (res.status !== 0) {
        throw new Error(`\`claude\` exited with code ${res.status}: ${res.stderr || res.stdout}`);
    }
    // --output-format json wraps the model's reply in { type, result, ... }.
    const wrapper = JSON.parse(res.stdout) as { result?: unknown };
    const result = typeof wrapper.result === 'string' ? wrapper.result : res.stdout;
    return result;
}

function validate(map: Record<string, unknown>): Record<string, Pricing> {
    const out: Record<string, Pricing> = {};
    for (const [id, raw] of Object.entries(map)) {
        const p = raw as Record<string, unknown>;
        if (!p || typeof p !== 'object') throw new Error(`Entry "${id}" is not an object`);
        if (typeof p.prompt !== 'number' || typeof p.completion !== 'number') {
            throw new Error(`Entry "${id}" needs numeric prompt + completion`);
        }
        const pricing: Pricing = { prompt: p.prompt, completion: p.completion };
        if (typeof p.cacheRead === 'number') pricing.cacheRead = p.cacheRead;
        if (typeof p.reasoning === 'number') pricing.reasoning = p.reasoning;
        out[id] = pricing;
    }
    return out;
}

function main(): void {
    const args = parseArgs();
    const html = readFileSync(args.html, 'utf-8');
    const modelIds = args.models ?? defaultModelIds(args.out);
    console.log(`[gemini-prices] extracting ${modelIds.length} models via ${args.claudeModel}…`);

    const reply = runClaude(buildPrompt(html, modelIds), args.claudeModel);
    const parsed = JSON.parse(extractJsonObject(reply)) as Record<string, unknown>;
    const pricing = validate(parsed);

    if (Object.keys(pricing).length === 0) {
        throw new Error('Extractor returned an empty map — check the HTML / model ids');
    }
    writeFileSync(args.out, JSON.stringify(pricing, null, 2) + '\n');
    console.log(`[gemini-prices] wrote ${Object.keys(pricing).length} models → ${args.out}`);
}

main();
