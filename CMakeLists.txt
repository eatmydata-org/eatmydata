cmake_minimum_required(VERSION 3.20)

project(analyst_wasm LANGUAGES NONE)

include(ExternalProject)

# wasi-sdk pin. The release TAG is `wasi-sdk-<N>`; the asset files are versioned
# `wasi-sdk-<N>.0-<arch>-<os>.tar.gz`. Bump both via these two vars.
set(WASI_SDK_RELEASE wasi-sdk-33)
set(WASI_SDK_FILE_VER 33.0)

if(CMAKE_HOST_SYSTEM_NAME STREQUAL "Darwin")
    if(CMAKE_HOST_SYSTEM_PROCESSOR STREQUAL "arm64")
        set(WASI_SDK_URL https://github.com/WebAssembly/wasi-sdk/releases/download/${WASI_SDK_RELEASE}/wasi-sdk-${WASI_SDK_FILE_VER}-arm64-macos.tar.gz)
    else()
        set(WASI_SDK_URL https://github.com/WebAssembly/wasi-sdk/releases/download/${WASI_SDK_RELEASE}/wasi-sdk-${WASI_SDK_FILE_VER}-x86_64-macos.tar.gz)
    endif()
elseif(CMAKE_HOST_SYSTEM_NAME STREQUAL "Linux")
    if(CMAKE_HOST_SYSTEM_PROCESSOR STREQUAL "aarch64")
        set(WASI_SDK_URL https://github.com/WebAssembly/wasi-sdk/releases/download/${WASI_SDK_RELEASE}/wasi-sdk-${WASI_SDK_FILE_VER}-arm64-linux.tar.gz)
    else()
        set(WASI_SDK_URL https://github.com/WebAssembly/wasi-sdk/releases/download/${WASI_SDK_RELEASE}/wasi-sdk-${WASI_SDK_FILE_VER}-x86_64-linux.tar.gz)
    endif()
else()
    message(FATAL_ERROR "Unsupported host system: ${CMAKE_HOST_SYSTEM_NAME}")
endif()

# wasi-sdk publishes no convenient per-file MD5; rely on HTTPS from the GitHub
# release. Set WASI_SDK_MD5 to a real digest to re-enable the integrity check.
set(WASI_SDK_MD5 "")

if(WASI_SDK_MD5)
    set(WASI_SDK_URL_HASH URL_HASH MD5=${WASI_SDK_MD5})
else()
    set(WASI_SDK_URL_HASH "")
endif()

ExternalProject_Add(
    wasi-sdk
    PREFIX ${CMAKE_BINARY_DIR}/wasi-sdk-prefix
    DOWNLOAD_DIR ${CMAKE_BINARY_DIR}/deps
    URL ${WASI_SDK_URL}
    ${WASI_SDK_URL_HASH}
    DOWNLOAD_EXTRACT_TIMESTAMP true
    CONFIGURE_COMMAND ""
    BUILD_COMMAND ""
    INSTALL_COMMAND ""
)

set(WASI_SDK_ROOT ${CMAKE_BINARY_DIR}/wasi-sdk-prefix/src/wasi-sdk)
set(WASI_CLANG ${WASI_SDK_ROOT}/bin/clang)
set(WASI_SYSROOT ${WASI_SDK_ROOT}/share/wasi-sysroot)

set(QJS_DIR ${CMAKE_SOURCE_DIR}/contrib/quickjs)

# qjs-wasi-reactor.c already #includes qjs.c so we do NOT list qjs.c here.
# gen/repl.c and gen/standalone.c carry pre-compiled qjsc bytecode that
# qjs.c references via extern symbols.
set(QJS_SOURCES
    ${QJS_DIR}/dtoa.c
    ${QJS_DIR}/libregexp.c
    ${QJS_DIR}/libunicode.c
    ${QJS_DIR}/quickjs.c
    ${QJS_DIR}/quickjs-libc.c
    ${QJS_DIR}/qjs-wasi-reactor.c
    ${QJS_DIR}/gen/repl.c
    ${QJS_DIR}/gen/standalone.c
    ${CMAKE_SOURCE_DIR}/wasm/wrapper.c
)

set(QJS_WASM_OUT ${CMAKE_SOURCE_DIR}/src/assets/wasm/qjs.wasm)

add_custom_command(
    OUTPUT ${QJS_WASM_OUT}
    # The output tree (src/assets/wasm/) is gitignored, so a fresh clone or a
    # clean Docker build context won't have it — wasm-ld won't create the parent
    # dir itself. Make it first.
    COMMAND ${CMAKE_COMMAND} -E make_directory ${CMAKE_SOURCE_DIR}/src/assets/wasm
    COMMAND ${WASI_CLANG}
        --sysroot=${WASI_SYSROOT}
        --target=wasm32-wasip1
        -O2
        -mexec-model=reactor
        -D_GNU_SOURCE
        -DQUICKJS_NG_BUILD
        -D_WASI_EMULATED_PROCESS_CLOCKS
        -D_WASI_EMULATED_SIGNAL
        -I${QJS_DIR}
        ${QJS_SOURCES}
        -lwasi-emulated-process-clocks
        -lwasi-emulated-signal
        -Wl,--export-dynamic
        -Wl,--export=malloc
        -Wl,--export=free
        -Wl,--export=realloc
        -Wl,--export=calloc
        -o ${QJS_WASM_OUT}
    DEPENDS ${QJS_SOURCES}
    COMMENT "Building qjs.wasm via wasi-sdk"
    VERBATIM
)

add_custom_target(qjs-wasm ALL DEPENDS ${QJS_WASM_OUT})
add_dependencies(qjs-wasm wasi-sdk)

# ---------------------------------------------------------------------------
# wa-sqlite: rhashimoto/wa-sqlite v1.1.1 compiled from source via wasi-sdk
# instead of Emscripten. Produces wa-sqlite.wasm + companion runtime
# in src/lib/wa-sqlite/runtime.ts.
#
# Why our own build:
#   * Upstream prebuilt wa-sqlite.wasm omits _sqlite3_column_decltype from
#     EXPORTED_FUNCTIONS; we need it to give the planner real column types.
#   * Upstream also builds with -DSQLITE_OMIT_DECLTYPE; we drop that here.
#   * Avoids pulling Emscripten into the toolchain — wasi-sdk is already
#     downloaded for qjs-wasm above.
#
# Inputs:
#   * contrib/wa-sqlite/src/lib*.c + main.c (patched in-place at build time;
#     patch is idempotent and only strips emscripten.h / replaces
#     EMSCRIPTEN_KEEPALIVE with __attribute__((used,visibility("default")))).
#   * SQLite amalgamation (sqlite3.c + sqlite3.h) downloaded from sqlite.org.
#   * contrib/wa-sqlite/src/exported_functions.json — turned into a list of
#     -Wl,--export=<name> flags so the JS runtime can find every symbol the
#     committed sqlite-api.js / lib*.js layer references.
# ---------------------------------------------------------------------------

set(WASQL_DIR ${CMAKE_SOURCE_DIR}/contrib/wa-sqlite)
set(WASQL_PATCH ${CMAKE_SOURCE_DIR}/wasm/wa-sqlite/patches/0001-wasi-sdk-build.patch)
set(WASQL_WASM_OUT ${CMAKE_SOURCE_DIR}/src/assets/wasm/wa-sqlite.wasm)

# SQLite amalgamation. URL pattern is www.sqlite.org/YYYY/sqlite-amalgamation-<MMmmpppp>.zip
# where MMmmpppp is the version (3.53.1 = 3530100). Keep this loosely in
# sync with upstream wa-sqlite v1.1.1's SQLITE_VERSION = version-3.53.0 —
# the amalgamation includes a couple of post-3.53.0 fixes which is fine.
set(SQLITE_AMALGAMATION_URL https://www.sqlite.org/2026/sqlite-amalgamation-3530100.zip)
set(SQLITE_AMALGAMATION_DIR ${CMAKE_BINARY_DIR}/sqlite-amalgamation)

ExternalProject_Add(
    sqlite-amalgamation
    PREFIX ${CMAKE_BINARY_DIR}/sqlite-amalgamation-prefix
    DOWNLOAD_DIR ${CMAKE_BINARY_DIR}/deps
    URL ${SQLITE_AMALGAMATION_URL}
    DOWNLOAD_EXTRACT_TIMESTAMP true
    SOURCE_DIR ${SQLITE_AMALGAMATION_DIR}
    CONFIGURE_COMMAND ""
    BUILD_COMMAND ""
    INSTALL_COMMAND ""
)

# Read EXPORTED_FUNCTIONS list, strip leading underscore, build the
# -Wl,--export=<name> linker flag list. The leading underscore is an
# Emscripten convention; wasm-ld exports symbols by their plain C name.
file(READ ${WASQL_DIR}/src/exported_functions.json WASQL_EXPORTED_FUNCTIONS_JSON)
string(JSON WASQL_EXPORTED_FUNCTIONS_LEN LENGTH ${WASQL_EXPORTED_FUNCTIONS_JSON})
math(EXPR WASQL_EXPORTED_FUNCTIONS_LAST "${WASQL_EXPORTED_FUNCTIONS_LEN} - 1")
set(WASQL_EXPORT_FLAGS "")
foreach(idx RANGE 0 ${WASQL_EXPORTED_FUNCTIONS_LAST})
    string(JSON name GET ${WASQL_EXPORTED_FUNCTIONS_JSON} ${idx})
    string(REGEX REPLACE "^_" "" name "${name}")
    list(APPEND WASQL_EXPORT_FLAGS "-Wl,--export=${name}")
endforeach()
# Extras the JSON doesn't list: decltype (the whole point of this rebuild),
# the column-metadata accessors (origin/table name — gated on
# SQLITE_ENABLE_COLUMN_METADATA below; used by the obfuscation engine to tell
# expression columns apart from raw base-table columns), the
# libvfs/libfunction/libhook/libprogress/libauthorizer C entry points that the
# post-js wrappers ccall into, the getSqliteFree helper from main.c, and our
# analyst_wa_init shim.
list(APPEND WASQL_EXPORT_FLAGS
    -Wl,--export=sqlite3_column_decltype
    -Wl,--export=sqlite3_column_decltype16
    -Wl,--export=sqlite3_column_origin_name
    -Wl,--export=sqlite3_column_table_name
    -Wl,--export=libvfs_vfs_register
    -Wl,--export=libfunction_create_function
    -Wl,--export=libauthorizer_set_authorizer
    -Wl,--export=libhook_commit_hook
    -Wl,--export=libhook_update_hook
    -Wl,--export=libprogress_progress_handler
    -Wl,--export=getSqliteFree
    -Wl,--export=analyst_wa_init
)

set(WASQL_SOURCES
    ${SQLITE_AMALGAMATION_DIR}/sqlite3.c
    ${WASQL_DIR}/src/main.c
    ${WASQL_DIR}/src/libvfs.c
    ${WASQL_DIR}/src/libfunction.c
    ${WASQL_DIR}/src/libauthorizer.c
    ${WASQL_DIR}/src/libhook.c
    ${WASQL_DIR}/src/libprogress.c
    ${CMAKE_SOURCE_DIR}/wasm/wa-sqlite/src/runtime_shim.c
)

# rh vector-search extension — clean-room, scalar-only, compiled straight into
# wa-sqlite.wasm and registered via sqlite3_auto_extension() in runtime_shim.c.
# TurboQuant quantizer follows arXiv:2504.19874. Sources are appended here as
# the phased build lands them (see wasm/sqlite-vector/src).
set(RH_VECTOR_DIR ${CMAKE_SOURCE_DIR}/wasm/sqlite-vector/src)
set(RH_VECTOR_SOURCES
    ${RH_VECTOR_DIR}/vector.c
    ${RH_VECTOR_DIR}/vec-types.c
    ${RH_VECTOR_DIR}/vec-distance.c
    ${RH_VECTOR_DIR}/vec-config.c
    ${RH_VECTOR_DIR}/vec-quantize.c
    ${RH_VECTOR_DIR}/vec-scan.c
)

# extension-functions.c is referenced by sqlite-api.js via
# `Module.ccall('RegisterExtensionFunctions', ...)` on every open_v2. It
# lives in the SQLite contrib download; we mirror the upstream wa-sqlite
# Makefile's grab.
set(WASQL_EXTFN_C ${CMAKE_BINARY_DIR}/sqlite-extras/extension-functions.c)
add_custom_command(
    OUTPUT ${WASQL_EXTFN_C}
    COMMAND ${CMAKE_COMMAND} -E make_directory ${CMAKE_BINARY_DIR}/sqlite-extras
    COMMAND curl -LsS -o ${WASQL_EXTFN_C}
        "https://www.sqlite.org/contrib/download/extension-functions.c?get=25"
    COMMENT "Downloading sqlite extension-functions.c"
    VERBATIM
)

# Patch the wa-sqlite submodule sources in place — idempotent: skip the
# apply if it's already on disk or would conflict. Mirrors the
# patches/sheetjs-styles.patch pattern. The stamp file prevents CMake from
# re-running the apply on every build.
set(WASQL_PATCH_STAMP ${CMAKE_BINARY_DIR}/wa-sqlite-patch.stamp)
add_custom_command(
    OUTPUT ${WASQL_PATCH_STAMP}
    COMMAND ${CMAKE_COMMAND} -E echo "Applying wa-sqlite wasi-sdk patch (if not already applied)"
    COMMAND sh -c "cd '${WASQL_DIR}' && (git apply --reverse --check '${WASQL_PATCH}' 2>/dev/null && echo 'patch already applied') || git apply '${WASQL_PATCH}'"
    COMMAND ${CMAKE_COMMAND} -E touch ${WASQL_PATCH_STAMP}
    DEPENDS ${WASQL_PATCH}
    COMMENT "Patching contrib/wa-sqlite/src for wasi-sdk build"
    VERBATIM
)

set(WASQL_DEFINES
    -DSQLITE_DEFAULT_MEMSTATUS=0
    -DSQLITE_DEFAULT_WAL_SYNCHRONOUS=1
    -DSQLITE_DQS=0
    -DSQLITE_LIKE_DOESNT_MATCH_BLOBS
    -DSQLITE_MAX_EXPR_DEPTH=0
    -DSQLITE_OMIT_AUTOINIT
    -DSQLITE_OMIT_DEPRECATED
    -DSQLITE_OMIT_LOAD_EXTENSION
    -DSQLITE_OMIT_SHARED_CACHE
    -DSQLITE_THREADSAFE=0
    -DSQLITE_USE_ALLOCA
    -DSQLITE_ENABLE_BATCH_ATOMIC_WRITE
    -DSQLITE_EXPERIMENTAL_PRAGMA_20251114
    # NOTE: upstream wa-sqlite Makefile sets SQLITE_OMIT_DECLTYPE — we
    # deliberately drop it so sqlite3_column_decltype is compiled in.
    # Compiles in sqlite3_column_origin_name / _table_name / _database_name.
    # The obfuscation engine (sample-sanitizer.ts) uses origin_name to scope
    # its literal-passthrough to expression columns: a NULL origin means the
    # column is a computed expression (CASE/literal/aggregate/concat), so a
    # cell matching a SQL literal can be passed through; a non-NULL origin
    # means the column projects a raw base-table column and is always masked.
    -DSQLITE_ENABLE_COLUMN_METADATA
)

# ---------------------------------------------------------------------------
# Semantic engine sources (the clean-room C BERT engine; see the `semantic`
# target's comment further down). Defined HERE because the BGE embedder is now
# compiled straight into wa-sqlite.wasm: the C `vector_search` vtab calls
# `sem_embed` directly (via analyst_embed_query in runtime_shim.c) with NO JS
# embed hook. The SAME sources also build the standalone semantic.wasm below
# (still used for PII/NER + the /embeddings + /tests bench surfaces).
#
# They need their OWN tuned flags (-O3 -msimd128 -mrelaxed-simd for the GEMM
# microkernel) — distinct from wa-sqlite's size-first -Oz -flto — so compile
# them to objects here and fold the objects into the wa-sqlite link. The clang
# driver happily links a mix of group-A .c sources and these prebuilt .o files
# in one step (group A → LTO bitcode, semantic → native objects).
# ---------------------------------------------------------------------------
set(SEM_DIR ${CMAKE_SOURCE_DIR}/wasm/semantic/src)
set(SEM_WASM_OUT ${CMAKE_SOURCE_DIR}/src/assets/wasm/semantic.wasm)
set(SEM_SOURCES
    ${SEM_DIR}/gguf.c
    ${SEM_DIR}/unicode-data.c
    ${SEM_DIR}/tokenizer.c
    ${SEM_DIR}/model.c
    ${SEM_DIR}/semantic.c
)

set(SEM_OBJ_DIR ${CMAKE_BINARY_DIR}/wa-sqlite-sem-obj)
set(SEM_OBJECTS "")
foreach(_sem_src ${SEM_SOURCES})
    string(MAKE_C_IDENTIFIER ${_sem_src} _sem_obj_id)
    set(_sem_obj ${SEM_OBJ_DIR}/${_sem_obj_id}.o)
    add_custom_command(
        OUTPUT ${_sem_obj}
        COMMAND ${CMAKE_COMMAND} -E make_directory ${SEM_OBJ_DIR}
        COMMAND ${WASI_CLANG}
            --sysroot=${WASI_SYSROOT}
            --target=wasm32-wasip1
            -O3
            -msimd128
            -mrelaxed-simd
            # NB: -mexec-model=reactor is a LINK-time option (invalid with -c);
            # it lives on the wa-sqlite link command that consumes these objects.
            -I${SEM_DIR}
            -c ${_sem_src}
            -o ${_sem_obj}
        DEPENDS ${_sem_src}
        COMMENT "CC (semantic engine, -O3 SIMD+FMA) ${_sem_src}"
        VERBATIM
    )
    list(APPEND SEM_OBJECTS ${_sem_obj})
endforeach()

add_custom_command(
    OUTPUT ${WASQL_WASM_OUT}
    COMMAND ${CMAKE_COMMAND} -E make_directory ${CMAKE_SOURCE_DIR}/src/assets/wasm
    COMMAND ${WASI_CLANG}
        --sysroot=${WASI_SYSROOT}
        --target=wasm32-wasip1
        -Oz -flto
        -mexec-model=reactor
        -I${SQLITE_AMALGAMATION_DIR}
        -I${WASQL_DIR}/src
        -I${RH_VECTOR_DIR}
        -I${SEM_DIR}
        -Wno-non-literal-null-conversion
        # clang 22 (wasi-sdk-33) promotes the C99 K&R-removal diagnostics to hard
        # errors by default. Upstream wa-sqlite's libadapters.h DECLARE/J macros
        # declare dispatch trampolines with implicit-int return (and rely on
        # implicit function decls), so downgrade those two to non-fatal for the
        # vendored submodule sources.
        -Wno-implicit-int
        -Wno-implicit-function-declaration
        ${WASQL_DEFINES}
        ${WASQL_SOURCES}
        ${WASQL_EXTFN_C}
        ${RH_VECTOR_SOURCES}
        # Prebuilt semantic-engine objects (-O3 SIMD), linked in so vector_search
        # embeds queries with an in-module C call. -lm satisfies the engine's
        # sqrtf/expf/erff/tanhf.
        ${SEM_OBJECTS}
        -lm
        ${WASQL_EXPORT_FLAGS}
        -Wl,--export=malloc
        -Wl,--export=free
        -Wl,--export=__heap_base
        # Semantic engine ABI (used by semantic-embed.ts to load the GGUF +
        # drive the async index embedder; the query path calls sem_embed in C).
        -Wl,--export=sem_init
        -Wl,--export=sem_embed
        -Wl,--export=sem_dim
        -Wl,--export=sem_kind
        -Wl,--export=sem_num_labels
        -Wl,--export=sem_strerror
        -Wl,--initial-memory=16777216
        -Wl,--max-memory=2147483648
        -Wl,--stack-first
        # 1 MB stack (was 512 KB): the merged binary now also runs the BERT
        # encoder's attention/FFN, which wants the deeper stack the standalone
        # semantic target uses.
        -Wl,-z,stack-size=1048576
        # The libadapters dispatch functions (ipp, ippp, vppp, etc.) are
        # JS-side imports — they're declared `extern` in libadapters.h but
        # not defined in any .c. Tell wasm-ld these are imports, not
        # missing symbols.
        -Wl,--allow-undefined
        -o ${WASQL_WASM_OUT}
    DEPENDS
        ${WASQL_SOURCES}
        ${WASQL_EXTFN_C}
        ${RH_VECTOR_SOURCES}
        ${SEM_OBJECTS}
        ${WASQL_PATCH_STAMP}
        ${WASQL_PATCH}
        ${SQLITE_AMALGAMATION_DIR}/sqlite3.c
    COMMENT "Building wa-sqlite.wasm via wasi-sdk (sqlite3 + lib*.c + vector ext + semantic engine)"
    VERBATIM
)

add_custom_target(wa-sqlite ALL DEPENDS ${WASQL_WASM_OUT})
add_dependencies(wa-sqlite wasi-sdk sqlite-amalgamation)

# ---------------------------------------------------------------------------
# semantic: ONE self-contained, clean-room C BERT engine (no ggml, no ONNX),
# driving BOTH small BERT model families off a GGUF whose geometry it reads at
# RUNTIME — so one semantic.wasm serves both:
#   * EMBED      bge-small-en-v1.5 (12L/384): CLS-pool + L2 -> 384-d embedding.
#   * TOKEN_CLS  bert-small-pii    (4L/512) + classifier head: per-token NER
#                (argmax label id + score + char offsets).
# A GGUF carrying `classifier.weight` is TOKEN_CLS; one without is EMBED.
#
# Single-threaded (NO -pthread, no SharedArrayBuffer) but SIMD128 + relaxed-SIMD:
# a 4×4 register-blocked f32 GEMM microkernel (-msimd128) with fused multiply-add
# (-mrelaxed-simd → relaxed_madd). The portable scalar fallback uses fmaf with the
# SAME lane order, so the SAME sources compile natively for the llama.cpp embedding
# gate (`make semantic-verify`) BIT-EXACT with the wasm build — the 1:1 property
# holds (verified after the runtime-geometry refactor). See wasm/semantic/PERF.md.
#
# unicode-data.c is generated (wasm/semantic/tools/gen-unicode-data.py); the GGUF
# weights are separate gitignored assets (`make embed-model` / `make ner-model`).
#
# SEM_DIR / SEM_WASM_OUT / SEM_SOURCES are defined ABOVE (the wa-sqlite target
# folds the same sources in) — reused here as-is.
# ---------------------------------------------------------------------------
set(SEM_SOURCES
    ${SEM_DIR}/gguf.c
    ${SEM_DIR}/unicode-data.c
    ${SEM_DIR}/tokenizer.c
    ${SEM_DIR}/model.c
    ${SEM_DIR}/semantic.c
)

add_custom_command(
    OUTPUT ${SEM_WASM_OUT}
    COMMAND ${CMAKE_COMMAND} -E make_directory ${CMAKE_SOURCE_DIR}/src/assets/wasm
    COMMAND ${WASI_CLANG}
        --sysroot=${WASI_SYSROOT}
        --target=wasm32-wasip1
        -O3
        -msimd128
        # f32 FMA via wasm_f32x4_relaxed_madd in the GEMM microkernel — lowers to
        # vfmadd/fmla on every engine we target. Safe (≤0.5 ulp, MORE precise);
        # native verify uses fmaf so wasm↔native stays bit-exact. NOT the int8
        # relaxed_dot we rejected. See wasm/semantic/PERF.md.
        -mrelaxed-simd
        -mexec-model=reactor
        -I${SEM_DIR}
        ${SEM_SOURCES}
        -lm
        -Wl,--export=malloc
        -Wl,--export=free
        -Wl,--export=sem_init
        -Wl,--export=sem_embed
        -Wl,--export=sem_ner_infer
        -Wl,--export=sem_kind
        -Wl,--export=sem_dim
        -Wl,--export=sem_num_labels
        -Wl,--export=sem_strerror
        # Debug/testbed only: low-bit weight requantize hook for the /tests
        # ranking-tolerance probe (gates the LUT-GEMM direction). See semantic.c.
        -Wl,--export=sem_debug_requantize
        -Wl,--export=__heap_base
        -Wl,--initial-memory=16777216
        # ~132 MB of f32 weights resident + the staged GGUF buffer during load.
        -Wl,--max-memory=536870912
        -Wl,--stack-first
        -Wl,-z,stack-size=1048576
        -o ${SEM_WASM_OUT}
    DEPENDS ${SEM_SOURCES}
    COMMENT "Building semantic.wasm via wasi-sdk (BERT embed + token-classification)"
    VERBATIM
)

add_custom_target(semantic ALL DEPENDS ${SEM_WASM_OUT})
add_dependencies(semantic wasi-sdk)

find_package(Python3 3.10 COMPONENTS Interpreter)

# ---------------------------------------------------------------------------
# transformers: HF models -> ONNX for the browser Transformers Worker
#
# Drives wasm/transformers/build.py: uses `optimum.exporters.onnx` to
# convert each model in build.py's MODELS list (PII NER + BGE embeddings)
# to ONNX, then mirrors onnxruntime-web's runtime wasms into <deploy>/ort/.
# The deploy directory (src/assets/transformers/) is the artifact a static
# host serves; the in-browser worker uses @huggingface/transformers with
# env.localModelPath pinned to it.
#
# Tool chain:
#   * Python3 (>=3.10) — drives the venv + optimum CLI
#   * Repo-level `pnpm install` — provides onnxruntime-web wasms
# ---------------------------------------------------------------------------

set(TRANSFORMERS_ROOT    ${CMAKE_SOURCE_DIR}/wasm/transformers)
set(TRANSFORMERS_VENV    ${TRANSFORMERS_ROOT}/.venv)
set(TRANSFORMERS_VENV_PY ${TRANSFORMERS_VENV}/bin/python)
set(TRANSFORMERS_DEPLOY  ${CMAKE_SOURCE_DIR}/src/assets/transformers)
# Use a model-id-independent sentinel: the shared ORT wasm is written
# last in build.py (after every model is assembled), so its presence
# implies the whole deploy/ tree is laid out. Editing MODELS in build.py
# doesn't require touching this file. NOTE: this points at the REAL
# deploy dir (src/assets/transformers), where build.py actually writes.
set(TRANSFORMERS_DEPLOY_SENTINEL
    ${TRANSFORMERS_DEPLOY}/ort/ort-wasm-simd-threaded.wasm)

# Venv with optimum + the CPU-only torch wheel (the export backend).
# transformers comes in transitively via optimum[exporters].
add_custom_command(
    OUTPUT ${TRANSFORMERS_VENV}/pyvenv.cfg
    COMMAND ${Python3_EXECUTABLE} -m venv ${TRANSFORMERS_VENV}
    COMMAND ${TRANSFORMERS_VENV_PY} -m pip install --quiet --upgrade pip
    # In optimum 2.x the ONNX exporter moved out of the base package
    # into a separate optimum-onnx companion. We install it explicitly
    # along with onnx + onnxruntime so the export graph passes have a
    # runtime to validate against.
    COMMAND ${TRANSFORMERS_VENV_PY} -m pip install --quiet
        --extra-index-url https://download.pytorch.org/whl/cpu
        "torch>=2.2"
        "optimum>=2.0"
        "optimum-onnx>=0.1"
        "transformers>=4.40"
        "onnx>=1.16"
        "onnxruntime>=1.18"
        "onnxconverter-common>=1.14"
    COMMENT "Setting up Python venv for transformers build (optimum + torch-cpu)"
    VERBATIM
)
add_custom_target(transformers-venv DEPENDS ${TRANSFORMERS_VENV}/pyvenv.cfg)

# Inputs that invalidate the bundle.
file(GLOB_RECURSE TRANSFORMERS_BUILD_INPUTS CONFIGURE_DEPENDS
    ${TRANSFORMERS_ROOT}/build.py
)

add_custom_command(
    OUTPUT ${TRANSFORMERS_DEPLOY_SENTINEL}
    COMMAND ${TRANSFORMERS_VENV_PY} build.py
    WORKING_DIRECTORY ${TRANSFORMERS_ROOT}
    DEPENDS
        ${TRANSFORMERS_VENV}/pyvenv.cfg
        ${TRANSFORMERS_BUILD_INPUTS}
    COMMENT "Exporting models -> ONNX (src/assets/transformers/)"
    VERBATIM
)

add_custom_target(transformers DEPENDS ${TRANSFORMERS_DEPLOY_SENTINEL})

add_custom_target(transformers-clean
    COMMAND ${CMAKE_COMMAND} -E rm -rf
        ${TRANSFORMERS_ROOT}/build
        ${TRANSFORMERS_ROOT}/.venv
        ${TRANSFORMERS_DEPLOY}
    COMMENT "Removing transformers build outputs, venv, and deploy tree"
)
