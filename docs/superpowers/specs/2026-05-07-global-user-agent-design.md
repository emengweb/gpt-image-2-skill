# Global User-Agent Config

## Goal

Add one global config field for outbound HTTP requests.

- Default value: `OpenAI/Python 1.61.1`
- If config sets a custom value, use it instead
- Keep the setting global, not per provider

## Scope

This affects skill-managed HTTP requests only.

- OpenAI image requests
- OpenAI-compatible image requests
- Codex image requests and token refresh calls
- Remote image-source fetches used by the CLI

Non-HTTP endpoint reachability checks stay unchanged.

## Config

Add `user_agent?: string` to the top-level shared config.

Resolution order:

1. Trimmed `config.user_agent` when present
2. Default `OpenAI/Python 1.61.1`

Empty or whitespace-only values fall back to the default.

## CLI

Add config commands to manage the field:

- `config set-user-agent --value <ua>`
- `config clear-user-agent`

`config inspect` should include the stored `user_agent` value when present.

## Request Behavior

All affected HTTP requests should send `User-Agent: <resolved value>`.

The header should be applied centrally so every caller uses the same rule.

## Errors

- Invalid config write input should raise existing invalid-argument style errors
- Missing config should still use the default UA
- UA should never be treated as secret data

## Testing

Add tests for:

- default UA resolution
- custom UA override
- whitespace-only fallback
- header injection on OpenAI-compatible requests
- header injection on Codex requests
- config inspect / set / clear behavior
