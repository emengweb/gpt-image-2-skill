#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

require_cmd node
require_cmd npm
require_cmd npx

cd "$ROOT_DIR"

node scripts/release/sync-version-manifests.mjs
npm ci --prefix skills/gpt-image-2-skill/scripts
npm pack --dry-run ./skills/gpt-image-2-skill/scripts >/tmp/gpt-image-2-skill-pack.txt
node --test skills/gpt-image-2-skill/scripts/cli.test.ts
node scripts/smoke_skill_install.cjs >/tmp/gpt-image-2-skill-verify-skill.json

echo "verified gpt-image-2-skill $(project_version)"
