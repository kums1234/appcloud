#!/usr/bin/env bash
# scripts/audit-summary.sh
#
# Print the npm-audit by-severity breakdown for api/ and (optionally)
# fail the build if any severity bucket regresses past a committed
# baseline. Designed to be cheap enough for CI to run on every PR.
#
# Usage:
#   scripts/audit-summary.sh                 # print + compare to baseline (exit 1 on regression)
#   scripts/audit-summary.sh --update-baseline   # rewrite scripts/audit-baseline.json from current state
#   scripts/audit-summary.sh --no-fail        # print + compare, never exit non-zero
#
# Baseline shape (scripts/audit-baseline.json):
#   { "info": 0, "low": 2, "moderate": 18, "high": 4, "critical": 0 }
#
# Regression policy: any severity > baseline triggers exit 1. Counts that
# *drop* are silently accepted — re-run with --update-baseline to lock in
# the improvement.

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "$SCRIPT_DIR/.." && pwd )"
API_DIR="$REPO_ROOT/api"
BASELINE_FILE="$SCRIPT_DIR/audit-baseline.json"

mode="compare"
for arg in "$@"; do
  case "$arg" in
    --update-baseline) mode="update" ;;
    --no-fail)         mode="report" ;;
    -h|--help)
      sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "audit-summary: unknown flag '$arg'" >&2
      exit 2
      ;;
  esac
done

command -v jq >/dev/null 2>&1 || {
  echo "audit-summary: 'jq' is required (brew install jq)" >&2
  exit 2
}

cd "$API_DIR"

# `npm audit` exits non-zero when vulnerabilities exist — that's signal we
# want to surface ourselves, not a script failure. Capture stdout, ignore
# the exit code, then validate the JSON shape.
audit_json="$(npm audit --json 2>/dev/null || true)"
if ! printf '%s' "$audit_json" | jq -e '.metadata.vulnerabilities' >/dev/null 2>&1; then
  echo "audit-summary: 'npm audit --json' produced no parseable vulnerabilities object" >&2
  printf '%s\n' "$audit_json" | head -c 500 >&2
  exit 2
fi

current="$(printf '%s' "$audit_json" | jq -c '
  .metadata.vulnerabilities
  | { info, low, moderate, high, critical }
')"

print_summary() {
  printf '%s' "$1" | jq -r '
    "  critical : \(.critical)",
    "  high     : \(.high)",
    "  moderate : \(.moderate)",
    "  low      : \(.low)",
    "  info     : \(.info)"
  '
}

echo "npm audit — $API_DIR"
print_summary "$current"

if [[ "$mode" == "update" ]]; then
  printf '%s\n' "$current" | jq '.' > "$BASELINE_FILE"
  echo
  echo "audit-summary: baseline updated → $BASELINE_FILE"
  exit 0
fi

if [[ ! -f "$BASELINE_FILE" ]]; then
  echo
  echo "audit-summary: no baseline at $BASELINE_FILE — run with --update-baseline to create one."
  exit 0
fi

baseline="$(jq -c '.' "$BASELINE_FILE")"

regressions="$(jq -nc --argjson c "$current" --argjson b "$baseline" '
  ["critical","high","moderate","low","info"]
  | map(select(($c[.] // 0) > ($b[.] // 0))
        | { sev: ., baseline: ($b[.] // 0), current: ($c[.] // 0) })
')"

count="$(printf '%s' "$regressions" | jq 'length')"

echo
if [[ "$count" -eq 0 ]]; then
  echo "audit-summary: no regressions vs baseline."
  exit 0
fi

echo "audit-summary: REGRESSIONS vs baseline:"
printf '%s' "$regressions" | jq -r '.[] | "  \(.sev): \(.baseline) → \(.current)"'

if [[ "$mode" == "report" ]]; then
  exit 0
fi
exit 1
