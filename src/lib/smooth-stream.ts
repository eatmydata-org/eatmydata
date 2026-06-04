/**
 * Buffers a jittery upstream of text chunks (e.g. Chrome's
 * LanguageModel.promptStreaming) and re-emits them aligned to word boundaries
 * at most `maxPerFrame` per requestAnimationFrame tick. Result: visually
 * uniform cadence regardless of raw chunk size.
 */
export type SmoothStreamOpts = {
    boundary?: RegExp;
    maxPerFrame?: number;
};

export async function* smoothStream(
    src: AsyncIterable<string>,
    opts: SmoothStreamOpts = {},
): AsyncGenerator<string, void, void> {
    const boundary = opts.boundary ?? /\s+/;
    const maxPerFrame = opts.maxPerFrame ?? 3;

    let buf = '';
    let done = false;
    let pumpError: unknown = null;

    const pump = (async () => {
        try {
            for await (const chunk of src) buf += chunk;
        } catch (e) {
            pumpError = e;
        } finally {
            done = true;
        }
    })();

    while (!done || buf.length > 0) {
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
        let emitted = 0;
        while (emitted < maxPerFrame) {
            const m = boundary.exec(buf);
            if (!m) {
                if (done && buf.length) {
                    yield buf;
                    buf = '';
                }
                break;
            }
            const end = m.index + m[0].length;
            const word = buf.slice(0, end);
            buf = buf.slice(end);
            yield word;
            emitted++;
        }
    }

    await pump;
    if (pumpError) throw pumpError;
}
