#!/usr/bin/env -S node --experimental-strip-types --no-warnings
/**
 * Static secret scanner — blocks commits that introduce API keys, auth
 * tokens, private keys, emails, or likely user ids into the source tree.
 *
 * Wired into the pre-commit hook (`.husky/pre-commit`): by default it
 * scans the *staged* content (the exact bytes git is about to commit,
 * read from the index — not the working tree), and exits non-zero if it
 * finds anything at or above the minimum severity, which aborts the
 * commit. It can also sweep the whole repo on demand:
 *
 *   pnpm scan:secrets                 # scan staged content (pre-commit)
 *   pnpm scan:secrets --all           # scan every tracked file
 *   pnpm scan:secrets --working a b   # scan given working-tree paths
 *   pnpm scan:secrets --all --min-severity low   # include UUIDs etc.
 *
 * Options:
 *   --staged                 (default) scan git index blobs
 *   --all                    scan all tracked files (working tree)
 *   --working [paths...]      scan given paths (or whole working tree)
 *   --min-severity low|medium|high   gate (default: medium)
 *   --include-examples       don't skip example.com / .invalid emails
 *   --no-color               plain output
 *   --quiet                  print only on findings
 *
 * False positives: put a `secret-scan-allow` (or `pragma: allowlist
 * secret`) comment on the offending line, or add a path substring to a
 * `.secretsignore` file at the repo root.
 *
 * The detection logic is exported and unit-tested in
 * `scripts/scan-secrets.test.ts`.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export type Severity = 'low' | 'medium' | 'high';

const SEVERITY_RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2 };

export interface Detector {
    id: string;
    label: string;
    severity: Severity;
    /** Per-line matcher. MUST carry the global flag (we exec it in a loop). */
    pattern: RegExp;
    /** Secondary check on the raw match; reject (false) to drop it. */
    validate?: (match: string) => boolean;
    /** How to render the match without leaking the full secret. */
    redact: (match: string) => string;
}

export interface Finding {
    detectorId: string;
    label: string;
    severity: Severity;
    file: string;
    line: number;
    column: number;
    preview: string;
}

// ── redaction helpers ──────────────────────────────────────────────────

/** Keep a short readable prefix, hide the rest, and note the length. */
function redactToken(keep: number) {
    return (s: string): string => {
        if (s.length <= keep) return `${'•'.repeat(s.length)} [${s.length} chars]`;
        return `${s.slice(0, keep)}…[redacted, ${s.length} chars]`;
    };
}

/** `maria.hernandez@example.org` → `ma…ez@example.org` (domain kept; it's the tell). */
function redactEmail(s: string): string {
    const at = s.indexOf('@');
    if (at <= 0) return s;
    const local = s.slice(0, at);
    const domain = s.slice(at);
    const head = local.slice(0, Math.min(2, local.length));
    const tail = local.length > 3 ? local.slice(-2) : '';
    return `${head}…${tail}${domain}`;
}

// ── entropy gate for the generic "assignment" detector ──────────────────

function shannonEntropy(s: string): number {
    if (!s) return 0;
    const counts = new Map<string, number>();
    for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    let h = 0;
    for (const c of counts.values()) {
        const p = c / s.length;
        h -= p * Math.log2(p);
    }
    return h;
}

const PLACEHOLDER_VALUE =
    /^(?:process\.env|import\.meta|your[-_ ]?|changeme|placeholder|example|xxx+|\.\.\.|<.*>|\$\{)/i;

// ── detectors (specific first; generic last — order drives dedup) ────────

export const DETECTORS: Detector[] = [
    {
        id: 'openrouter-key',
        label: 'OpenRouter API key',
        severity: 'high',
        pattern: /\bsk-or-v1-[0-9a-f]{32,}\b/g,
        redact: redactToken(12),
    },
    {
        id: 'anthropic-key',
        label: 'Anthropic API key',
        severity: 'high',
        pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
        redact: redactToken(10),
    },
    {
        id: 'openai-key',
        label: 'OpenAI / generic `sk-` API key',
        severity: 'high',
        pattern: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g,
        redact: redactToken(7),
    },
    {
        id: 'google-api-key',
        label: 'Google API key (AIza…)',
        severity: 'high',
        pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
        redact: redactToken(8),
    },
    {
        id: 'google-gemini-key',
        label: 'Google AI Studio / Gemini key (AQ.…)',
        severity: 'high',
        pattern: /\bAQ\.[A-Za-z0-9_-]{20,}\b/g,
        redact: redactToken(6),
    },
    {
        id: 'aws-access-key',
        label: 'AWS access key id',
        severity: 'high',
        pattern: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[0-9A-Z]{16}\b/g,
        redact: redactToken(8),
    },
    {
        id: 'github-token',
        label: 'GitHub token',
        severity: 'high',
        pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_\w{22,})\b/g,
        redact: redactToken(7),
    },
    {
        id: 'slack-token',
        label: 'Slack token',
        severity: 'high',
        pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
        redact: redactToken(9),
    },
    {
        id: 'stripe-key',
        label: 'Stripe live secret key',
        severity: 'high',
        pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/g,
        redact: redactToken(8),
    },
    {
        id: 'private-key-block',
        label: 'Private key block',
        severity: 'high',
        pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/g,
        redact: () => '-----BEGIN … PRIVATE KEY----- [redacted]',
    },
    {
        id: 'jwt',
        label: 'JSON Web Token',
        severity: 'medium',
        pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
        redact: redactToken(12),
    },
    {
        id: 'generic-secret-assignment',
        label: 'High-entropy value assigned to a secret-looking name',
        severity: 'medium',
        // key/secret/token/password = "….{16,}…"
        pattern:
            /(?:api[_-]?key|secret|token|password|passwd|pwd|access[_-]?key|auth[_-]?token|client[_-]?secret)["'`]?\s*[:=]\s*["'`]([^"'`\s]{16,})["'`]/gi,
        validate: (m) => {
            const val = m.replace(/^.*?["'`]([^"'`]*)["'`]$/s, '$1');
            if (PLACEHOLDER_VALUE.test(val)) return false;
            return shannonEntropy(val) >= 3.5;
        },
        redact: redactToken(12),
    },
    {
        id: 'email',
        label: 'Email address',
        severity: 'medium',
        pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
        redact: redactEmail,
    },
    {
        id: 'uuid',
        label: 'UUID (possible user id)',
        severity: 'low',
        pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
        redact: (s) => `${s.slice(0, 8)}-…-${s.slice(-4)}`,
    },
];

// ── allowlists ──────────────────────────────────────────────────────────

const ALLOW_PRAGMA = /secret-scan-allow|pragma:\s*allowlist\s+secret/i;

const EXAMPLE_DOMAINS = /@(?:[a-z0-9.-]*\.)?(?:example\.(?:com|org|net)|test|invalid|localhost)$/i;

// ── core scan ─────────────────────────────────────────────────────────────

export interface ScanOptions {
    detectors?: Detector[];
    /** Suppress emails on reserved example/test domains (default true). */
    skipExampleEmails?: boolean;
}

interface RawHit {
    detectorIndex: number;
    start: number;
    end: number;
    finding: Omit<Finding, 'file'>;
}

/** Run one detector across a line, pushing every accepted match to `hits`. */
function collectDetectorHits(
    det: Detector,
    detectorIndex: number,
    line: string,
    lineNo: number,
    skipExampleEmails: boolean,
    hits: RawHit[],
): void {
    det.pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = det.pattern.exec(line)) !== null) {
        const raw = m[0];
        // Guard against zero-width matches looping forever.
        if (m.index === det.pattern.lastIndex) det.pattern.lastIndex++;
        if (det.validate && !det.validate(raw)) continue;
        if (det.id === 'email' && skipExampleEmails && EXAMPLE_DOMAINS.test(raw)) continue;
        hits.push({
            detectorIndex,
            start: m.index,
            end: m.index + raw.length,
            finding: {
                detectorId: det.id,
                label: det.label,
                severity: det.severity,
                line: lineNo,
                column: m.index + 1,
                preview: det.redact(raw),
            },
        });
    }
}

/**
 * Dedup overlapping spans on the same line: a single secret can match both a
 * specific and a generic detector (e.g. `sk-or-v1-…` matches both
 * openrouter-key and the generic `sk-` rule). Keep the most specific (lowest
 * detector index). Mutates `hits` (sorts it) and appends survivors to `out`.
 */
function dedupHits(hits: RawHit[], out: Omit<Finding, 'file'>[]): void {
    hits.sort((a, b) => a.start - b.start || a.detectorIndex - b.detectorIndex);
    let lastEnd = -1;
    for (const h of hits) {
        if (h.start < lastEnd) continue; // overlaps a kept hit → drop
        out.push(h.finding);
        lastEnd = h.end;
    }
}

/**
 * Scan a blob of text. Returns findings (file left blank — the caller
 * stamps the path). Pure: no IO, no globals — this is the unit-tested core.
 */
export function scanText(text: string, opts: ScanOptions = {}): Omit<Finding, 'file'>[] {
    const detectors = opts.detectors ?? DETECTORS;
    const skipExampleEmails = opts.skipExampleEmails ?? true;
    const out: Omit<Finding, 'file'>[] = [];
    const lines = text.split('\n');

    for (let li = 0; li < lines.length; li++) {
        const line = lines[li]!;
        if (ALLOW_PRAGMA.test(line)) continue;

        const hits: RawHit[] = [];
        for (let di = 0; di < detectors.length; di++) {
            collectDetectorHits(detectors[di]!, di, line, li + 1, skipExampleEmails, hits);
        }
        dedupHits(hits, out);
    }
    return out;
}

// ── CLI ─────────────────────────────────────────────────────────────────

interface CliOptions {
    mode: 'staged' | 'all' | 'working';
    paths: string[];
    minSeverity: Severity;
    includeExamples: boolean;
    color: boolean;
    quiet: boolean;
}

function parseSeverity(v: string | undefined): Severity {
    if (v !== 'low' && v !== 'medium' && v !== 'high')
        throw new Error(`--min-severity must be low|medium|high, got ${v}`);
    return v;
}

const MODE_FLAGS: Record<string, CliOptions['mode']> = {
    '--staged': 'staged',
    '--all': 'all',
    '--working': 'working',
};

function parseArgs(argv: string[]): CliOptions {
    const o: CliOptions = {
        mode: 'staged',
        paths: [],
        minSeverity: 'medium',
        includeExamples: false,
        color: process.stdout.isTTY ?? false,
        quiet: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]!;
        const mode = MODE_FLAGS[a];
        if (mode) o.mode = mode;
        else if (a === '--min-severity') o.minSeverity = parseSeverity(argv[++i]);
        else if (a === '--include-examples') o.includeExamples = true;
        else if (a === '--no-color') o.color = false;
        else if (a === '--quiet') o.quiet = true;
        else if (a.startsWith('--')) throw new Error(`Unknown argument: ${a}`);
        else o.paths.push(a);
    }
    if (o.paths.length && o.mode === 'staged') o.mode = 'working';
    return o;
}

function git(args: string[]): string {
    return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

const SKIP_PATH = ['node_modules/', 'contrib/', 'src/assets/demo/', 'dist/', 'build/', '.husky/_/'];
const SKIP_SUFFIX = [
    '.wasm',
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.ico',
    '.webp',
    '.woff',
    '.woff2',
    '.ttf',
    '.pdf',
    '.lock',
    '.min.js',
    '.min.css',
    'pnpm-lock.yaml',
    'package-lock.json',
    'yarn.lock',
];

function loadSecretsIgnore(root: string): string[] {
    const f = resolve(root, '.secretsignore');
    if (!existsSync(f)) return [];
    return readFileSync(f, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'));
}

function isSkipped(path: string, ignore: string[]): boolean {
    if (SKIP_PATH.some((p) => path.startsWith(p))) return true;
    if (SKIP_SUFFIX.some((s) => path.endsWith(s))) return true;
    if (ignore.some((needle) => path.includes(needle))) return true;
    return false;
}

const MAX_BYTES = 2 * 1024 * 1024;

/** Looks-binary heuristic: a NUL byte in the first 8 KiB. */
function looksBinary(buf: Buffer): boolean {
    return buf.subarray(0, 8192).includes(0);
}

interface FileSource {
    path: string;
    read(): Buffer | null;
}

function collectFiles(opts: CliOptions, root: string): FileSource[] {
    if (opts.mode === 'staged') {
        const raw = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']);
        const paths = raw.split('\0').filter(Boolean);
        return paths.map((p) => ({
            path: p,
            read: () => {
                try {
                    return execFileSync('git', ['show', `:${p}`], { maxBuffer: MAX_BYTES * 8 });
                } catch {
                    return null; // staged delete, submodule, etc.
                }
            },
        }));
    }
    let paths: string[];
    if (opts.mode === 'all') {
        paths = git(['ls-files', '-z']).split('\0').filter(Boolean);
    } else {
        paths = opts.paths.length
            ? opts.paths.map((p) => relative(root, resolve(p)) || p)
            : git(['ls-files', '-z']).split('\0').filter(Boolean);
    }
    return paths.map((p) => ({
        path: p,
        read: () => {
            const abs = resolve(root, p);
            try {
                if (statSync(abs).size > MAX_BYTES) return null;
                return readFileSync(abs);
            } catch {
                return null;
            }
        },
    }));
}

// ── reporting ─────────────────────────────────────────────────────────────

const C = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
    gray: '\x1b[90m',
};
function paint(on: boolean, code: string, s: string): string {
    return on ? `${code}${s}${C.reset}` : s;
}

function severityTag(sev: Severity, color: boolean): string {
    const label = { low: 'LOW   ', medium: 'MEDIUM', high: 'HIGH  ' }[sev];
    const code = { low: C.gray, medium: C.yellow, high: C.red }[sev];
    return paint(color, C.bold + code, label);
}

function scopeLabel(mode: CliOptions['mode']): string {
    if (mode === 'staged') return 'staged content';
    if (mode === 'all') return 'all tracked files';
    return 'working tree';
}

/** Render all blocking findings + the summary footer to stderr. */
function reportBlocking(blocking: Finding[], color: boolean): void {
    blocking.sort(
        (a, b) =>
            SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
            a.file.localeCompare(b.file) ||
            a.line - b.line,
    );

    process.stderr.write('\n');
    for (const f of blocking) {
        const loc = paint(color, C.cyan, `${f.file}:${f.line}:${f.column}`);
        process.stderr.write(`${severityTag(f.severity, color)}  ${f.label}\n`);
        process.stderr.write(`  ${loc}\n`);
        process.stderr.write(`  ${paint(color, C.dim, f.preview)}\n\n`);
    }

    const counts = { high: 0, medium: 0, low: 0 };
    for (const f of blocking) counts[f.severity]++;
    const fileCount = new Set(blocking.map((f) => f.file)).size;
    process.stderr.write(
        paint(
            color,
            C.bold + C.red,
            `✖ ${blocking.length} finding(s) (${counts.high} high, ${counts.medium} medium, ${counts.low} low) in ${fileCount} file(s).`,
        ) + '\n',
    );
    process.stderr.write(
        paint(
            color,
            C.gray,
            'Commit blocked. Remove the secret (move it to an env var / gitignored .env),\n' +
                "or, if it's a confirmed false positive, add a `secret-scan-allow` comment\n" +
                'on the line or a path to `.secretsignore`.\n',
        ),
    );
}

function main(): number {
    const opts = parseArgs(process.argv.slice(2));
    const root = git(['rev-parse', '--show-toplevel']).trim();
    const ignore = loadSecretsIgnore(root);
    const sources = collectFiles(opts, root).filter((s) => !isSkipped(s.path, ignore));

    if (!opts.quiet) {
        const scope = scopeLabel(opts.mode);
        process.stderr.write(
            paint(opts.color, C.cyan, '🔑 secret-scan') +
                ` — scanning ${sources.length} file(s) (${scope})\n`,
        );
    }

    const findings: Finding[] = [];
    for (const src of sources) {
        const buf = src.read();
        if (!buf || looksBinary(buf)) continue;
        for (const f of scanText(buf.toString('utf8'), {
            skipExampleEmails: !opts.includeExamples,
        })) {
            findings.push({ ...f, file: src.path });
        }
    }

    const gate = SEVERITY_RANK[opts.minSeverity];
    const blocking = findings.filter((f) => SEVERITY_RANK[f.severity] >= gate);
    const suppressed = findings.length - blocking.length;

    if (blocking.length === 0) {
        if (!opts.quiet) {
            const extra = suppressed
                ? paint(opts.color, C.gray, ` (${suppressed} below --min-severity)`)
                : '';
            process.stderr.write(paint(opts.color, C.bold, '✔ no secrets found') + extra + '\n');
        }
        return 0;
    }

    reportBlocking(blocking, opts.color);
    return 1;
}

// Run only when invoked as a script (not when imported by the test).
const invokedDirectly =
    process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
    try {
        process.exit(main());
    } catch (err) {
        process.stderr.write(`secret-scan failed: ${(err as Error).message}\n`);
        process.exit(2);
    }
}
