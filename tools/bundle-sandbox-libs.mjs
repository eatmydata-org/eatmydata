#!/usr/bin/env node
// Bundle libraries that need to run inside QuickJS into self-contained IIFE
// strings. The output files are imported as raw text by the sandbox preamble
// and evaluated before any user code, exposing the libraries on globalThis.
//
// Currently there are no sandbox libraries to bundle — zod was removed when
// the Coder switched to TS type declarations in prompts. Kept as a stub so
// the bundling infrastructure is ready when we need it again.

import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(__dirname, '../src/libs/sandbox');

await mkdir(outDir, { recursive: true });

console.log('no sandbox libraries to bundle');
