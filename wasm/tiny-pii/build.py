"""Build a transformers.js-loadable bundle for a HF token-classification model.

What it does:
  1. Downloads MODEL_ID from HF and exports it to ONNX (token-classification
     head) via `optimum.exporters.onnx`.
  2. Fetches the tokenizer artifacts directly from HF over HTTP (we can't
     rely on optimum to copy them — for models saved with transformers
     5.0's `TokenizersBackend` placeholder, the venv's AutoTokenizer
     can't load them and optimum quietly skips them. transformers.js
     handles `TokenizersBackend` natively, so the raw files are fine).
  3. Lays out the files in the layout transformers.js expects:
        <repo>/config.json
        <repo>/tokenizer.json
        <repo>/tokenizer_config.json
        <repo>/onnx/model.onnx
  4. Mirrors onnxruntime-web's runtime wasm into deploy/ort/ so the worker
     can pin `env.backends.onnx.wasm.wasmPaths` to a same-origin path
     (and stay offline).

Run with: python3 build.py
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

from transformers import AutoConfig

ROOT = Path(__file__).resolve().parent
REPO_ROOT = ROOT.parent.parent
BUILD = ROOT / "build"
DEPLOY = BUILD / "deploy"
EXPORT_TMP = BUILD / "export"

# The model to export. Override by editing this constant — the rest of
# the pipeline is model-agnostic as long as the architecture is one
# transformers.js supports.
MODEL_ID = "gravitee-io/bert-small-pii-detection"

# ONNX opset. ModernBERT recommends >= 18; classic BERT is fine at 14.
# 18 works for both, so we default to it.
OPSET = "18"

# Override the auto-detected dtype. Set to "fp32" or "fp16" to force; leave
# None to use the never-upscale policy (see pick_export_dtype). Useful when
# runtime considerations win over precision policy — e.g. ModernBERT in
# onnxruntime-web's WASM backend can be slower at fp16 than fp32 because
# of cast-shuffling around ops without native fp16 kernels.
EXPORT_DTYPE_OVERRIDE: str | None = None

# Filename suffix transformers.js expects under <repo>/onnx/ for each
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

# transformers.js fetches <localModelPath>/<MODEL_ID>/... — we mirror the
# org/name structure under deploy/ so a single base URL works.
MODEL_DEPLOY = DEPLOY / MODEL_ID

# Files we always want in the deploy tree if the upstream repo has them.
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


def pick_export_dtype() -> str:
    """Inspect the upstream checkpoint and choose --dtype for the export.

    Reads `config.json` via `transformers.AutoConfig` — which uses HF's
    shared cache, so optimum-cli's later download reuses the same
    artifact (no double fetch).

    Policy: never upscale precision. Padding bf16 weights into fp32
    just adds zero bits and doubles the wire size for nothing.
      - source fp32  -> fp32
      - source bf16  -> fp16 (same bit width; transformers.js + ORT-Web
                              have no usable bf16 loader path)
      - source fp16  -> fp16
      - unknown      -> fp32 (safe fallback; warns)
    """
    config = AutoConfig.from_pretrained(MODEL_ID)
    # transformers 5.x stores this under `dtype`; older 4.x under
    # `torch_dtype`. The field may be a torch.dtype object or a string;
    # str() handles both.
    raw = getattr(config, "dtype", None) or getattr(config, "torch_dtype", None)
    norm = str(raw).lower().replace("torch.", "")
    if norm in {"bfloat16", "bf16", "float16", "fp16", "half"}:
        return "fp16"
    if norm in {"float32", "fp32", "float"}:
        return "fp32"
    print(f"   warning: unknown source dtype {raw!r}, defaulting to fp32")
    return "fp32"


def export_onnx() -> None:
    """optimum.exporters.onnx — converts the safetensors checkpoint to ONNX.

    Optimum drives transformers' export pipeline. The output directory
    gets `model.onnx` + `config.json`. For models saved with newer
    transformers (5.0), tokenizer copying may be skipped silently
    because optimum tries to load tokenizers via `AutoTokenizer` and
    fails for not-yet-recognized tokenizer_class names — we fetch
    those separately via `fetch_hf_file`.

    We always export at fp32 here. optimum-cli's `--dtype fp16` is a
    GPU-only path; on CPU torch it's a no-op (leaves every initializer
    as float32). The actual fp16 conversion happens in
    `downcast_to_fp16` via onnxconverter-common, which rewrites all
    float initializers + the ops that consume them.
    """
    EXPORT_TMP.mkdir(parents=True, exist_ok=True)
    run([
        sys.executable, "-m", "optimum.exporters.onnx",
        "--model", MODEL_ID,
        "--task", "token-classification",
        "--opset", OPSET,
        str(EXPORT_TMP),
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


def quantize_to_q8(src: Path, dst: Path) -> None:
    """Dynamic int8 quantization of MatMul/Gemm weights.

    Uses onnxruntime's `quantize_dynamic` — only quantizes ops that
    have int8 kernels in ORT's WASM backend; everything else stays
    fp32. Weights ~4x smaller than fp32. transformers.js loads this as
    `dtype: 'q8'` from `<repo>/onnx/model_quantized.onnx`.

    `weight_type=QUInt8` matches what the Xenova / onnx-community
    ecosystem produces — ORT-Web's WASM int8 GEMM kernels are tuned
    for the unsigned variant, so it tends to be the fastest path.
    """
    from onnxruntime.quantization import quantize_dynamic, QuantType

    quantize_dynamic(
        model_input=str(src),
        model_output=str(dst),
        weight_type=QuantType.QUInt8,
    )


def fetch_hf_file(filename: str, dst: Path, required: bool) -> bool:
    """Download `<MODEL_ID>/resolve/main/<filename>` from HF Hub.

    Returns True if the file was fetched, False if it 404'd and was
    marked optional. Raises if a required file is missing.
    """
    url = f"https://huggingface.co/{MODEL_ID}/resolve/main/{filename}"
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


def assemble_model_dir(dtype: str) -> None:
    """Place ONNX + config + tokenizer files in the transformers.js layout.

    For fp32 output we copy optimum's `model.onnx` straight in. For
    fp16 we downcast in-place — fp32 source is what optimum produces
    regardless of --dtype on CPU. Final filename matches the
    transformers.js DTYPE_SUFFIX_MAPPING (`model.onnx` /
    `model_fp16.onnx`) so the worker can read `dtype` from the
    manifest and pass it straight to `pipeline(..., { dtype })`.
    """
    MODEL_DEPLOY.mkdir(parents=True, exist_ok=True)
    onnx_dir = MODEL_DEPLOY / "onnx"
    onnx_dir.mkdir(exist_ok=True)

    src_onnx = EXPORT_TMP / "model.onnx"
    if not src_onnx.exists():
        raise RuntimeError(f"optimum did not produce {src_onnx}")
    dst = onnx_dir / DTYPE_ONNX_NAME[dtype]
    if dtype == "fp16":
        print(f"-- downcasting {src_onnx.name} fp32 -> fp16 -> {dst.name}")
        downcast_to_fp16(src_onnx, dst)
    elif dtype == "q8":
        print(f"-- quantizing {src_onnx.name} fp32 -> int8 (QUInt8) -> {dst.name}")
        quantize_to_q8(src_onnx, dst)
    else:
        shutil.copy2(src_onnx, dst)

    # config.json comes from optimum (it may inject task-specific bits).
    src_config = EXPORT_TMP / "config.json"
    if src_config.exists():
        shutil.copy2(src_config, MODEL_DEPLOY / "config.json")
    else:
        fetch_hf_file("config.json", MODEL_DEPLOY /
                      "config.json", required=True)

    # Tokenizer files: try optimum's export dir first (it sometimes
    # copies them), then HF over HTTP. config.json is handled above so
    # we skip it here.
    for name in TOKENIZER_FILES:
        if name == "config.json":
            continue
        dst = MODEL_DEPLOY / name
        src = EXPORT_TMP / name
        if src.exists():
            shutil.copy2(src, dst)
            continue
        # tokenizer.json + tokenizer_config.json are required for
        # transformers.js to construct a tokenizer; the others are
        # best-effort (BPE-only tokenizers, for instance, ship no
        # vocab.txt).
        required = name in {"tokenizer.json", "tokenizer_config.json"}
        fetch_hf_file(name, dst, required=required)


def copy_ort_to_deploy() -> None:
    """Mirror onnxruntime-web's runtime wasm into deploy/ort/.

    transformers.js delegates inference to onnxruntime-web, which loads
    `ort-wasm-simd-threaded.{wasm,mjs}` (and JSEP/JSPI/asyncify variants)
    at runtime from `env.backends.onnx.wasm.wasmPaths`. Pointing that at
    our deploy/ort/ keeps everything same-origin.
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


def write_manifest(dtype: str) -> None:
    """Write deploy/manifest.json — the single source of truth about
    what was built. The browser worker reads this on boot to find the
    model_id + dtype; the page renders model_id as a link to source_url
    in its header. Keeping it in the deploy/ tree means swapping
    MODEL_ID in this file is the only edit needed to ship a different
    model — no TS/TSX changes required.
    """
    config = AutoConfig.from_pretrained(MODEL_ID)
    source_dtype = str(
        getattr(config, "dtype", None) or getattr(config, "torch_dtype", None)
    ).replace("torch.", "")
    manifest = {
        "model_id": MODEL_ID,
        "source_url": f"https://huggingface.co/{MODEL_ID}",
        "task": "token-classification",
        "dtype": dtype,
        "source_dtype": source_dtype,
        "opset": int(OPSET),
        "model_file": f"onnx/{DTYPE_ONNX_NAME[dtype]}",
    }
    DEPLOY.mkdir(parents=True, exist_ok=True)
    (DEPLOY / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")


def main() -> None:
    clean()
    auto = pick_export_dtype()
    if EXPORT_DTYPE_OVERRIDE is None:
        dtype = auto
        print(f"-- export dtype: {dtype} (auto)")
    else:
        dtype = EXPORT_DTYPE_OVERRIDE
        print(f"-- export dtype: {dtype} (forced; auto would have picked {auto})")
    export_onnx()
    assemble_model_dir(dtype)
    copy_ort_to_deploy()
    write_manifest(dtype)
    report_sizes()


if __name__ == "__main__":
    main()
