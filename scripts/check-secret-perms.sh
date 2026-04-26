#!/usr/bin/env bash
# secrets/check-perms.sh
#
# Enforces 600 permissions on every *.txt file in this directory. The Docker
# secret files mounted into containers don't need world-readable bits — those
# bits only widen the local-host attack surface (any process running as a
# non-root user on the host can read the credential).
#
# Run by hand:        ./secrets/check-perms.sh
# Run from a script:  source ./secrets/check-perms.sh  (exports nothing)
#
# Exit code is 0 if every file is correct after the run, 1 otherwise.

set -euo pipefail

SECRETS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exit_code=0

shopt -s nullglob
for f in "$SECRETS_DIR"/*.txt; do
  # macOS `stat -f %A` and Linux `stat -c %a` differ — handle both.
  perms="$(stat -f %A "$f" 2>/dev/null || stat -c %a "$f")"
  if [ "$perms" != "600" ]; then
    echo "  ! $(basename "$f") was $perms — fixing to 600"
    chmod 600 "$f" || { exit_code=1; continue; }
    perms_after="$(stat -f %A "$f" 2>/dev/null || stat -c %a "$f")"
    if [ "$perms_after" != "600" ]; then
      echo "  X $(basename "$f") still $perms_after after chmod — manual fix needed"
      exit_code=1
    fi
  fi
done
shopt -u nullglob

if [ "$exit_code" -eq 0 ]; then
  echo "  ok: all secrets/*.txt are 600"
fi
exit "$exit_code"
