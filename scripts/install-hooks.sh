#!/usr/bin/env bash
# scripts/install-hooks.sh
#
# Point the local clone's git config at .githooks/ so the checked-in
# pre-commit hook (and any future ones) run automatically.
#
# Idempotent: rerunning is safe — `git config` simply overwrites the
# existing value. Designed to no-op cleanly when invoked outside a git
# checkout (e.g. when api/ is consumed via a published tarball or by CI
# from a shallow clone where .git is absent), so it can be wired into
# `npm install` via the `prepare` lifecycle without breaking anything.

set -euo pipefail

# Resolve the repo root from this script's location, not the caller's
# cwd — `npm prepare` runs from api/, but a developer invoking the script
# directly will run it from the repo root.
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "$SCRIPT_DIR/.." && pwd )"

if [[ ! -d "$REPO_ROOT/.git" ]] && ! git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  # Not a git checkout (npm tarball install, Docker COPY, CI shallow
  # checkout that prunes .git, etc.). Nothing to wire — exit clean so
  # `npm install` doesn't fail.
  exit 0
fi

if [[ ! -d "$REPO_ROOT/.githooks" ]]; then
  echo "install-hooks: $REPO_ROOT/.githooks not found — nothing to install" >&2
  exit 0
fi

git -C "$REPO_ROOT" config core.hooksPath .githooks
echo "install-hooks: core.hooksPath → .githooks (active hooks: $(ls "$REPO_ROOT/.githooks" | tr '\n' ' '))"
