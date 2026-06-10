# semantic engine performance: BGE embeddings + bert-small-pii NER (Q8_0 + SIMD128 + FMA, wasi-sdk-33 / clang 22)

> This doc covers the one `semantic.wasm` engine. The bulk below is the **embedding**
> (bge-small) analysis; the **NER** (bert-small-pii token-classification) numbers are
> in "## NER" just under the roofline note. Both share the encoder/GEMM; NER differs
> only in geometry (4L/512/8h), the classifier head, and its GELU choice.

> **Status (2026-06).** Single-thread throughput went **819 ms/passage (1.2/s) →
> ~99 ms (batched+SIMD128) → ~65 (FMA+4×2) → ~53 (4×4 tile) → ~43 (GELU) → ~38
> ms/passage (26/s)** on Apple M4 Pro (V8, same in Node and Chrome) — **~22×**
> overall — from **(A) batched matmul, (B) SIMD128 f32, (C) FMA, (D) a 4×4
> register-blocked GEMM microkernel (16 accumulators), (E) vectorized rational-tanh
> GELU, (F) vectorized attention context, (G) SIMD softmax exp, (H) key-blocked
> Q·Kᵀ scores (8-way ILP)**, NOT from quantization. (G)+(H) are the long-doc
> finishers — +1.04× typical / +1.12× long, see "SIMD softmax exp + key-blocked
> scores" below; the matmul is now the wall on the f32 path. At ~38 ms it is
> now **~1.6× faster than the bare-ORT single-thread baseline** — measured
> head-to-head in the SAME warm `/tests` run (`bge-embed-engine`): bge **38.0** vs
> **ORT-q8 62.4** (1.64×) ≈ **ORT-fp32 60.0** (1.58×) ms/passage. Long docs gained
> most: **T=434 943 → 370 ms (2.55×)**. A clean-room plain-C engine now clearly
> *beating* a mature MLAS-based runtime — while running **synchronously**, which
> ORT-web cannot (the whole reason bge-embed exists). Download dropped
> **67 MB → ~35 MB** (Q8_0 default, dequant-to-f32 at load). The shipped kernel is
> **f32 SIMD+FMA**, bit-exact wasm↔native (~9e-8) and deterministic. `make
> semantic-verify` green: f16/f32 1:1 vs llama @ 0.9999 (f32 exact 0.99999998), q8_0 @
> 0.999, tokens exact.
>
> ⚠️ **Correction:** an earlier claim of "2.2× faster than ORT" was a measurement
> artifact — it compared a clean/idle bge number against an ORT baseline taken
> under CPU contention (concurrent builds) / a stale page, reading ~143 ms. The
> `bge-embed-engine` test now measures BOTH on the same corpus in the same warm
> run and prints the true ratio, so the comparison can't drift like that again.
>
> **Toolchain: wasi-sdk-33 / clang 22.1.0** (bumped from wasi-sdk-25/clang-19;
> `--target=wasm32-wasip1`). The bump gave **no f32 codegen gain** (66.0 vs 64.7
> ms, within noise) — it was done to unlock **FP16 SIMD**, which clang 22 emits but
> **current Chrome runtime-blocks** behind `--experimental-wasm-fp16`. See
> "Toolchain & FP16" below.
>
> **An int8 GEMM was implemented and then reverted** — see "int8 GEMM:
> investigated & dropped" below. Short version: it broke the wasm==native
> 1:1 property and, per ORT's *own* numbers on the target x86 (`fp32` 144 ms ≈
> `q8` 142 ms), int8 buys **no** single-thread speedup at this size. The real
> lever was f32 GEMM quality (FMA + register blocking) — see "f32 GEMM" below.

**Where we are on the roofline (measured — see "Tier 0 findings"):** the per-passage
workload is **compute-bound, not bandwidth-bound** (~85 MB f32 weights/passage ≈
1.3 GB/s, far under M4's ~120 GB/s). After the **4×4 tile (16 accumulators, shipped)**
the GEMM kernel runs at **~105 GFLOP/s** (was ~74 at 8 accs); the 16-acc FMA ceiling
is ~120, so the kernel is now near it — little GEMM headroom left on the f32 path. The
only way further past the f32 wall is FP16's 8-wide lanes (runtime-blocked) or raising
M (batching). After 4×4 + vectorized GELU + vectorized attention-context, a typical
passage (T≈64, ~38 ms) splits roughly **~68% matmul / ~18% attention (scores +
softmax `expf`) / ~14% LN+tok+GELU**. Matmul now dominates and is near its 16-acc
ceiling; the only remaining attention cost is the scalar softmax `expf` (a SIMD-exp
approximation would help **long docs**, where it's still a large T² term). The
production sync query (T=5) is already **~4–5 ms** and needs no lever.

Everything stays **single-threaded** (no `-pthread`, no SharedArrayBuffer).
Whatever changes, **`make semantic-verify` must stay green** (compile the same C
natively, compare to `llama-embedding` per dtype at the threshold above) AND
wasm must stay bit-exact vs native (the 1:1 principle).

## NER (bert-small-pii token classification) — 2026-06

Same `semantic.wasm`, geometry from the GGUF at runtime: **4 layers, hidden 512,
8 heads (head_dim 64), FFN 2048**, plus a per-token `classifier` head (512→51) →
softmax/argmax + char offsets. Shipped **Q8_0 ~31 MB** (vs the 109 MB fp32 ONNX it
replaces). The encoder + 4×4 GEMM are shared with embeddings; the NER-specific
perf knob is the **GELU**.

**GELU: ship the vectorized SIMD tanh, not scalar erf.** The model's declared
activation is exact-erf GELU, and we first shipped NER with a scalar `erff` path
(`semantic.gelu="erf"`) for maximum fidelity to the ONNX export. But scalar `erff`
over the T×2048×4 FFN is a real cost, while the **vectorized rational-tanh GELU
(`gelu4`)** the embedding path already uses is the standard GELU approximation
(~3e-4 from exact erf — far below q8 noise, and argmax-invariant here). Switching
NER's default to it (`semantic.gelu="tanh"`, the converter default; `--gelu erf`
still available) is a pure win:

- **Speed (measured, controlled A/B, Node-wasm = same V8 SIMD as Chrome, warm/
  TurboFan, 2× interleaved):** `inferTokensSync` per text (23-doc dataset) —
  **tanh `gelu4` 12.8 ms vs scalar erf 14.9 ms → 1.16× faster** (runs 12.8/12.8 vs
  14.8/15.0, tight). The GELU is only part of the forward pass (the GEMM dominates),
  so 1.16× *overall* is the realistic NER impact of vectorizing just that kernel.
- **Quality: identical.** Full-pipeline micro-F1 on the labeled set is **0.821
  detection / 0.806 typed** under BOTH tanh and erf — the tanh switch flipped zero
  argmax decisions. So no measurable quality cost (`quality.test.ts` gate: det ≥0.78,
  typed ≥0.72).

**vs onnxruntime-web (single-thread wasm — the apples-to-apples browser comparison;
NOT `onnxruntime-node`'s native multi-thread bindings).** Measured in the warm
SharedWorker (in-worker `inferMs`, excludes Comlink IPC), Chrome on M4:
semantic ≈ **13–16 ms/text vs ORT-web ≈ 22 ms/text → ~1.5–1.7× faster** (the warm
erf anchor read 15.5 vs 22.2 = 1.43×; the tanh default takes it to ~1.6×). Live
per-machine numbers: `/tests` `bert-ner-vs-onnx`. Beyond latency, two structural
wins ORT-web can't match: the engine is **synchronous** (ORT-web's pipeline is
async-only) and the download is **~3.5× smaller** (31 MB q8_0 GGUF vs 109 MB fp32
ONNX, and no separate ~15 MB ORT runtime wasm in the production bundle).

**Parity (no llama.cpp oracle — llama.cpp has no token-classification head, so NER
isn't bit-exact-gated; the gate is F1 + ONNX agreement):** NER-only detection F1
**C(q8_0) 0.812 ≈ ONNX(fp32) 0.806**, and **C↔ONNX span agreement 0.987** — the
reimplementation reproduces the ONNX model's spans ~99%, with no q8 regression.

**Methodology gotchas (worth recording).** (1) The **gelu speedup is wasm-only** —
the native build uses scalar GELU for both modes, so `semantic-verify` won't show
it; measure in wasm (Node or browser). (2) A **freshly-instantiated** wasm engine
(a one-off page import or ephemeral Worker) reads ~4–5× slow because V8 is still on
the Liftoff baseline tier; only a long-lived instance (the SharedWorker) reaches
TurboFan. Measure in a warmed long-lived worker, or in Node with a heavy warmup
loop before timing — a quick `new Worker()` micro-bench will mislead. (3) The dev
GGUF URL is content-stable, so after regenerating the GGUF the browser Cache
(`semantic-ner-model`) serves the old bytes until evicted — the loader validates
the `"GGUF"` magic and self-heals, but a benchmark must `caches.delete(...)` first.

## Done

- **Batched linear** ([src/model.c](src/model.c) `linear_batch_f32`):
  output-major loop so each weight row is loaded once and reused across all T
  tokens — turns a memory-bound per-token GEMV into a compute-bound GEMM.
  Numerically identical to per-token (same dots, reordered). The single biggest
  win at batch > 1.
- **SIMD128** ([src/model.c](src/model.c) `dotf`): `-msimd128` (wasm only) + a
  4-lane × 4-accumulator f32 dot; the portable 4-accumulator scalar fallback
  uses the SAME grouping so wasm and native stay bit-exact (native `-O3`).
- **Q8_0 dequant-at-load**: [src/bge.c](src/bge.c) `load_qmat` →
  [src/bge.c](src/bge.c) `load_tensor` reads Q8_0 blocks (32 int8 + f16 scale)
  and dequantizes to f32 at load. Pure **download-size win** (~35 MB,
  near-lossless); compute is f32, identical to f16. Shipped default; the engine
  still loads F16/F32.

## int8 GEMM: investigated & dropped (why q8 isn't a *speed* lever here)

Tried keeping Q8_0 weights int8-resident + an int8·int8 GEMM. Findings:

1. **`relaxed_dot_i8x16_i7x16` is non-portable.** It's implementation-defined:
   x86 lowers to `pmaddubsw` (treats operand A as *unsigned*), ARM to a signed
   dot — so with negative weights the wasm result diverges from the signed dot
   by ~5e-3 AND differs **across CPU architectures**. That breaks "verify once
   (native), trust wasm everywhere". llama.cpp deliberately does NOT use it
   ([ggml-cpu/arch/wasm/quants.c](../../contrib/llama.cpp/ggml/src/ggml-cpu/arch/wasm/quants.c)
   uses the exact non-relaxed `extend_i8→i16` + `i32x4_dot_i16x8`).
2. **Exact non-relaxed int8 ≈ f32 speed, not faster.** With the widen+`i32x4_dot`
   path it measured ~88–116 ms vs f32's ~99 ms on ARM — no reliable win. ORT
   confirms the principle on the *target x86*: its `fp32` (144 ms) and `q8`
   (142 ms) single-thread numbers are identical. int8 just doesn't accelerate
   this size of GEMM in a single-thread wasm.
3. **It cost bit-exactness.** Matching the f32-accumulation grouping between the
   SIMD and scalar paths got wasm↔native from 5.5e-3 down to ~2e-3, but a
   residual remained (activation `lrintf`/libm cross-impl), so q8 was never
   truly 1:1 — whereas the f32 path is exact (1e-7).

Conclusion: ship **f32 SIMD batched** (fast, exact, deterministic) + Q8_0 for
download. q8 is a size lever, not a speed lever, on this hardware.

## f32 GEMM: FMA + register blocking (DONE — 2026-06)

The motivation was **GEMM quality, not precision**: ORT's own `fp32`≈`q8`
(59.8≈63.7 ms, same warm run) shows int8 isn't the lever — so closing any gap had
to come from the f32 kernel. Two MLAS techniques `linear_batch_f32` lacked, now
landed in [src/model.c](src/model.c):

1. **FMA.** Replaced `mul`+`add` (2 rounds) with `wasm_f32x4_relaxed_madd(x,w,acc)`
   (1 fused round). Added `-mrelaxed-simd` to the bge-embed flags in
   [CMakeLists.txt](../../CMakeLists.txt). It lowers to `vfmadd` (x86-FMA3) /
   `fmla` (ARM) — every engine we target. Unlike the int8 `relaxed_dot` we
   rejected, f32 FMA is well-defined to ≤0.5 ulp and *more* precise. The native
   gate build uses C99 **`fmaf`** with the SAME accumulation order, so wasm↔native
   stays bit-exact.
2. **Register blocking.** The per-(j,t) `dotf` is replaced by a **4-output-row ×
   2-token microkernel = 8 `v128` accumulators**. Per k-step (stride 4): 6 loads
   (4 weight + 2 activation vectors) feed 8 `relaxed_madd` — load reuse across the
   tile + 8-way ILP to hide FMA latency. Odd last token → 4×1 tail; n_out%4 (never
   hit for D=384/FFN=1536) → the scalar `dotf` remainder. The attention-score
   `dotf` is also FMA'd (single v128 accumulator, lane L = k≡L mod 4).

**Bit-exactness held.** Each `Y[t][j]` accumulates in the same lane order as the
scalar `dot4_fma`, so the native build (no SIMD) reproduces the wasm result
bit-for-bit. `make semantic-verify` 21/21 (f16/f32 @ 0.9999, q8_0 @ 0.999, tokens
exact); wasm↔native parity (Node `embedTextsSync` vs native `bge-cli --raw`,
Q8_0) **max|Δ| ≈ 9e-8, cosine 1.000000000** across the corpus.

**Throughput** (Apple M4 Pro, V8 — same arch in Node *and* Chrome, 32×30-word
passages): the FMA + register-blocking change itself was **100.9 → 64.7 ms/passage
= 1.56×** (Node, clean A/B on the identical bench), confirmed in the real browser
over CDP (~65 ms; cold sweep #1 already 65 ms — no Liftoff→TurboFan ramp). **Versus
ORT, it lands at parity** — head-to-head in the same warm `/tests` run: bge **63.3**
vs **ORT-q8 63.7** ≈ **ORT-fp32 59.8** ms/passage (~1.0× vs q8, ~6% slower than
fp32). The model scratch + `mm` wrapper are unchanged; no new allocations.

> **Measurement gotcha that bit us once:** [runtime.ts](../../src/lib/bge-embed/runtime.ts)
> memoizes `warmupPromise`, so a warmed page keeps its **original wasm instance**
> forever and never re-fetches. After rebuilding the `.wasm`, a `/tests` *re-run*
> without a full page reload still measures the STALE kernel (this is what made an
> old build read 242 ms while the fresh one was 65 ms). Always hard-reload
> (Cmd+Shift+R) before re-benching, or import a fresh module instance.

## Toolchain & FP16 (wasi-sdk-33 / clang 22) — 2026-06

Bumped wasi-sdk **25 → 33** (clang 19 → **22.1.0**); pinned via `WASI_SDK_RELEASE`
+ `WASI_SDK_FILE_VER` in [CMakeLists.txt](../../CMakeLists.txt), all targets on
`--target=wasm32-wasip1`. Two clang-22 build fixes (no submodule patches): the C99
K&R-removal diagnostics are now hard errors by default, so wa-sqlite carries
`-Wno-implicit-int -Wno-implicit-function-declaration`. Details in
[[reference_wasi_sdk_33_and_wasm_fp16]].

**Why we bumped: FP16 SIMD (8-wide) — the one lever past the 4-wide f32 ceiling.**
Three gates checked end-to-end:
- **Toolchain ✅** — clang 22 `wasm_simd128.h` exposes 63 `f16x8` ops incl. fused
  `wasm_f16x8_relaxed_madd`. (clang 19 had **zero**.) Compiled a real probe module.
- **Runtime ❌** — that probe (opcode `0xfd ce 02`), validated in the live Chrome
  149 over CDP, throws `CompileError: invalid simd opcode … enable with
  --experimental-wasm-fp16`. FP16 wasm is behind an experimental V8 flag → a module
  using it throws for normal users. **Not shippable today.**
- **Precision ⚠️** — the 2× only comes from f16 *accumulate*, which breaks the 1:1
  property and likely the cosine gate; f16-mul/f32-accumulate is safe but ~0× compute
  gain (and there's no direct `f16x8↔f32x4` convert in the header).

⇒ The upgrade **positions** us for FP16 but unlocks nothing yet. Revisit when FP16
wasm ships **unflagged** in stable Chrome/V8 (watch chromestatus "WebAssembly FP16").

---

## Tier 0 findings (DONE — measured 2026-06, M4 Pro, V8/Node)

Methodology-first, and it **reordered the roadmap**. All numbers measured (microbench
wasm built with the same clang-22 flags; harnesses in `/tmp`, regimes via the bge
runtime; token counts via `bge-cli --tokens`).

1. **FMA is real; V8 lowers `relaxed_madd → fmla`.** The `.wasm` has **30×
   `f32x4.relaxed_madd`** (`fd 85 02`; llvm-objdump mislabels it `<unknown>` — its
   relaxed-SIMD table is behind). A pure-FMA microbench hits **122 GFLOP/s**, far
   beyond what mul+add could do → V8 is fusing.
2. **Pure-FMA roofline by ILP:** 8 accumulators **79.8**, 16 acc **120.1**, 24 acc
   **122.3** GFLOP/s. The FMA units saturate around **16 independent chains**.
3. **The real 4×2 kernel hits ~74 GFLOP/s** (ffn-up 74.6, ffn-down 69.8, qkv/o 74.5)
   — i.e. **93% of the 8-accumulator ceiling. It is FMA-latency-bound at 8
   accumulators, NOT load-bound.** ⇒ **weight packing won't help** (loads aren't the
   limit); **widening to ~16 accumulators is the GEMM lever** (8-acc 80 → 16-acc 120).
4. **Time decomposition** (regime sweep fit to `t ≈ a·T + b·T² + c`:
   a≈0.805 ms/tok, b≈0.0031 ms/T², c≈0.44 ms):

   | regime | total | matmul (∝T, 74 GFLOP/s) | attention (∝T²) | GELU+LN+tok (∝T) |
   |---|---|---|---|---|
   | T=5 (prod sync query) | **4.5 ms** | ~3 ms | ~0.1 ms (2%) | ~1 ms |
   | T=64 (typical passage) | **65 ms** | ~37 ms (57%) | ~13 ms (20%) | ~15 ms (23%) |
   | T=434 (long doc) | **943 ms** | ~250 ms (26%) | **~593 ms (63%)** | ~100 ms |

   Takeaways: the **production sync query (T=5) is already 4.5 ms** and GEMM/fixed-
   bound — attention is irrelevant there, no lever needed. For **typical passages
   (T~64)** matmul is the majority (57%). For **long docs** the **scalar O(T²)
   attention dominates (63%)**.

## Next directions for experimentation (re-ranked by Tier-0 data)

**✅ #1 DONE — Register-tile widen 8 → 16 accumulators (4×4 tile).** Shipped in
[src/model.c](src/model.c) `linear_batch_f32` (T%4 + n_out%4 tails fall back to the
bit-exact scalar `dotf`). Prototyped 4×4 vs 8×2 in a microbench first: **4×4 won**
(102–109 vs 8×2's 92–101 GFLOP/s — 4×4's 2.0 load:compute beats 8×2's 1.6). Kernel
**74 → ~105 GFLOP/s** (≈1.45×); **whole passage 64.7 → 52.9 ms (Node, 1.22×)**, and
in the real browser **53.2 ms — now 1.17× faster than ORT-q8 / 1.12× vs ORT-fp32**
(same warm `/tests` run). Stayed bit-exact wasm↔native (~9e-8) and `semantic-verify`
21/21 (per-cell single-v128 lane order preserved). No V8 spill penalty (105 is ~88%
of the 16-acc microbench ceiling).

**✅ #2 DONE — vectorized GELU (rational tanh).** Replaced the scalar libm `tanhf`
in GELU with a minimax rational (odd 13/6, |x|≤9 clamp; Eigen/cephes `generic_fast_
tanh_float` coefficients — published method, reimplemented) — `rtanh4`/`gelu4`
(`relaxed_madd`) in [src/model.c](src/model.c), with the scalar `rtanhf`/`geluf`
(`fmaf`) in the SAME op order so wasm == native and the gate verifies what ships.
Microbench: GELU kernel 4.2 → 0.73 ms (5.75×), error ≤ 9.5e-7 vs `tanhf`. **Real
passage: 52.9 → 43.2 ms (Node, 1.22× — the in-context scalar GELU was ~10 ms, more
than the isolated microbench), browser 43.6 ms = 1.44× faster than ORT-q8 / 1.38× vs
fp32.** Stayed bit-exact (1.16e-7) and `semantic-verify` 21/21 (rational vs llama's f16
GELU table is well inside the 0.9999 gate). ⚠️ Provenance: uses the standard
published tanh coefficients — flag if the repo's clean-room policy wants a
self-derived minimax instead.

**✅ #3 DONE — vectorized attention context.** Reordered the per-(head,query)
context reduction from c-outer (strided gather per channel) to **u-outer with 8 SIMD
accumulators** (head_dim 32 → loads each `v` row's 32 floats once, `relaxed_madd`);
native uses the c-outer `fmaf` fallback in the same per-channel u-order → bit-exact.
**Typical T=64 43.2 → 37.8 ms (1.14×); long doc T=434 943 → 370 ms (2.55× vs the
original).** Browser head-to-head **38.0 vs ORT-q8 62.4 = 1.64×**. Parity 1.19e-7,
semantic-verify 21/21. (Scores already used SIMD `dotf`; softmax left scalar — see below.)

## SIMD softmax exp + key-blocked scores (DONE — 2026-06)

Two bit-exact attention levers, landed + measured together. Both target the
**non-dominant** attention/softmax terms (see the corrected roofline below), so
the wins are real but modest — the linear matmul is the wall.

1. **SIMD softmax `exp`** ([model.c](src/model.c) `exp4` / `expf_approx`). The
   per-(head,query) softmax called scalar libm `expf` over `att[u]-mx` — the last
   scalar term in attention, O(layers·H·T²). Replaced with a degree-5 minimax
   `exp` (cephes/Eigen `pexp` lineage; range-reduce `x=m·ln2+r`, poly for
   `exp(r)`, scale by `2^m` via the IEEE exponent field). Vectorized 4-wide on
   wasm (`relaxed_madd`), scalar `fmaf` natively in the SAME op order → wasm ==
   native bit-for-bit. The normalization **sum stays scalar-sequential** (same add
   order both builds), so only the `exp` itself is vectorized — no reduction-order
   drift. Same published-coefficient provenance caveat as the tanh-GELU.
2. **Key-blocked scores `Q·Kᵀ`** ([model.c](src/model.c)). The scores `att[u] =
   scale·dot(q_t,k_u)` were computed one-`u`-at-a-time via the single-accumulator
   `dotf` — **FMA-latency-bound, no ILP**, and O(T²). Key-block ×8: 8 independent
   v128 accumulators feed the FMA pipeline (8-way ILP), `q_t` reused across the
   block. Each `att[u]` hsums in `dotf`'s exact lane order, so the value is
   **bit-identical** to the old per-`u` `dotf` (a pure-perf change, zero numerical
   delta) and to the native scalar path (kept under `#else`).

**Throughput** (Apple M4 Pro, Chrome 149 / V8 14.9, controlled same-session A/B —
each build measured via CDP against the same warm page, best-of-3 medians of a
full corpus sweep; baseline = the prior shipped kernel re-measured this session):

| regime | baseline | + softmax exp | + scores ×8 | total |
|---|---|---|---|---|
| query (T≈11, prod sync) | 10.86 ms | 10.91 | 10.84 | **1.00×** (attention irrelevant at tiny T) |
| typical (T≈32 passage) | 40.29 ms | 39.25 | 38.78 | **1.04×** |
| long (T≈460 doc) | 367.0 ms | 345.1 | 328.9 | **1.12×** |

**Correctness (the whole point):** `make semantic-verify` **22/22** (f16/f32 1:1 @
0.9999, q8_0 @ 0.999, tokens exact, NER smoke). wasm↔native parity on a long
softmax-heavy passage (q8_0) **max|Δ| = 5.0e-8, cosine = 1.0** — same envelope as
the rest of the kernel, so the SIMD/scalar exp pair and the key-blocked scores are
bit-equivalent on the target. In-browser: cosine vs the prior kernel **0.99999999**
(softmax exp shifts the output ~1e-8; the scores block shifts it 0), ONNX agreement
**0.989** (≥0.97). NER F1 vitest gate (det ≥0.78 / typed ≥0.72) **green** — the
shared attention change flipped no PII argmax.

**Methodology note (CDP browser bench).** Measured by importing the live
[runtime.ts](../../src/lib/bge-embed/runtime.ts) from the Vite dev server into a
dedicated tab over CDP (raw WebSocket to the user's Chrome — no Playwright), with
`Network.setCacheDisabled` so each rebuild's `.wasm` is re-fetched (sidesteps the
`warmupPromise`-memoization stale-kernel trap noted above). Heavy untimed warmup
loop first → V8 TurboFan, then best-of-3 medians. Numbers reproduce PERF.md's
prior absolutes (typical ~38–40, long ~367–370).

> **Corrected roofline (this measurement overturned a prior assumption).** PERF.md
> previously read long docs as *attention-dominated* (the stale Tier-0 fit, before
> the context-vectorization landed). Re-measuring after vectorizing `exp` showed
> only +6% — because the **linear matmul (Q/K/V/O/FFN), which scales with T,
> dominates BOTH regimes**: at T≈460 it's ~21M MACs/token × 460 ≈ 9.8 GMAC ≈ 186 ms
> of the 329, vs attention's T²·H·head_dim ≈ 2 GMAC (head_dim is only 32, 12 heads).
> So even at long T the split is roughly **matmul ~57% / attention ~20% / softmax+
> LN+tok ~23%**, and the matmul runs at the **16-accumulator FMA ceiling already**
> (~105 GFLOP/s, 88% of the 120 microbench peak). ⇒ **The remaining single-thread
> f32 levers are all ≤~5%** (they touch the non-dominant terms); the matmul wall
> only moves with **FP16** (8-wide, runtime-blocked) or **fewer MACs**
> (last-layer-CLS-only, ~4%, EMBED-only). The big throughput lever for *indexing*
> is **data-parallel across N workers** (≈N×, single-thread per worker, no COI) —
> out of this single-thread doc's scope but the real answer to "indexing is slow".

## LUT-GEMM (T-MAC style) + precision ruler: investigated & dropped (2026-06)

After the matmul was confirmed to be the wall on the f32 path, the obvious "past
the wall" idea from recent literature is **T-MAC** (arXiv:2407.00088, up to 6.6×
over llama.cpp on edge CPUs): low-bit `mpGEMM` as **table lookups** (no dequant, no
multiplies), whose core primitive is a 16-entry SIMD byte-table lookup = WASM's
`i8x16.swizzle`. Unlike the earlier int8 attempt (which fell back to widen+`i16x8_dot`
≈ f32), the swizzle path is what makes T-MAC fast natively. Two browser probes
(CDP, M4 / V8 14.9) settled it — **it does NOT transfer to WASM:**

1. **Ceiling probe** (standalone microbench, `i8x16.swizzle` LUT loop vs the
   `f32x4.relaxed_madd` 16-accumulator loop, both 16-way ILP, DCE-guarded):

   | path | effective GMAC/s | vs f32 FMA |
   |---|---|---|
   | f32 FMA | 61.5 (123 GFLOP/s — matches the roofline ceiling) | 1.00× |
   | LUT W4A8 | 44.8 | **0.73× (slower)** |
   | LUT W2A8 | 89.6 | 1.46× |
   | LUT W1A8 | 179.3 | 2.91× |

   Root cause: V8 runs a **fixed ~15 G-SIMD-ops/s** regardless of op kind, and
   `swizzle` is **not faster per-op** than `relaxed_madd` (it needs the
   accompanying widen+accumulate). So LUT only wins when it resolves more MACs per
   op than FMA's 4 MAC/op — which takes **int2 (1.46×) or int1 (2.9×)**; **int4
   loses**. The native 6.6× comes from a dequant-heavy llama.cpp baseline + wider
   native SIMD/`tbl` throughput — neither holds here (our f32 FMA baseline is
   already op-throughput-optimal).

2. **Precision ruler** (label-free: 10-theme × 6-paraphrase corpus, per-row int-`bits`
   weight requantize via the debug `sem_debug_requantize` hook; `recall@5` of each
   item's exact nearest neighbors + cosine-vs-exact — the metric that actually
   matters for search):

   | precision | mean cos vs exact | recall@5 vs exact | theme-purity |
   |---|---|---|---|
   | W8 | 0.9998 | 0.987 | 0.657 (≈ exact 0.650) |
   | W4 | 0.954 | 0.857 | 0.657 |
   | W3 | 0.791 | 0.653 | 0.597 |
   | W2 | 0.525 | **0.200** | 0.167 |

**Conclusion:** the two probes don't overlap. The only LUT regimes that beat f32
(W2/W1) **destroy retrieval** (W2 recall 0.20, clustering gone); the only precision
that preserves ranking (W4, recall 0.86) is **slower** than the f32 kernel (0.73×).
Low-bit would need quantization-aware retraining (data + training infra — out of
scope) to land both. ⇒ **The precision axis is exhausted** (int8 = shipped &
lossless; int4 = no speed; int2 = broken). Tooling kept for re-checks on future
toolchains/CPUs: the ceiling microbench and `sem_debug_requantize` /
`debugRequantizeWeights` (the precision ruler).

**Where that leaves "go faster" (single-thread):** with both the compute-scheduling
axis (matmul at the FMA ceiling) and the precision axis (no fast+accurate low-bit)
exhausted, real single-thread gains now require **fewer MACs**, not faster ones:
- **Token merging (ToMe-style, training-free)** — merge redundant tokens across
  layers → cut the dominant ∝T matmul. CLS-pooled embeddings tolerate it; tunable
  `r`, gated by the recall ruler above. The strongest remaining *in-engine* lever.
- **Low-rank FFN factorization** — cut the ∝D² term where the spectrum allows;
  likely needs fine-tuning to hold quality (risk).
- **Skip the transformer for indexing — Model2Vec** (github.com/MinishLab/model2vec):
  static token embeddings (lookup + pool), ~500× faster on CPU, ~80–92% of MiniLM
  MTEB, distilled offline in 30s. The extreme answer to "indexing is slow", at a
  real quality cost; a *fast-index tier*, not a kernel change.
- **Data-parallel across N workers** — ≈N×, orthogonal, the throughput lever.

## Model2Vec static embedder — SHIPPED (the real answer to "indexing is slow", 2026-06)

The single-thread BERT path bottomed out at ~38 ms/passage. Rather than chase the
last few %, production semantic search **switched to a Model2Vec static embedder**
distilled from BGE: tokenize → gather one static vector per token → mean → L2
normalize. No transformer. **~88,000 embeds/sec in Chrome (~3,500× the BERT path)**;
the engine cost ceases to be the indexing bottleneck.

- **From-scratch, in-engine.** New `SEM_KIND_STATIC` in the same `semantic.wasm` /
  `wa-sqlite.wasm`: `sem_static_embed` reuses `sem_tokenize` (WordPiece) + a
  `[vocab × dim]` f32 table loaded from a GGUF. `sem_embed` auto-routes by model
  kind, so the query path (`analyst_embed_query`) and index path (`embedTexts`)
  both follow with no caller change. The `model2vec` Python lib is used OFFLINE
  only, to produce the artifact (`make m2v-model SRC=… DIM=…` →
  [tools/convert-m2v-gguf.py](tools/convert-m2v-gguf.py)); nothing of it ships.
- **1:1 parity with Python model2vec** (the gate): mean = sequential-f32 sum/k
  (bit-exact to numpy `mean(axis=0)`), norm = `sqrt(numpy-pairwise-sumsq)`. Native
  sem-cli vs `sm.encode` over 406 real product names + unicode/case/punct edges:
  **max|Δ| 8.9e-08, cosine 0.99999988, 0 mismatches**; wasm↔native **7.9e-08,
  cosine 1.0**. The distilled matrix is reindexed into the bge GGUF's id order
  (model2vec reorders/removes ids) so the runtime reuses the llama-verified
  tokenizer unchanged; shipped **f32** (cleaner parity + better quality than
  model2vec's f16 default), 30522×256 ≈ 31 MB.
- **Quality** (Phase-0, real Contoso product→subcategory retrieval, 1489 rows /
  32 labels): MAP@10 **0.976** vs full-bge **0.987** — ~1% off, and the bag-of-words
  tradeoff is a near-ideal fit for short product/column text (where it shines).
- **Teacher size is a dud here.** bge-{small,base,large} distill to essentially
  the same static quality (0.974–0.977) — the full teachers are themselves tied on
  this task (0.985–0.987), so there's no gap to transfer. Shipped **bge-base d256**;
  bge-large wastes a 1.3 GB download for nothing. d256 ≈ d384.
- **Selection is a compile-time constant** `SEMANTIC_EMBEDDER` in
  [semantic-index-core.ts](../../src/lib/data-sources/semantic-index-core.ts)
  (full switch, flip to `'bge'` to revert) — it drives the GGUF, `EMBED_DIM` (256),
  and `EMBED_MODEL`. `isAlreadyIndexed` rebuilds any column whose stored model ≠
  the active one, so a bge↔m2v switch self-heals stale indexes. Query is SYMMETRIC
  for m2v (no BGE instruction prefix — gated by model kind in runtime_shim.c).
- **Indexes are no longer prebuilt** into demo files; the browser builds them at
  import/seed time (`autoIndexAfterImport`), now cheap.

The bge BERT engine stays as the NER backbone, the standalone `/embeddings` + `/tests`
bench surface, and the selectable `'bge'` high-accuracy embedder; everything below
this line documents that engine.

**Tier 1 — remaining (bit-exact, current toolchain):**
1. **✅ DONE — SIMD softmax `exp`** (2026-06). See "SIMD softmax exp + key-blocked
   scores" below. The last scalar attention term, vectorized; +6% on long docs.
2. **✅ DONE (bonus) — key-blocked attention scores `Q·Kᵀ`** (2026-06, NOT originally
   on this list — surfaced by measuring after #1). The per-`u` `dotf` was a
   single-accumulator dot (FMA-latency-bound, no ILP); key-block ×8 gives 8-way ILP.
   +5% on long docs. Same section below.
3. **Fuse Q/K/V** into one `[3D×D]` matmul — bigger N, one weight stream. PERF.md
   originally estimated ~1.05–1.15×, but the corrected roofline (matmul is
   compute-bound at the FMA ceiling) says fusing changes **neither FLOPs nor
   FLOP/s** — it only removes 2 `mm()` call setups (negligible). **Reclassified
   ~1.0×; not worth the weight-concatenation-at-load complexity.**
4. **LayerNorm** — now only part of the ~14% LN+tok+GELU; vectorizing the
   double-precision mean/var (f64x2) is fiddly for little gain. **Low priority.**
5. **Last-layer CLS-only (EMBED)** — only `x[0]` survives CLS-pooling, so the final
   layer needs Q/O/FFN for token 0 only (K/V stay full). Skips ~(T-1)/T of the last
   layer's FFN+O-proj ≈ **~4% (1/n_layers of the dominant matmul)**, bit-exact,
   EMBED-only. The only lever that touches the *dominant* matmul without FP16.
   Not landed — modest, and branches a shared correctness-critical function.

**DROPPED by the data:**
- **Weight panel packing** — the kernel is at 93% of the 8-acc FMA ceiling (and ~88%
  of the 16-acc ceiling after 4×4), so it's *not* load-bound; packing buys ~nothing.

**Tier 2 — raise M (the big lever for *indexing* throughput, bit-exact):**
4. **Batch passages** into `[B·T, D]`: weights stream once for the whole batch, kernel
   runs near-peak. **Est. 1.5–3× batch throughput** — indexing only, not sync-query
   latency. Needs a batched `bge_embed`. Highest-leverage if we move indexing off ONNX.

**Tier 3 — blocked / low-value:**
6. **FP16 (8-wide)** — toolchain-ready (clang 22), **runtime-blocked** (Chrome
   `--experimental-wasm-fp16`). The real ~2× lever; revisit when stable-Chrome ships it,
   gated on the f16-accumulate precision tradeoff (f16 path for *indexing* behind
   cosine-0.99, keep bit-exact f32 for sync query + verify).
7. **int8 (portable `i16x8_dot`)** — measured ≈ f32 before; deprioritized.

Suggested order: ✅ tile-widen ✅ GELU ✅ attention-context done. Matmul now dominates
(~68%) and is near its f32 ceiling — the big remaining f32 lever is **batching** (M↑,
for indexing throughput, if we move indexing off ONNX). Smaller cleanups: SIMD
softmax `expf` (long-doc), Q/K/V fuse, LayerNorm. The next *step-change* is **FP16**
(blocked on stable-Chrome).

---

The original design-detail sections below are kept for reference (Levers 1 & 2 are
now shipped).

---

## Lever 1 — Q8_0 weights (download + RAM)

**Why:** the F16 GGUF is 67 MB; a Q8_0 GGUF is ~33 MB (matches the current ONNX
q8 footprint) and is near-lossless. It also unifies precision with the ONNX-q8
indexer (see "Mixed-precision note" below).

**What it is:** GGML `Q8_0` = blocks of 32 int8 weights + one F16 scale (34 bytes
/ 32 weights). Dequant: `w[i] = scale * q[i]`.

**Two implementation options:**

- **(1a) Dequant→f32 at load** *(recommended first — smallest change).* Add a
  `GGML_T_Q8_0` branch to `load_tensor` in [src/bge.c](src/bge.c): walk blocks,
  `dst[base+i] = f16_to_f32(scale) * (float)q[i]`. **Zero kernel changes** —
  `model.c` stays f32. Wins the 67→33 MB *download*; resident RAM stays ~132 MB.
- **(1b) Keep Q8_0 resident, dequant in the matmul** *(follow-up, if RAM matters
  in-browser).* Store blocks as-is (~35 MB resident) and dequant inside the
  `linear()` dot. This is what llama.cpp's q8_0 path does; it's the bigger change
  (a block-wise dot kernel) and pairs naturally with Lever 2 (SIMD int8 dot).

**Touch points:** [src/gguf.h](src/gguf.h) (add `GGML_T_Q8_0 = 8` to the enum +
its block size in the span check), [src/gguf.c](src/gguf.c) (the `esz`/nbytes
bounds check must understand block types), [src/bge.c](src/bge.c) (`load_tensor`
dequant for 1a; the resident-block representation + `model.c` kernel for 1b).

**Model asset:** add a q8_0 fetch to
[test/fetch-model.sh](test/fetch-model.sh) (`CompendiumLabs/bge-small-en-v1.5-gguf`
ships `bge-small-en-v1.5-q8_0.gguf`) and let `bge_init` accept either dtype
(it already validates by element count, not file_type). Decide which the shipped
[runtime.ts](../../src/lib/bge-embed/runtime.ts) default loader points at.

**Verify:** `make semantic-verify` against the **q8_0** GGUF (llama-embedding reads
the same q8_0 file). Q8_0 is near-lossless so the cosine gate holds at ≥ 0.999;
keep `max_abs` a touch looser than f16 if needed. Note bit-exact is never
expected across implementations.

---

## Lever 2 — SIMD128 (compute speed)

**Why:** the forward pass is ~90% matmul (`dotf` in `linear()`): per token, 12
layers × (4·D·D for q/k/v/o + 2·D·FFN for the FFN) ≈ 12·(4·384² + 2·384·1536) ≈
21M MACs. Scalar today. `wasm32` + `-msimd128` gives a 4-lane f32 `v128`.

**Plan:**

1. Add `-msimd128` to the `bge-embed` flags in [CMakeLists.txt](../../CMakeLists.txt)
   and to the native `cc` line in [test/verify.sh](test/verify.sh) (so the gate
   exercises the same kernels). Still single-thread.
2. Vectorize the hot kernels in [src/model.c](src/model.c) behind
   `#ifdef __wasm_simd128__` (with the current scalar loop as the portable
   fallback for non-SIMD builds / other targets):
   - **`dotf`** first — 4-wide `wasm_f32x4_*` multiply-accumulate, horizontal
     sum at the end. Biggest single win.
   - then the attention score/context dots and `geluf` (vectorize the
     `tanhf`-approx polynomial; `tanhf` itself can stay scalar per lane or use a
     vectorized approximation — measure).
   - LayerNorm reductions are minor; leave scalar initially.
   Use **unaligned** loads (`wasm_v128_load` tolerates it; our f32 weight arrays
   are malloc-aligned anyway) and handle the `n % 4` tail scalar.
3. (Optional, with 1b) an int8 `i8x16` block dot for Q8_0-resident weights.

**Correctness caveat:** SIMD changes float **summation order**, so the result
drifts from the scalar/llama path by ~1e-6–1e-5 per element — still far inside
the cosine ≥ 0.9999 gate (which is already tolerance-based, not bit-exact). If a
specific kernel drifts more than expected, that's a bug signal, not acceptable
noise.

**Native parity:** the native verify build should also compile with SIMD (clang
supports `-msimd128` only for wasm; for the *native* arm64/x86 build, either let
the compiler autovectorize the scalar fallback with `-O3 -march=native`, or gate
the intrinsics so native uses the scalar path). Simplest: keep the scalar
fallback as the native path and rely on `-O3` autovectorization there; the wasm
path uses the intrinsics. The gate still compares wasm-equivalent math within
tolerance.

---

## Measuring

- **Throughput:** the `/embeddings` route now shows a `bge-embed / ggml-f16` row,
  and `/tests` runs `bge-embed-engine` (ms/passage). Compare before/after there,
  and via native timing in [test/verify.sh](test/verify.sh) (wrap the corpus
  loop in one `clock()` bracket).
- **Quality:** `make semantic-verify` (cosine gate) after each lever.
- Record numbers in a short note here when done.

## Acceptance

- `make semantic-verify` green for the new build(s) (cosine ≥ 0.9999).
- Lever 1: shipped download ~33 MB; loader points at the chosen dtype.
- Lever 2: measured single-thread speedup (target ≥ 2× on `dotf`-bound matmul),
  scalar fallback preserved for non-SIMD/native.

---

## Mixed-precision note (context for whoever picks this up)

Query embedding now runs through **bge-embed (F16)** ([runtime.ts](../../src/lib/bge-embed/runtime.ts),
wired in [semantic-embed-host.ts](../../src/lib/wa-sqlite/semantic-embed-host.ts)),
while passage **indexing still uses the ONNX-q8 SharedWorker**
([semantic-index.ts](../../src/lib/data-sources/semantic-index.ts)). Same model,
different quantization → query·passage cosine ≈ 0.97–0.99, fine for ranking
(the `/tests` `bge-embed-engine` check asserts ≥ 0.97 agreement). Lever 1 (Q8_0)
narrows that gap. A larger follow-up — **also** move indexing onto bge-embed —
would unify the engine entirely and drop the ONNX embeddings model + its 33 MB
download; that's out of scope here but is the natural end state and would make
this the single embedding path.
