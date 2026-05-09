#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

require_cmd git
require_cmd node
require_cmd npm

EXECUTE=0
LEVEL_OR_VERSION="patch"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --execute)
      EXECUTE=1
      shift
      ;;
    *)
      LEVEL_OR_VERSION="$1"
      shift
      ;;
  esac
done

cd "$ROOT_DIR"

if [[ "$EXECUTE" -eq 1 ]]; then
  require_clean_worktree "release preparation"
  npm --prefix "$PACKAGE_DIR" version "$LEVEL_OR_VERSION" --no-git-tag-version
  node scripts/release/sync-version-manifests.mjs
  "$ROOT_DIR/scripts/release/prepare.sh"
  git add \
    skills/gpt-image-2-skill/scripts/package.json \
    skills/gpt-image-2-skill/scripts/package-lock.json \
    skills/gpt-image-2-skill/scripts/README.md \
    apps/gpt-image-2-app/package.json \
    apps/gpt-image-2-app/package-lock.json
  git commit -m "release: $(project_version)"
  npm publish "$PACKAGE_DIR" --access public --provenance
  RELEASE_TAG="$(project_tag)"
  git tag "$RELEASE_TAG"
  git push origin main "$RELEASE_TAG"
  echo "published $RELEASE_TAG"
else
  echo "dry run complete for $(project_tag) -> ${LEVEL_OR_VERSION}"
fi
