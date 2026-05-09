set shell := ["bash", "-euo", "pipefail", "-c"]

# Show available project commands.
default:
    just --list

# Install the local TypeScript CLI globally.
install-local:
    npm install --global ./skills/gpt-image-2-skill/scripts

# Sync executable bits and shared version manifests.
sync-skill:
    node scripts/sync_skill_bundle.cjs

# Smoke-test the installable skill bundle.
smoke-skill-install:
    node scripts/smoke_skill_install.cjs

# Run CLI tests.
test:
    npm ci --prefix skills/gpt-image-2-skill/scripts
    node --test skills/gpt-image-2-skill/scripts/cli.test.ts

# Type-check the web frontend.
app-typecheck:
    npm --prefix apps/gpt-image-2-app run typecheck

# Build the web frontend.
app-build:
    npm --prefix apps/gpt-image-2-app run build

# Build the HTTP-configured web frontend.
app-build-http:
    npm --prefix apps/gpt-image-2-app run build:http

# Run the browser transport tests.
app-test-browser:
    npm --prefix apps/gpt-image-2-app run test:browser

# Run the Cloudflare relay Worker tests and type-check.
relay-test:
    npm --prefix workers/gpt-image-2-relay run test
    npm --prefix workers/gpt-image-2-relay run typecheck

# Dry-run the Cloudflare relay Worker deployment.
relay-dry:
    npm --prefix workers/gpt-image-2-relay run dry-run

# Deploy the Cloudflare relay Worker route for image.codex-pool.com/api/relay*.
relay-deploy:
    npm --prefix workers/gpt-image-2-relay run deploy

# Start the frontend dev server.
dev-frontend:
    cd apps/gpt-image-2-app && npm run dev

# Run local release preparation gates.
release-prepare:
    scripts/release/prepare.sh

# Run local release verification gates.
release-verify:
    scripts/release/verify.sh

# Dry-run an npm release version bump.
release-dry level="patch":
    scripts/release/publish.sh "{{ level }}"

# Execute an npm release version bump and publish.
release level="patch":
    scripts/release/publish.sh "{{ level }}" --execute

# Watch a GitHub Actions run until completion.
watch run_id:
    gh run watch "{{ run_id }}" --exit-status

# Check the public npm release surface.
release-status:
    npm view gpt-image-2-skill version dist-tags.latest --json
