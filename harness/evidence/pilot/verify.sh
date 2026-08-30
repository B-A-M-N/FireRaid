#!/usr/bin/env bash
# FR-R7-008 follow-up: independent hash verification of the FR-R6 pilot evidence bundle.
# Run from anywhere: bash harness/evidence/pilot/verify.sh
set -euo pipefail
cd "$(dirname "$0")/records"
echo "Verifying 40 pilot RunRecords against SHA256SUMS.txt ..."
sha256sum -c SHA256SUMS.txt --quiet
echo "OK: all 40 hashes verified."
echo "To reproduce the analyzer aggregate from these records (FR-P1-27 archive mode):"
echo "  python3 harness/analysis/analyze.py exp-pilot-control --records-dir harness/evidence/pilot/records/exp-pilot-control"
echo "  python3 harness/analysis/analyze.py exp-pilot-full    --records-dir harness/evidence/pilot/records/exp-pilot-full"
