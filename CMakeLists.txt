cmake_minimum_required(VERSION 3.20)

# Builds the project's WASM artifacts:
#   - target qjs-wasm: contrib/quickjs compiled to public/qjs.wasm via
#     wasi-sdk (downloaded automatically). Always built.
#   - target tiny-pii: a HF token-classification PII model converted to
#     ONNX for transformers.js (model_id pinned in wasm/tiny-pii/build.py).
#     Lands in wasm/tiny-pii/build/deploy/. Opt-in (not ALL); invoke
#     with `cmake --build build --target tiny-pii`.
project(analyst_wasm LANGUAGES NONE)

include(ExternalProject)

set(WASI_SDK_RELEASE wasi-sdk-25)

if(CMAKE_HOST_SYSTEM_NAME STREQUAL "Darwin")
    if(CMAKE_HOST_SYSTEM_PROCESSOR STREQUAL "arm64")
        set(WASI_SDK_URL https://github.com/WebAssembly/wasi-sdk/releases/download/${WASI_SDK_RELEASE}/wasi-sdk-25.0-arm64-macos.tar.gz)
        set(WASI_SDK_MD5 f57fc8481efef6322ddf3ac6a8ce35e4)
    else()
        set(WASI_SDK_URL https://github.com/WebAssembly/wasi-sdk/releases/download/${WASI_SDK_RELEASE}/wasi-sdk-25.0-x86_64-macos.tar.gz)
        set(WASI_SDK_MD5 "")
    endif()
elseif(CMAKE_HOST_SYSTEM_NAME STREQUAL "Linux")
    if(CMAKE_HOST_SYSTEM_PROCESSOR STREQUAL "aarch64")
        set(WASI_SDK_URL https://github.com/WebAssembly/wasi-sdk/releases/download/${WASI_SDK_RELEASE}/wasi-sdk-25.0-arm64-linux.tar.gz)
    else()
        set(WASI_SDK_URL https://github.com/WebAssembly/wasi-sdk/releases/download/${WASI_SDK_RELEASE}/wasi-sdk-25.0-x86_64-linux.tar.gz)
    endif()
    set(WASI_SDK_MD5 "")
else()
    message(FATAL_ERROR "Unsupported host system: ${CMAKE_HOST_SYSTEM_NAME}")
endif()

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

set(QJS_WASM_OUT ${CMAKE_SOURCE_DIR}/public/qjs.wasm)

add_custom_command(
    OUTPUT ${QJS_WASM_OUT}
    COMMAND ${WASI_CLANG}
        --sysroot=${WASI_SYSROOT}
        --target=wasm32-wasi
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
# instead of Emscripten. Produces public/wa-sqlite.wasm + companion runtime
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
set(WASQL_WASM_OUT ${CMAKE_SOURCE_DIR}/public/wa-sqlite.wasm)

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

add_custom_command(
    OUTPUT ${WASQL_WASM_OUT}
    COMMAND ${WASI_CLANG}
        --sysroot=${WASI_SYSROOT}
        --target=wasm32-wasi
        -Oz -flto
        -mexec-model=reactor
        -I${SQLITE_AMALGAMATION_DIR}
        -I${WASQL_DIR}/src
        -Wno-non-literal-null-conversion
        ${WASQL_DEFINES}
        ${WASQL_SOURCES}
        ${WASQL_EXTFN_C}
        ${WASQL_EXPORT_FLAGS}
        -Wl,--export=malloc
        -Wl,--export=free
        -Wl,--export=__heap_base
        -Wl,--initial-memory=16777216
        -Wl,--max-memory=2147483648
        -Wl,--stack-first
        -Wl,-z,stack-size=524288
        # The libadapters dispatch functions (ipp, ippp, vppp, etc.) are
        # JS-side imports — they're declared `extern` in libadapters.h but
        # not defined in any .c. Tell wasm-ld these are imports, not
        # missing symbols.
        -Wl,--allow-undefined
        -o ${WASQL_WASM_OUT}
    DEPENDS
        ${WASQL_SOURCES}
        ${WASQL_EXTFN_C}
        ${WASQL_PATCH_STAMP}
        ${WASQL_PATCH}
        ${SQLITE_AMALGAMATION_DIR}/sqlite3.c
    COMMENT "Building wa-sqlite.wasm via wasi-sdk (sqlite3 + lib*.c + extension-functions)"
    VERBATIM
)

add_custom_target(wa-sqlite ALL DEPENDS ${WASQL_WASM_OUT})
add_dependencies(wa-sqlite wasi-sdk sqlite-amalgamation)

find_package(Python3 3.10 COMPONENTS Interpreter)

# ---------------------------------------------------------------------------
# tiny-pii: HF token-classification PII model -> ONNX for transformers.js
#
# Drives wasm/tiny-pii/build.py: uses `optimum.exporters.onnx` to convert
# the model pinned in build.py (MODEL_ID) to fp32 ONNX, then mirrors
# onnxruntime-web's runtime wasms into deploy/ort/. The deploy directory
# is the artifact a static host serves; the in-browser worker uses
# @huggingface/transformers with env.localModelPath pinned to it.
#
# Tool chain:
#   * Python3 (>=3.10) — drives the venv + optimum CLI
#   * Repo-level `pnpm install` — provides onnxruntime-web wasms
# ---------------------------------------------------------------------------

set(TINYPII_ROOT    ${CMAKE_SOURCE_DIR}/wasm/tiny-pii)
set(TINYPII_VENV    ${TINYPII_ROOT}/.venv)
set(TINYPII_VENV_PY ${TINYPII_VENV}/bin/python)
# Use a model-id-independent sentinel: the ORT wasm is always written
# last in build.py, so its presence implies the whole deploy/ tree is
# laid out. Swapping the MODEL_ID in build.py doesn't require touching
# this file.
set(TINYPII_DEPLOY_SENTINEL
    ${TINYPII_ROOT}/build/deploy/ort/ort-wasm-simd-threaded.wasm)

# Venv with optimum + the CPU-only torch wheel (the export backend).
# transformers comes in transitively via optimum[exporters].
add_custom_command(
    OUTPUT ${TINYPII_VENV}/pyvenv.cfg
    COMMAND ${Python3_EXECUTABLE} -m venv ${TINYPII_VENV}
    COMMAND ${TINYPII_VENV_PY} -m pip install --quiet --upgrade pip
    # In optimum 2.x the ONNX exporter moved out of the base package
    # into a separate optimum-onnx companion. We install it explicitly
    # along with onnx + onnxruntime so the export graph passes have a
    # runtime to validate against.
    COMMAND ${TINYPII_VENV_PY} -m pip install --quiet
        --extra-index-url https://download.pytorch.org/whl/cpu
        "torch>=2.2"
        "optimum>=2.0"
        "optimum-onnx>=0.1"
        "transformers>=4.40"
        "onnx>=1.16"
        "onnxruntime>=1.18"
        "onnxconverter-common>=1.14"
    COMMENT "Setting up Python venv for tiny-pii build (optimum + torch-cpu)"
    VERBATIM
)
add_custom_target(tiny-pii-venv DEPENDS ${TINYPII_VENV}/pyvenv.cfg)

# Inputs that invalidate the bundle.
file(GLOB_RECURSE TINYPII_BUILD_INPUTS CONFIGURE_DEPENDS
    ${TINYPII_ROOT}/build.py
)

add_custom_command(
    OUTPUT ${TINYPII_DEPLOY_SENTINEL}
    COMMAND ${TINYPII_VENV_PY} build.py
    WORKING_DIRECTORY ${TINYPII_ROOT}
    DEPENDS
        ${TINYPII_VENV}/pyvenv.cfg
        ${TINYPII_BUILD_INPUTS}
    COMMENT "Exporting tiny-pii model -> ONNX (wasm/tiny-pii/build/deploy/)"
    VERBATIM
)

add_custom_target(tiny-pii DEPENDS ${TINYPII_DEPLOY_SENTINEL})

add_custom_target(tiny-pii-clean
    COMMAND ${CMAKE_COMMAND} -E rm -rf
        ${TINYPII_ROOT}/build
        ${TINYPII_ROOT}/.venv
    COMMENT "Removing tiny-pii build outputs and venv"
)
