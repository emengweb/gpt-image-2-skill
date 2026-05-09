#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PACKAGE_DIR="$ROOT_DIR/skills/gpt-image-2-skill/scripts"
PACKAGE_JSON="$PACKAGE_DIR/package.json"

require_cmd() {
  local name="$1"
  if ! command -v "$name" >/dev/null 2>&1; then
    echo "missing required command: $name" >&2
    exit 1
  fi
}

project_version() {
  node -e 'const fs=require("node:fs"); const pkg=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(!pkg.version){process.exit(1)} console.log(pkg.version)' "$PACKAGE_JSON"
}

project_tag() {
  printf 'v%s\n' "$(project_version)"
}

current_branch() {
  git -C "$ROOT_DIR" rev-parse --abbrev-ref HEAD
}

require_clean_worktree() {
  local context="$1"
  if ! git -C "$ROOT_DIR" diff --quiet || ! git -C "$ROOT_DIR" diff --cached --quiet; then
    echo "working tree is dirty after $context; commit or discard these changes before releasing:" >&2
    git -C "$ROOT_DIR" status --short >&2
    exit 1
  fi
}
