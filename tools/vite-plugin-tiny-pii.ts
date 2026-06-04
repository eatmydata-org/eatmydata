/// Serves the offline tiny-pii ONNX bundle (wasm/tiny-pii/build/deploy/)
/// at `/tiny-pii/` in dev and copies it into `dist/tiny-pii/` on build.
///
/// IMPORTANT: a missing file under `/tiny-pii/` must return a real 404,
/// not `next()` — otherwise vite's SPA fallback serves index.html with a
/// 200, and transformers.js (which expects JSON or binary) blows up with
/// "Unexpected token '<'" trying to parse the HTML.

import type { Plugin } from 'vite';
import { resolve, join, extname } from 'node:path';
import { promises as fs, createReadStream, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MIME: Record<string, string> = {
    '.wasm': 'application/wasm',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.json': 'application/json',
    '.onnx': 'application/octet-stream',
    '.txt': 'text/plain',
    '.map': 'application/json',
};

export function tinyPiiAssets(): Plugin {
    const deployDir = fileURLToPath(
        new URL('../wasm/tiny-pii/build/deploy', import.meta.url),
    );

    return {
        name: 'tiny-pii-assets',
        configureServer(server) {
            server.middlewares.use('/tiny-pii', async (req, res) => {
                // Don't `next()` on miss. Vite's SPA fallback would
                // otherwise serve index.html for a missing model file,
                // and transformers.js (which expects JSON or binary)
                // chokes parsing "<!doctype..." as JSON. Return a real
                // 404 instead so the loader sees the error it expects.
                const url = req.url ?? '';
                const rel = url.split('?')[0]!.replace(/^\/+/, '');
                const full = join(deployDir, rel);
                if (!full.startsWith(deployDir)) {
                    res.statusCode = 403;
                    return res.end('forbidden');
                }
                try {
                    const stat = await fs.stat(full);
                    if (stat.isDirectory()) {
                        res.statusCode = 404;
                        return res.end('not found');
                    }
                    const mime = MIME[extname(full).toLowerCase()];
                    if (mime) res.setHeader('Content-Type', mime);
                    res.setHeader('Content-Length', String(stat.size));
                    createReadStream(full).pipe(res);
                } catch {
                    res.statusCode = 404;
                    res.end('not found');
                }
            });
        },
        async writeBundle(opts) {
            if (!existsSync(deployDir)) return;
            const outDir = (opts as { dir?: string }).dir ?? 'dist';
            const dest = resolve(outDir, 'tiny-pii');
            await fs.rm(dest, { recursive: true, force: true });
            await fs.cp(deployDir, dest, { recursive: true });
        },
    };
}
