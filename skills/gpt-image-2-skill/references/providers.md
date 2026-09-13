# Providers

Built-in providers and named providers share the same command surface. Pick a built-in provider with `--provider <openai|codex|auto>`, or pass any provider name from shared config.

## Selection logic

- `--provider openai` — force OpenAI HTTP API.
- `--provider codex` — force Codex `image_generation` tool through `~/.codex/auth.json`.
- `--provider auto` (default) — use `default_provider` from shared config, then legacy OpenAI/Codex auto-selection.
- `--provider <name>` — resolve an `openai-compatible` or `codex` provider from `$CODEX_HOME/gpt-image-2-skill/config.json`.

The resolved provider appears in `doctor` output as `provider_selection.resolved`.

## Model routing

`--model` and `--tier` select the image model independently of the provider. Resolution order:

| Priority | Source | Result |
|---|---|---|
| 1 | `--model <name>` | that exact model name (`flare` / `sunburst` expand to the full names) |
| 2 | `--tier speed\|precision` | `gpt-image-2.5-flare` / `gpt-image-2.5-sunburst` |
| 3 | provider config `model` | the pinned model; a legacy `gpt-image-2` pin is stripped once by the version-1 → version-2 config migration |
| 4 | operation default | `generate` → `gpt-image-2.5-flare`, `edit` → `gpt-image-2.5-sunburst` |

Defaults by purpose: `gpt-image-2.5-flare` is speed-first (daily output, SNS, web assets, batch runs); `gpt-image-2.5-sunburst` is precision-first (edits from an existing image, multi-round refinement, ads, product shots, final delivery).

Config migration: config version 1 (releases up to 0.3.x) pinned `model: "gpt-image-2"` on providers, which would shadow routing. On read, a version-1 config is migrated to version 2 and those legacy pins are dropped; `doctor` lists the affected providers under `model_routing.legacy_model_pins`. Because the migration is version-gated, a pin written afterwards is kept — use `config add-provider --name legacy --model gpt-image-2 ...`, or pass `--model gpt-image-2` per call, when an upstream still serves only the previous generation.

`model_resolution` in JSON output reports the decision (`resolved_model`, `source`, `tier`, `tier_source`, `reason`). `doctor` reports the routing defaults under `model_routing`.

## Shared config

Default paths:

| Item | Path |
|---|---|
| Config | `$CODEX_HOME/gpt-image-2-skill/config.json` |
| History | `$CODEX_HOME/gpt-image-2-skill/history.sqlite` |
| Jobs | `$CODEX_HOME/gpt-image-2-skill/jobs/` |

Example provider:

```json
{
  "version": 1,
  "user_agent": "MyApp/1.0",
  "default_provider": "my-image-api",
  "providers": {
    "my-image-api": {
      "type": "openai-compatible",
      "api_base": "https://example.com/v1",
      "model": "vendor-image-v3",
      "credentials": {
        "api_key": { "source": "file", "value": "sk-..." }
      }
    }
  }
}
```

Credential sources:

| Source | Shape |
|---|---|
| File | `{ "source": "file", "value": "sk-..." }` |
| Env | `{ "source": "env", "env": "MY_API_KEY" }` |
| Keychain | `{ "source": "keychain", "service": "gpt-image-2-skill", "account": "providers/name/api_key" }` |

## Global user-agent

The runtime sends `OpenAI/JS 4.96.0` by default. To override it globally, set the top-level `user_agent` field or use:

```bash
SKILL_DIR="{skill_root}"

node "$SKILL_DIR/scripts/gpt_image_2_skill.cjs" --json config set-user-agent --value "MyApp/1.0"
node "$SKILL_DIR/scripts/gpt_image_2_skill.cjs" --json config clear-user-agent
```

## OpenAI provider

| Item | Default |
|---|---|
| Model | `gpt-image-2.5-flare` for generate, `gpt-image-2.5-sunburst` for edit (override with `--model` or `--tier`) |
| API base | `https://api.openai.com/v1` (set `OPENAI_API_BASE` or configure a provider to change it) |
| Generate path | `/images/generations` |
| Edit path | `/images/edits` (multipart upload) |
| Auth source | `OPENAI_API_KEY` env, then `--api-key` flag |

OpenAI-only flags: `--n`, `--moderation`, `--mask`, `--input-fidelity`.

OpenAI-compatible bases (e.g. `https://api.duckcoding.ai/v1`) work as long as they implement `/images/generations` and `/images/edits`.

## Codex provider

| Item | Default |
|---|---|
| Model | `gpt-5.4` orchestrator (override with `--model`) |
| Endpoint | `https://chatgpt.com/backend-api/codex/responses` |
| Image tool | `image_generation` (the server picks the image model, so flare/sunburst routing does not apply) |
| Auth source | `~/.codex/auth.json` or `$CODEX_HOME/auth.json` |
| Refresh endpoint | `https://auth.openai.com/oauth/token` |

Codex `401` triggers exactly one access-token refresh, then a single retry. Refresh failures surface as `refresh_failed` errors.

## Bundled runtime discovery and update

The skill always runs its own bundled launcher. Let `{skill_root}` mean the absolute directory containing this skill's `SKILL.md`; resolve the launcher from there and never from `cwd` or `PATH`.

```bash
SKILL_DIR="{skill_root}"

node "$SKILL_DIR/scripts/gpt_image_2_skill.cjs" --version
node "$SKILL_DIR/scripts/gpt_image_2_skill.cjs" --json doctor
```

- The launcher resolves `cli-core.ts` relative to its own file, so every command works from any `cwd`.
- If it reports `Bundled runtime dependencies are missing: ...`, initialize this skill copy once with `npm install --omit=dev --no-audit --no-fund --prefix "$SKILL_DIR/scripts"`. Nothing is installed globally.
- Update the skill copy itself to update the runtime; a globally installed `gpt-image-2-skill` CLI is a separate product for shell and automation users and is never used as a fallback.
