#!/bin/bash
# test_cb_tools.sh - Automated tests for cbImportScanpy, cbScanpy, cbImportSeurat, cbSeurat
#
# Test cases are defined in test_cases.csv (same directory as this script).
# Edit that file to add, remove, or modify tests — no changes to this script needed.
#
# Usage:
#   ./test_cb_tools.sh                         # run all tests
#   ./test_cb_tools.sh cbImportScanpy          # run only cbImportScanpy tests
#   ./test_cb_tools.sh cbScanpy
#   ./test_cb_tools.sh cbImportSeurat
#   ./test_cb_tools.sh cbSeurat
#   ./test_cb_tools.sh --cleanup               # run all tests, then delete output dirs
#   ./test_cb_tools.sh cbImportScanpy --cleanup
#   ./test_cb_tools.sh --time                  # run all tests, show elapsed time per test
#   ./test_cb_tools.sh cbImportScanpy --time

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CSV="${SCRIPT_DIR}/test_cases.csv"

# ---------------------------------------------------------------------------
# Configuration — defaults can be overridden in test_config.sh (same dir)
# ---------------------------------------------------------------------------
DATA_DIR="${SCRIPT_DIR}/test_data"
CONDA_BASE="/cluster/home/${USER}/miniconda3"
export SCANPY_H5AD="${DATA_DIR}/ovarian-follicle-recon.h5ad"
export SCANPY_EXPR="${DATA_DIR}/ovarian-follicle-recon_exprMatrix.tsv.gz"
export SCANPY_META="${DATA_DIR}/ovarian-follicle-recon_meta.tsv"
export SEURAT_RDS="${DATA_DIR}/skeletal-muscle_adult-hindlimb.rds"

if [ -f "${SCRIPT_DIR}/test_config.sh" ]; then
    # shellcheck source=/dev/null
    . "${SCRIPT_DIR}/test_config.sh"
fi

PASS=0
FAIL=0
TOTAL=0
FAILED_COMMANDS=()
OUTPUT_DIRS=()

# Parse arguments: optional category filter and/or --cleanup flag
FILTER=""
CLEANUP=false
SHOW_TIMING=false
for arg in "$@"; do
    case "${arg}" in
        --cleanup|-c) CLEANUP=true ;;
        --time|-t)    SHOW_TIMING=true ;;
        *) FILTER="${arg}" ;;
    esac
done

if [[ -n "${FILTER}" ]]; then
    SUMMARY_FILE="${SCRIPT_DIR}/${FILTER}_test_summary.txt"
else
    SUMMARY_FILE="${SCRIPT_DIR}/test_summary.txt"
fi

# Initialize conda
if [ -f "${CONDA_BASE}/etc/profile.d/conda.sh" ]; then
    . "${CONDA_BASE}/etc/profile.d/conda.sh"
else
    export PATH="${CONDA_BASE}/bin:$PATH"
fi

# Verify the CSV exists
if [ ! -f "${CSV}" ]; then
    echo "ERROR: test cases file not found: ${CSV}" >&2
    exit 1
fi

# -----------------------------------------------------------------------------
# run_test CATEGORY TEST_NAME OUT_SUBDIR ENV COMMAND EXPECTED UNEXPECTED
#
# Runs COMMAND inside CONDA_ENV, then verifies expected/unexpected files.
# Sets $OUTDIR before running so commands in the TSV can reference it.
# -----------------------------------------------------------------------------
run_test() {
    local CATEGORY="$1"
    local TEST_NAME="$2"
    local OUT_SUBDIR="$3"
    local ENV="$4"
    local CMD="$5"
    local EXPECTED_STR="$6"
    local UNEXPECTED_STR="$7"

    # Build arrays from space-separated strings
    read -ra EXPECTED   <<< "${EXPECTED_STR}"
    read -ra UNEXPECTED <<< "${UNEXPECTED_STR}"

    echo ""
    echo "=== TEST: ${TEST_NAME} ==="
    TOTAL=$((TOTAL + 1))

    # Export OUTDIR so the command string can reference it
    export OUTDIR="${SCRIPT_DIR}/${OUT_SUBDIR}"
    mkdir -p "${OUTDIR}"
    rm -rf "${OUTDIR:?}"/*
    OUTPUT_DIRS+=("${OUTDIR}")

    # Expand variables in CMD (e.g. $SCANPY_H5AD, $OUTDIR) then run inside env
    local EXPANDED_CMD
    EXPANDED_CMD="$(eval echo "${CMD}")"
    echo "Command: conda run -n ${ENV} bash -c \"${EXPANDED_CMD}\""
    local T_START T_END ELAPSED
    T_START=$(date +%s)
    if ! conda run -n "${ENV}" bash -c "${EXPANDED_CMD}"; then
        echo "  WARN: command exited with non-zero status"
    fi
    T_END=$(date +%s)
    ELAPSED=$((T_END - T_START))
    if $SHOW_TIMING; then
        echo "  TIME: ${ELAPSED}s"
    fi

    local TEST_PASSED=true
    local FAILURES=()

    for f in "${EXPECTED[@]}"; do
        if compgen -G "${OUTDIR}/*${f}" > /dev/null 2>&1; then
            echo "  PASS: ${f} found"
        else
            echo "  FAIL: ${f} NOT found"
            FAILURES+=("missing: ${f}")
            TEST_PASSED=false
        fi
    done

    for f in "${UNEXPECTED[@]}"; do
        if ! compgen -G "${OUTDIR}/*${f}" > /dev/null 2>&1; then
            echo "  PASS: ${f} correctly absent"
        else
            echo "  FAIL: ${f} should not be present"
            FAILURES+=("unexpected: ${f}")
            TEST_PASSED=false
        fi
    done

    local TIMING_STR=""
    if $SHOW_TIMING; then
        TIMING_STR="  (${ELAPSED}s)"
    fi

    if $TEST_PASSED; then
        echo "RESULT: PASSED - ${TEST_NAME}"
        printf "%-45s  PASSED%s\n" "${TEST_NAME}" "${TIMING_STR}" >> "${SUMMARY_FILE}"
        PASS=$((PASS + 1))
    else
        echo "RESULT: FAILED - ${TEST_NAME}"
        printf "%-45s  FAILED%s\n" "${TEST_NAME}" "${TIMING_STR}" >> "${SUMMARY_FILE}"
        for failure in "${FAILURES[@]}"; do
            printf "  %-43s    - %s\n" "" "${failure}" >> "${SUMMARY_FILE}"
        done
        FAIL=$((FAIL + 1))
        FAILED_COMMANDS+=("${TEST_NAME}: ${EXPANDED_CMD}")
    fi
}

# -----------------------------------------------------------------------------
# Parse and run tests from the TSV.
# Skips comment lines (starting with #) and blank lines.
# Filters by category if an argument was given.
# -----------------------------------------------------------------------------
# Initialize summary file
{
    echo "Test run: $(date)"
    echo "Filter:   ${FILTER:-all}"
    echo ""
    printf "%-45s  %s\n" "Test" "Result"
    printf "%-45s  %s\n" "----" "------"
} > "${SUMMARY_FILE}"

while IFS=',' read -r category test_name out_subdir env command expected unexpected; do
    # Skip comments and blank lines
    [[ "${category}" =~ ^#.*$ || -z "${category}" ]] && continue

    # Apply category filter if specified
    if [[ -n "${FILTER}" && "${category}" != "${FILTER}" ]]; then
        continue
    fi

    run_test "${category}" "${test_name}" "${out_subdir}" "${env}" "${command}" "${expected}" "${unexpected}"

done < "${CSV}"

if [[ "${TOTAL}" -eq 0 ]]; then
    if [[ -n "${FILTER}" ]]; then
        echo "No tests found for category '${FILTER}'." >&2
        echo "Available categories: cbImportScanpy, cbScanpy, cbImportSeurat, cbSeurat" >&2
    else
        echo "No tests found in ${TSV}." >&2
    fi
    exit 1
fi

echo ""
echo "############################################################"
echo "### Summary                                              ###"
echo "############################################################"
echo "  Passed: ${PASS} / ${TOTAL}"
echo "  Failed: ${FAIL} / ${TOTAL}"
echo ""

{
    echo ""
    echo "----"
    echo "Passed: ${PASS} / ${TOTAL}"
    echo "Failed: ${FAIL} / ${TOTAL}"
} >> "${SUMMARY_FILE}"

if [[ ${#FAILED_COMMANDS[@]} -gt 0 ]]; then
    {
        echo ""
        echo "Failed commands (fully resolved):"
        for cmd in "${FAILED_COMMANDS[@]}"; do
            echo "  ${cmd}"
        done
    } >> "${SUMMARY_FILE}"
fi

echo "Summary written to: ${SUMMARY_FILE}"

if $CLEANUP; then
    echo ""
    echo "Cleaning up test output directories..."
    for dir in "${OUTPUT_DIRS[@]}"; do
        if [ -d "${dir}" ]; then
            rm -rf "${dir}"
            echo "  Removed: ${dir}"
        fi
    done
    if [ -f "${SCRIPT_DIR}/Rplots.pdf" ]; then
        rm -f "${SCRIPT_DIR}/Rplots.pdf"
        echo "  Removed: ${SCRIPT_DIR}/Rplots.pdf"
    fi
fi

if [ "${FAIL}" -eq 0 ]; then
    echo "All tests passed."
    exit 0
else
    echo "Some tests failed."
    exit 1
fi
