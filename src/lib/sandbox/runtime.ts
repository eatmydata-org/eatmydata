import { evalJS, initQJS } from '@/lib/qjs';
import tsBlankSpace from 'ts-blank-space';

/**
 * `phase` identifies WHERE the failure happened so callers can attribute
 * blame:
 * - `schema-binding` — legacy; no longer fires since the sandbox stopped
 *   binding zod schemas. Kept in the type for backwards compatibility.
 * - `user-code` — the supplied code threw at runtime.
 * - `parse` — the sandbox returned non-JSON, indicating a syntax error
 *   QuickJS couldn't recover from. The error string is the raw QuickJS
 *   message. Also used when TS stripping fails before the code even runs.
 */
export type SandboxErrorPhase = 'schema-binding' | 'user-code' | 'parse';

export type SandboxResult =
    | { ok: true; output: unknown; stdout: string[] }
    | {
          ok: false;
          phase: SandboxErrorPhase;
          /** Top-level error message (no stack). */
          error: string;
          /** Per-key schema binding errors when `phase === 'schema-binding'`. */
          schemaErrors?: Array<{ key: string; error: string }>;
          /** Best-effort line number in USER code (1-based). May be missing. */
          line?: number;
          /** Raw stack from QuickJS (refers to the wrapped script, not user code). */
          stack?: string;
          stdout: string[];
      };

export type SandboxRunArgs = {
    /** User-supplied code (TS or JS). Should assign its final value to `__output`. */
    code: string;
    /** Values bound as globals before user code runs. Must be JSON-serializable. */
    globals?: Record<string, unknown>;
};

let initPromise: Promise<void> | null = null;

/**
 * Lazily initialize the QuickJS context exactly once. Subsequent
 * `runInSandbox` calls reuse the same context — IIFE-wrapping the user code
 * keeps `let`/`const` declarations from leaking into the persistent global
 * scope.
 */
function ensureReady(): Promise<void> {
    if (!initPromise) {
        initPromise = (async () => {
            await initQJS();
        })();
    }
    return initPromise;
}

export async function runInSandbox(args: SandboxRunArgs): Promise<SandboxResult> {
    await ensureReady();
    // Strip TypeScript annotations (whitespace-preserving, so line numbers in
    // any QuickJS stack trace still map back to the original source).
    let jsCode: string;
    try {
        jsCode = tsBlankSpace(args.code);
    } catch (e) {
        return {
            ok: false,
            phase: 'parse',
            error: `TypeScript stripping failed: ${e instanceof Error ? e.message : String(e)}`,
            stdout: [],
        };
    }
    const preambleLines = countPreambleLines(args.globals ?? {});
    const wrapped = wrap(jsCode, args.globals ?? {});
    let resultStr: string;
    try {
        resultStr = evalJS(wrapped);
    } catch (e) {
        return {
            ok: false,
            phase: 'parse',
            error: `Sandbox host threw: ${e instanceof Error ? e.message : String(e)}`,
            stdout: [],
        };
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(resultStr);
    } catch (e) {
        // Either user code crashed before our try/catch (e.g. top-level
        // syntax error → QuickJS returned its own error string), or the
        // host→sandbox transport truncated/corrupted the result. Surface
        // the JSON.parse exception plus head+tail of the raw string so we
        // can tell those apart.
        const parseErr = e instanceof Error ? e.message : String(e);
        const len = resultStr.length;
        const head = resultStr.slice(0, 400);
        const tail = len > 800 ? resultStr.slice(len - 400) : '';
        const body = tail ? `${head}\n…[${len - 800} chars elided]…\n${tail}` : head;
        return {
            ok: false,
            phase: 'parse',
            error: `JSON.parse on sandbox return failed: ${parseErr} (raw length=${len}). Raw bytes:\n${body}`,
            stdout: [],
        };
    }
    const result = parsed as SandboxResult;
    if (!result.ok && result.phase === 'user-code' && result.stack) {
        // Rewrite the line number in the stack so the LLM sees user-code
        // line numbers (1-based) rather than wrapped-script line numbers.
        const adjusted = adjustStackToUserLines(result.stack, preambleLines);
        return { ...result, line: adjusted.line, stack: adjusted.stack };
    }
    return result;
}

/**
 * Count the lines that precede user code inside the wrapped script, so we
 * can subtract that offset from any line numbers QuickJS reports in stacks.
 * Must mirror what `wrap` emits — keep in sync.
 */
function countPreambleLines(globals: Record<string, unknown>): number {
    return wrapPreamble(globals).split('\n').length;
}

function wrapPreamble(globals: Record<string, unknown>): string {
    const globalsJson = JSON.stringify(globals);
    return `(function(){
  var __g = ${globalsJson};
  for (var __k in __g) { globalThis[__k] = __g[__k]; }
  globalThis.__output = undefined;
  globalThis.__stdout = [];
  globalThis.__blocks = [];
  globalThis.md = function(s){
    var text;
    if (s && s.raw && Array.isArray(s)) {
      text = '';
      for (var i = 0; i < s.length; i++) { text += s[i]; if (i < arguments.length - 1) text += String(arguments[i + 1]); }
    } else { text = String(s == null ? '' : s); }
    return { __kind: 'block', type: 'markdown', text: text };
  };
  globalThis.chart = function(option){
    if (!option || typeof option !== 'object') throw new TypeError('chart(option): option must be an ECharts option object');
    return { __kind: 'block', type: 'chart', option: option };
  };
  globalThis.table = function(rows, opts){
    if (!Array.isArray(rows)) throw new TypeError('table(rows): rows must be an array of row objects');
    var b = { __kind: 'block', type: 'table', rows: rows };
    if (opts) { if (opts.columns) b.columns = opts.columns; if (opts.title) b.title = opts.title; if (opts.caption) b.caption = opts.caption; }
    return b;
  };
  globalThis.present = function(){
    for (var i = 0; i < arguments.length; i++) {
      var b = arguments[i];
      if (b == null) continue;
      if (Array.isArray(b)) { globalThis.present.apply(null, b); continue; }
      globalThis.__blocks.push(b);
    }
    globalThis.__output = { __kind: 'blocks', blocks: globalThis.__blocks };
  };
  var __origConsole = globalThis.console;
  globalThis.console = {
    log: function(){
      var parts = [];
      for (var i = 0; i < arguments.length; i++) {
        var a = arguments[i];
        parts.push(
          typeof a === 'string' ? a :
          a === null ? 'null' :
          a === undefined ? 'undefined' :
          typeof a === 'object' ? safeJson(a) :
          String(a)
        );
      }
      globalThis.__stdout.push(parts.join(' '));
    }
  };
  function safeJson(x){ try { return JSON.stringify(x); } catch(_) { return '[unserializable]'; } }
  try {
    (function(){
      "use strict";`;
}

function adjustStackToUserLines(
    stack: string,
    preambleLines: number,
): { line?: number; stack: string } {
    // QuickJS stack frames look like:  "    at <anonymous> (<input>:42:5)"
    // Subtract the preamble offset so 42 becomes the user-code line.
    let firstLine: number | undefined;
    const adjusted = stack.replace(/<input>:(\d+):(\d+)/g, (_, l: string, c: string) => {
        const userLine = Number(l) - preambleLines;
        if (firstLine === undefined && userLine > 0) firstLine = userLine;
        return userLine > 0 ? `<user-code>:${userLine}:${c}` : `<sandbox>:${l}:${c}`;
    });
    return { line: firstLine, stack: adjusted };
}

function wrap(code: string, globals: Record<string, unknown>): string {
    // Preamble + user-code suffix. `wrapPreamble` is shared with
    // `countPreambleLines` so stack offsets line up.
    return `${wrapPreamble(globals)}
${code}
    })();
    return JSON.stringify({ ok: true, output: globalThis.__output, stdout: globalThis.__stdout });
  } catch (e) {
    var __errName = (e && e.name) ? String(e.name) : 'Error';
    var __errMsg = (e && e.message) ? String(e.message) : String(e);
    var __errStack = (e && e.stack) ? String(e.stack) : '';
    return JSON.stringify({ ok: false, phase: 'user-code', error: __errName + ': ' + __errMsg, stack: __errStack, stdout: globalThis.__stdout });
  } finally {
    globalThis.console = __origConsole;
    try { delete globalThis.md; delete globalThis.chart; delete globalThis.table; delete globalThis.present; delete globalThis.__blocks; } catch(_) {}
    for (var __k2 in __g) { try { delete globalThis[__k2]; } catch(_) {} }
  }
})()`;
}
