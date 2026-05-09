#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

require_cmd node
require_cmd npm
require_cmd npx

cd "$ROOT_DIR"

node scripts/release/sync-version-manifests.mjs
npm ci --prefix skills/gpt-image-2-skill/scripts
node --test skills/gpt-image-2-skill/scripts/cli.test.ts
node scripts/smoke_skill_install.cjs >/tmp/gpt-image-2-skill-skill-smoke.json
npm ci --prefix apps/gpt-image-2-app
npm --prefix apps/gpt-image-2-app run typecheck
npm --prefix apps/gpt-image-2-app run test:browser
npm ci --prefix workers/gpt-image-2-relay
npm --prefix workers/gpt-image-2-relay run test
npm --prefix workers/gpt-image-2-relay run typecheck

echo "prepared gpt-image-2-skill $(project_version)"
