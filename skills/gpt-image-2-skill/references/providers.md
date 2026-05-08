# Providers

Built-in providers and named providers share the same command surface. Pick a built-in provider with `--provider <openai|codex|auto>`, or pass any provider name from shared config.

## Selection logic

- `--provider openai` — force OpenAI HTTP API.
- `--provider codex` — force Codex `image_generation` tool through `~/.codex/auth.json`.
- `--provider auto` (default) — use `default_provider` from shared config, then legacy OpenAI/Codex auto-selection.
- `--provider <name>` — resolve an `openai-compatible` or `codex` provider from `$CODEX_HOME/gpt-image-2-skill/config.json`.

The resolved provider appears in `doctor` output as `provider_selection.resolved`.

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
      "model": "gpt-image-2",
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
command -v gpt-image-2-skill >/dev/null 2>&1 || npm install --global gpt-image-2-skill
SKILL_CMD="gpt-image-2-skill"

$SKILL_CMD --json config set-user-agent --value "MyApp/1.0"
$SKILL_CMD --json config clear-user-agent
```

## OpenAI provider

| Item | Default |
|---|---|
| Model | `gpt-image-2` (override with `-m/--model`) |
| API base | `https://api.openai.com/v1` (override with `--openai-api-base`) |
| Generate path | `/images/generations` |
| Edit path | `/images/edits` (multipart upload) |
| Auth source | `OPENAI_API_KEY` env, then `--api-key` flag |

OpenAI-only flags: `--n`, `--moderation`, `--mask`, `--input-fidelity`.

OpenAI-compatible bases (e.g. `https://api.duckcoding.ai/v1`) work as long as they implement `/images/generations` and `/images/edits`.

## Codex provider

| Item | Default |
|---|---|
| Model | `gpt-5.4` (override with `-m/--model`) |
| Endpoint | `https://chatgpt.com/backend-api/codex/responses` |
| Image tool | `image_generation` (delegates to `gpt-image-2` server-side) |
| Auth source | `~/.codex/auth.json` or `$CODEX_HOME/auth.json` |
| Refresh endpoint | `https://auth.openai.com/oauth/token` |

Codex `401` triggers exactly one access-token refresh, then a single retry. Refresh failures surface as `refresh_failed` errors.

## Runtime discovery and update

Prefer the installed global CLI so the skill does not create or rely on repo-local `scripts/node_modules`.

```bash
command -v gpt-image-2-skill >/dev/null 2>&1 || npm install --global gpt-image-2-skill
SKILL_CMD="gpt-image-2-skill"

$SKILL_CMD --json doctor
```
