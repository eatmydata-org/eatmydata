"""Build transformers.js-loadable bundles for the app's on-device models.

The browser "Transformers Worker" (src/lib/transformers/worker.ts) hosts
multiple models on one transformers.js runtime. This script exports each
model in MODELS to ONNX and lays them out under one deploy tree so a
single `env.localModelPath` base serves all of them:

      <deploy>/manifest.json                     (multi-model manifest)
      <deploy>/ort/                              (shared onnxruntime-web wasm)
      <deploy>/<model_id>/config.json
      <deploy>/<model_id>/tokenizer.json
      <deploy>/<model_id>/tokenizer_config.json
      <deploy>/<model_id>/onnx/model*.onnx

For each model it:
  1. Downloads MODEL_ID from HF and exports it to ONNX (`--task <task>`)
     via `optimum.exporters.onnx`. For `feature-extraction` (embeddings)
     this exports the bare encoder producing `last_hidden_state`;
     transformers.js's feature-extraction pipeline does the CLS pooling +
     L2-normalize itself at inference time.
  2. Fetches tokenizer artifacts directly from HF over HTTP (we can't
     rely on optimum to copy them — for models saved with transformers
     5.0's `TokenizersBackend` placeholder, the venv's AutoTokenizer
     can't load them and optimum quietly skips them. transformers.js
     handles `TokenizersBackend` natively, so the raw files are fine).
  3. Optionally downcasts/quantizes (fp16 / q8) per the model's policy.

The shared onnxruntime-web wasm is mirrored into <deploy>/ort/ once after
all models are assembled, so the worker can pin
`env.backends.onnx.wasm.wasmPaths` to a same-origin path (and stay
offline).

Run with: python3 build.py
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path

from transformers import AutoConfig

ROOT = Path(__file__).resolve().parent
REPO_ROOT = ROOT.parent.parent
BUILD = ROOT / "build"
DEPLOY = REPO_ROOT / "src" / "assets" / "transformers"
EXPORT_ROOT = BUILD / "export"


@dataclass(frozen=True)
class Model:
    # Stable role key — becomes the manifest's `models.<key>` entry, and
    # the ModelKey the worker passes to warmup/isCached/embed/analyze.
    key: str
    # HF repo id. The deploy tree mirrors this org/name structure so a
    # single base URL (env.localModelPath) resolves <base>/<model_id>/…
    model_id: str
    # transformers.js task; selects the pipeline kind on the worker side.
    task: str
    # Force a dtype, bypassing the never-upscale auto policy. None = auto.
    dtype_override: str | None = None


# The models the Transformers Worker hosts. The rest of the pipeline is
# model-agnostic as long as the architecture is one transformers.js
# supports.
MODELS = [
    # PII NER — keep at fp32 (its source precision; never-upscale auto).
    Model(
        key="pii",
        model_id="gravitee-io/bert-small-pii-detection",
        task="token-classification",
    ),
    # BGE text embeddings — used by the Node demo-data build pipeline
    # (scripts/lib/semantic-index-node.ts via onnxruntime-node). The browser
    # runtime uses bge-embed (wasm/bge-embed/) instead; this ONNX export is
    # build-tooling only.
    Model(
        key="embeddings",
        model_id="BAAI/bge-small-en-v1.5",
        task="feature-extraction",
        dtype_override="q8",
    ),
]

# Manifest schema version. Bump when the worker-visible shape changes so
# a stale deploy fails loudly (the worker guards on `models` + schema).
MANIFEST_SCHEMA = 2

# ONNX opset. ModernBERT recommends >= 18; classic BERT is fine at 14.
# 18 works for both, so we default to it.
OPSET = "18"

# Filename suffix transformers.js expects under <model_id>/onnx/ for each
# dtype. Sourced from DEFAULT_DTYPE_SUFFIX_MAPPING in transformers.js;
# the worker passes `dtype` to pipeline() and the loader appends the
# suffix to `model.onnx`. Note: bf16 has no entry here because
# transformers.js's loader doesn't know how to pick a bf16 file (and
# onnxruntime-web has patchy bf16 kernel coverage anyway) — so a bf16
# source becomes an fp16 export, never a bf16 export.
DTYPE_ONNX_NAME = {
    "fp32": "model.onnx",
    "fp16": "model_fp16.onnx",
    "q8":   "model_quantized.onnx",
}

# Files we always want in each model dir if the upstream repo has them.
# `vocab.txt` / `special_tokens_map.json` aren't always present (e.g.
# BPE-tokenizer models skip vocab.txt); we treat the whole list as
# best-effort.
TOKENIZER_FILES = [
    "config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "vocab.txt",
    "special_tokens_map.json",
]


def run(cmd: list[str], cwd: Path | None = None) -> None:
    print(f"$ {' '.join(cmd)}")
    subprocess.check_call(cmd, cwd=cwd)


def clean() -> None:
    if BUILD.exists():
        shutil.rmtree(BUILD)
    BUILD.mkdir(parents=True)


def export_tmp(m: Model) -> Path:
    """Per-model scratch dir for optimum's export (avoids collisions)."""
    return EXPORT_ROOT / m.key


def model_deploy_dir(m: Model) -> Path:
    """Where the model's transformers.js layout lands in the deploy tree."""
    return DEPLOY / m.model_id


def source_dtype(m: Model) -> str:
    """The upstream checkpoint's stored dtype, normalized to a short str."""
    config = AutoConfig.from_pretrained(m.model_id)
    # transformers 5.x stores this under `dtype`; older 4.x under
    # `torch_dtype`. The field may be a torch.dtype object or a string;
    # str() handles both.
    raw = getattr(config, "dtype", None) or getattr(config, "torch_dtype", None)
    return str(raw).lower().replace("torch.", "")


def pick_export_dtype(m: Model) -> str:
    """Choose the export dtype for a model.

    Honors `m.dtype_override`; otherwise applies the never-upscale policy:
    padding bf16 weights into fp32 just adds zero bits and doubles the
    wire size for nothing.
      - source fp32  -> fp32
      - source bf16  -> fp16 (same bit width; transformers.js + ORT-Web
                              have no usable bf16 loader path)
      - source fp16  -> fp16
      - unknown      -> fp32 (safe fallback; warns)
    """
    if m.dtype_override is not None:
        return m.dtype_override
    norm = source_dtype(m)
    if norm in {"bfloat16", "bf16", "float16", "fp16", "half"}:
        return "fp16"
    if norm in {"float32", "fp32", "float"}:
        return "fp32"
    print(f"   warning: unknown source dtype {norm!r} for {m.model_id}, defaulting to fp32")
    return "fp32"


def export_onnx(m: Model) -> None:
    """optimum.exporters.onnx — converts the safetensors checkpoint to ONNX.

    Optimum drives transformers' export pipeline. The output directory
    gets `model.onnx` + `config.json`. For models saved with newer
    transformers (5.0), tokenizer copying may be skipped silently
    because optimum tries to load tokenizers via `AutoTokenizer` and
    fails for not-yet-recognized tokenizer_class names — we fetch
    those separately via `fetch_hf_file`.

    We always export at fp32 here. optimum-cli's `--dtype fp16` is a
    GPU-only path; on CPU torch it's a no-op (leaves every initializer
    as float32). The actual fp16/q8 conversion happens in
    `downcast_to_fp16` / `quantize_to_q8` below.
    """
    tmp = export_tmp(m)
    tmp.mkdir(parents=True, exist_ok=True)
    run([
        sys.executable, "-m", "optimum.exporters.onnx",
        "--model", m.model_id,
        "--task", m.task,
        "--opset", OPSET,
        str(tmp),
    ])


def downcast_to_fp16(src: Path, dst: Path) -> None:
    """Convert an fp32 ONNX file to fp16 via onnxconverter-common.

    Uses `keep_io_types=True` so the model's input/output tensors stay
    fp32 — this lets the caller feed regular fp32 input_ids/attention
    masks without manual casting, while the heavy weight tensors are
    halved.
    """
    import onnx  # local import — keeps cold-start cheap when fp32 path
    from onnxconverter_common.float16 import convert_float_to_float16

    model = onnx.load(str(src))
    converted = convert_float_to_float16(model, keep_io_types=True)
    onnx.save(converted, str(dst))


def quantize_to_q8(src: Path, dst: Path, default_float: bool = False) -> None:
    """Dynamic int8 quantization of MatMul/Gemm weights.

    Uses onnxruntime's `quantize_dynamic` — only quantizes ops that
    have int8 kernels in ORT's WASM backend; everything else stays
    fp32. Weights ~4x smaller than fp32. transformers.js loads this as
    `dtype: 'q8'` from `<model_id>/onnx/model_quantized.onnx`.

    `weight_type=QUInt8` matches what the Xenova / onnx-community
    ecosystem produces — ORT-Web's WASM int8 GEMM kernels are tuned
    for the unsigned variant, so it tends to be the fastest path.

    `default_float=True` is needed ONLY when quantizing a graph that has
    already been through BERT operator fusion (the `q8 + fused` bench
    variant): its `com.microsoft` contrib ops have output types the
    quantizer's shape inference can't resolve, which otherwise aborts with
    "Unable to find data type for weight_name=...". Passing
    `DefaultTensorType=FLOAT` is the documented remedy. The clean unfused
    export (the production path) needs no such fallback, so its bytes are
    unchanged.
    """
    from onnxruntime.quantization import quantize_dynamic, QuantType

    extra_options = None
    if default_float:
        import onnx

        extra_options = {"DefaultTensorType": onnx.TensorProto.FLOAT}

    quantize_dynamic(
        model_input=str(src),
        model_output=str(dst),
        weight_type=QuantType.QUInt8,
        extra_options=extra_options,
    )


def optimize_bert(src: Path, dst: Path) -> None:
    """Offline BERT operator fusion via onnxruntime's transformer optimizer.

    Fuses the many small ops a BERT encoder exports into a handful of fused
    `com.microsoft` kernels (Attention, SkipLayerNormalization, (Fast)Gelu,
    EmbedLayerNormalization) that ORT-Web's full wasm build ships dedicated
    implementations for. Fewer kernel dispatches + better cache behavior is a
    genuine SINGLE-THREAD speedup, and it's pure offline graph rewriting — no
    wasm rebuild. `num_heads=0, hidden_size=0` lets the optimizer infer the
    BERT shape from the graph (robust across bge-small/-base).
    """
    from onnxruntime.transformers.optimizer import optimize_model

    optimized = optimize_model(
        str(src),
        model_type="bert",
        num_heads=0,
        hidden_size=0,
    )
    optimized.save_model_to_file(str(dst))


# (label, transform) for each embeddings bench variant. `transform` rewrites the
# fp32 export at `src` into the variant file at `dst`. `dtype` is what
# transformers.js / the sync bench would call it; `fused` records whether the
# offline BERT fusion ran (so the test report reads cleanly).
EMBED_BENCH_VARIANTS = [
    ("fp32", "model.onnx", "fp32", False),
    ("fp32 + fused", "model_opt.onnx", "fp32", True),
    ("q8 (prod)", "model_quantized.onnx", "q8", False),
    ("q8 + fused", "model_opt_quantized.onnx", "q8", True),
]


def emit_embed_bench_variants(m: Model) -> list[dict]:
    """Write the single-thread bench variants for the embeddings model.

    All land in the model's existing `onnx/` dir under distinct filenames (so
    the production `model_quantized.onnx` is untouched and still loads). Returns
    the manifest `bench_variants` list the worker/test reads to enumerate them.
    Only called when EMBED_BENCH=1.
    """
    tmp = export_tmp(m)
    src_onnx = tmp / "model.onnx"
    if not src_onnx.exists():
        raise RuntimeError(f"optimum did not produce {src_onnx}")
    onnx_dir = model_deploy_dir(m) / "onnx"
    onnx_dir.mkdir(parents=True, exist_ok=True)

    # Build the fp32-fused graph once; quantize variants derive from the
    # matching fp32 file (fused→fused, unfused→unfused) so the only difference
    # a pair isolates is the lever under test.
    fused_fp32 = tmp / "model_opt.onnx"
    print(f"-- [bench] fusing {m.model_id} -> {fused_fp32.name}")
    optimize_bert(src_onnx, fused_fp32)

    fp32_sources = {False: src_onnx, True: fused_fp32}
    variants: list[dict] = []
    for label, fname, dtype, fused in EMBED_BENCH_VARIANTS:
        dst = onnx_dir / fname
        base = fp32_sources[fused]
        if dtype == "fp32":
            shutil.copy2(base, dst)
        elif dtype == "q8":
            print(f"-- [bench] quantizing {base.name} -> int8 -> {dst.name}")
            # Fused graphs need the DefaultTensorType fallback (contrib ops);
            # the unfused export quantizes cleanly without it.
            quantize_to_q8(base, dst, default_float=fused)
        else:
            raise RuntimeError(f"unhandled bench dtype {dtype!r}")
        variants.append(
            {
                "label": label,
                "dtype": dtype,
                "fused": fused,
                "model_file": f"onnx/{fname}",
            }
        )
    return variants


def fetch_hf_file(model_id: str, filename: str, dst: Path, required: bool) -> bool:
    """Download `<model_id>/resolve/main/<filename>` from HF Hub.

    Returns True if the file was fetched, False if it 404'd and was
    marked optional. Raises if a required file is missing.
    """
    url = f"https://huggingface.co/{model_id}/resolve/main/{filename}"
    try:
        with urllib.request.urlopen(url) as r:
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_bytes(r.read())
        return True
    except urllib.error.HTTPError as exc:
        if exc.code == 404 and not required:
            print(f"   (optional, 404: {filename})")
            return False
        raise


def assemble_model_dir(m: Model, dtype: str) -> None:
    """Place ONNX + config + tokenizer files in the transformers.js layout.

    For fp32 output we copy optimum's `model.onnx` straight in. For
    fp16/q8 we convert it. Final filename matches the transformers.js
    DTYPE_SUFFIX_MAPPING (`model.onnx` / `model_fp16.onnx` /
    `model_quantized.onnx`) so the worker can read `dtype` from the
    manifest and pass it straight to `pipeline(..., { dtype })`.
    """
    tmp = export_tmp(m)
    deploy = model_deploy_dir(m)
    deploy.mkdir(parents=True, exist_ok=True)
    onnx_dir = deploy / "onnx"
    onnx_dir.mkdir(exist_ok=True)

    src_onnx = tmp / "model.onnx"
    if not src_onnx.exists():
        raise RuntimeError(f"optimum did not produce {src_onnx}")
    dst = onnx_dir / DTYPE_ONNX_NAME[dtype]
    if dtype == "fp16":
        print(f"-- downcasting {m.model_id} {src_onnx.name} fp32 -> fp16 -> {dst.name}")
        downcast_to_fp16(src_onnx, dst)
    elif dtype == "q8":
        print(f"-- quantizing {m.model_id} {src_onnx.name} fp32 -> int8 (QUInt8) -> {dst.name}")
        quantize_to_q8(src_onnx, dst)
    else:
        shutil.copy2(src_onnx, dst)

    # config.json comes from optimum (it may inject task-specific bits).
    src_config = tmp / "config.json"
    if src_config.exists():
        shutil.copy2(src_config, deploy / "config.json")
    else:
        fetch_hf_file(m.model_id, "config.json", deploy / "config.json", required=True)

    # Tokenizer files: try optimum's export dir first (it sometimes
    # copies them), then HF over HTTP. config.json is handled above so
    # we skip it here.
    for name in TOKENIZER_FILES:
        if name == "config.json":
            continue
        dst = deploy / name
        src = tmp / name
        if src.exists():
            shutil.copy2(src, dst)
            continue
        # tokenizer.json + tokenizer_config.json are required for
        # transformers.js to construct a tokenizer; the others are
        # best-effort (BPE-only tokenizers, for instance, ship no
        # vocab.txt).
        required = name in {"tokenizer.json", "tokenizer_config.json"}
        fetch_hf_file(m.model_id, name, dst, required=required)


def copy_ort_to_deploy() -> None:
    """Mirror onnxruntime-web's runtime wasm into <deploy>/ort/.

    transformers.js delegates inference to onnxruntime-web, which loads
    `ort-wasm-simd-threaded.{wasm,mjs}` (and JSEP/JSPI/asyncify variants)
    at runtime from `env.backends.onnx.wasm.wasmPaths`. Pointing that at
    our <deploy>/ort/ keeps everything same-origin. All models share this
    one onnxruntime-web build, so it's copied once after the loop — and
    its presence is the build-completion sentinel CMake keys off.
    """
    ort_dist = REPO_ROOT / "node_modules" / "onnxruntime-web" / "dist"
    if not ort_dist.exists():
        candidates = list(
            (REPO_ROOT / "node_modules" / ".pnpm").glob(
                "onnxruntime-web@*/node_modules/onnxruntime-web/dist"
            )
        )
        if not candidates:
            raise RuntimeError(
                "onnxruntime-web not installed in node_modules — run `pnpm install` at the repo root"
            )
        ort_dist = candidates[0]
    dst = DEPLOY / "ort"
    dst.mkdir(parents=True, exist_ok=True)
    for src in sorted(ort_dist.glob("ort-wasm-simd-threaded.*")):
        shutil.copy2(src, dst / src.name)


def report_sizes() -> None:
    print("\n-- sizes --")
    total = 0
    for path in sorted(DEPLOY.rglob("*")):
        if not path.is_file():
            continue
        size = path.stat().st_size
        total += size
        rel = path.relative_to(DEPLOY)
        print(f"  {size/1024:>9.0f} KiB  {rel}")
    print(f"  {'-'*60}")
    print(f"  {total/1024:>9.0f} KiB  TOTAL")


def manifest_entry(m: Model, dtype: str) -> dict:
    return {
        "model_id": m.model_id,
        "source_url": f"https://huggingface.co/{m.model_id}",
        "task": m.task,
        "dtype": dtype,
        "source_dtype": source_dtype(m),
        "opset": int(OPSET),
        "model_file": f"onnx/{DTYPE_ONNX_NAME[dtype]}",
    }


def write_manifest(entries: dict[str, dict]) -> None:
    """Write <deploy>/manifest.json — the single source of truth about
    what was built. The browser worker reads this on boot to find each
    model's model_id + dtype + task; the pages render model_id as a link
    to source_url. Keeping it in the deploy/ tree means editing MODELS in
    this file is the only edit needed to ship a different model — no
    TS/TSX changes required.
    """
    manifest = {"schema": MANIFEST_SCHEMA, "models": entries}
    DEPLOY.mkdir(parents=True, exist_ok=True)
    (DEPLOY / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")


def main() -> None:
    clean()
    entries: dict[str, dict] = {}
    for m in MODELS:
        auto = pick_export_dtype(m)
        if m.dtype_override is None:
            print(f"-- {m.key}: export dtype {auto} (auto) [{m.model_id}]")
        else:
            print(f"-- {m.key}: export dtype {auto} (forced) [{m.model_id}]")
        export_onnx(m)
        assemble_model_dir(m, auto)
        entry = manifest_entry(m, auto)
        # Single-thread CPU bench variants (opt-in): emit fp32 / fused / q8
        # alternatives of the embeddings model next to the production file.
        if EMBED_BENCH and m.key == "embeddings":
            entry["bench_variants"] = emit_embed_bench_variants(m)
        entries[m.key] = entry
    copy_ort_to_deploy()
    write_manifest(entries)
    report_sizes()


if __name__ == "__main__":
    main()
