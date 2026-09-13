# JSON stdout schema (`--json`)

Pass `--json` to receive a single JSON object on stdout. All commands return either a success envelope or a uniform error envelope.

## Error envelope

Every failure looks like this. The `detail` field is optional and provider-specific.

```json
{
  "ok": false,
  "error": {
    "code": "string_code",
    "message": "Human-readable summary.",
    "detail": { "...": "optional context" }
  }
}
```

Common `code` values:

| Code | Layer | Meaning |
|---|---|---|
| `invalid_command` | clap | unknown flag, missing required arg, or `--size` value rejected by clap-level parsing (e.g. `5000x5000` is not a multiple of 16) |
| `invalid_argument` | runtime | business-layer validation failure after clap accepted the input |
| `unsupported_option` | runtime | flag passed to a provider that does not accept it (e.g. `--mask` with `--provider codex`) |
| `auth_missing` | runtime | provider auth not present |
| `auth_parse_failed` | runtime | `auth.json` exists but cannot be parsed |
| `refresh_failed` | runtime | Codex token refresh failed |
| `network_error` | runtime | transport-level failure |
| `http_error` | runtime | upstream returned non-2xx |
| `invalid_body_json` | runtime | `request create` body file or stdin not valid JSON |
| `background_remove_failed` | runtime | standalone background removal failed or a batch had one or more failed items |
| `transparent_verification_failed` | runtime | transparent PNG extraction completed but final alpha verification did not pass |
| `transparent_input_mismatch` | runtime | dual-background extraction sources have different dimensions |

## Success envelopes by command

### `doctor`

```json
{
  "ok": true,
  "provider_selection": { "resolved": "openai", "...": "..." },
  "retry_policy": {
    "max_retries": 3,
    "base_delay_seconds": 1
  },
  "model_routing": {
    "generate": "gpt-image-2.5-flare",
    "edit": "gpt-image-2.5-sunburst",
    "legacy_openai_model": "gpt-image-2",
    "tiers": ["speed", "precision"],
    "resolution_order": ["--model", "--tier", "provider_config_model", "operation_default"],
    "legacy_model_pins": ["my-image-api"]
  }
}
```

`model_routing.legacy_model_pins` lists providers whose `model: "gpt-image-2"` pin was dropped by the one-time version-1 → version-2 config migration, so you can see which custom endpoints now receive the new default model names.

### `auth inspect`

```json
{
  "ok": true,
  "providers": {
    "openai": {
      "provider": "openai",
      "ready": true,
      "auth_source": "env",
      "api_key_present": true
    },
    "codex": {
      "provider": "codex",
      "ready": true,
      "parse_ok": true,
      "auth_mode": "chatgpt_token"
    }
  }
}
```

### `background doctor`

```json
{
  "ok": true,
  "command": "background doctor",
  "ready": true,
  "install": {
    "attempted": false,
    "ok": true,
    "python": { "resolved": "python3", "version": "Python 3.11.9" },
    "used_user_site": false,
    "requested_dependencies": [],
    "requested_packages": [],
    "already_satisfied": ["pillow", "rembg", "numpy"],
    "command": [],
    "exit_code": 0,
    "stdout": "",
    "stderr": "",
    "error": null
  },
  "environment": {
    "ready": true,
    "script": {
      "path": "/path/to/background_remove.py",
      "exists": true
    },
    "python": {
      "resolved": "python3",
      "version": "Python 3.11.9"
    },
    "dependencies": {
      "rembg": { "installed": true, "version": "2.0.67", "error": null },
      "pillow": { "installed": true, "version": "10.4.0", "error": null },
      "numpy": { "installed": true, "version": "2.1.1", "error": null }
    },
    "methods": {
      "rembg": { "available": true },
      "builtin": { "available": true }
    },
    "install_hints": []
  }
}
```

Pass `background doctor --fix` to request an explicit dependency install attempt before the final environment snapshot is returned.

### `background init`

```json
{
  "ok": true,
  "command": "background init",
  "initialized": true,
  "install": {
    "attempted": true,
    "ok": true,
    "python": { "resolved": "python3", "version": "Python 3.11.9" },
    "used_user_site": true,
    "requested_dependencies": ["pillow", "rembg", "numpy"],
    "requested_packages": ["Pillow", "rembg", "numpy"],
    "already_satisfied": [],
    "command": ["-m", "pip", "install", "--user", "Pillow", "rembg", "numpy"],
    "exit_code": 0,
    "stdout": "installed",
    "stderr": "",
    "error": null
  },
  "environment": { "...": "same shape as background doctor" },
  "next_steps": [
    "Install Pillow: pip install Pillow",
    "Install rembg for AI removal: pip install rembg[gpu] or pip install rembg"
  ]
}
```

Pass `background init --install` when you want the runtime to explicitly install missing Python dependencies instead of only returning hints.

### `background remove`

```json
{
  "ok": true,
  "command": "background remove",
  "requested_method": "rembg",
  "environment": {
    "python": { "resolved": "python3", "version": "Python 3.11.9" },
    "script_path": "/path/to/background_remove.py"
  },
  "summary": {
    "total": 2,
    "success": 2,
    "failed": 0
  },
  "results": [
    {
      "input": "/tmp/a.png",
      "success": true,
      "file": "/tmp/out/a_nobg.png",
      "method": "rembg",
      "fallbackFrom": null,
      "error": null
    }
  ]
}
```

### `images generate` (OpenAI)

```json
{
  "ok": true,
  "provider_selection": { "resolved": "openai" },
  "model_resolution": {
    "operation": "generate",
    "tier": "speed",
    "tier_source": "operation_default",
    "requested_model": null,
    "provider_model": null,
    "resolved_model": "gpt-image-2.5-flare",
    "source": "operation_default",
    "delegated_to_server": false,
    "reason": "Default generate model: speed-first model for high-frequency and low-cost generation."
  },
  "request": { "model": "gpt-image-2.5-flare", "size": "2048x2048", "...": "..." },
  "retry": { "count": 0, "max_retries": 3 },
  "data": { "...": "image metadata + saved file path" }
}
```

`model_resolution.source` is one of `explicit_model` (`--model`), `explicit_tier` (`--tier`), `provider_pin` (config `model`), `operation_default`, or `codex_default`. Under `--provider codex`, `delegated_to_server` is `true`, `resolved_model` is the orchestrator model, and the image model is chosen by the server.

### `images edit` (OpenAI multipart)

Same envelope as `images generate`. The `request` object includes `operation: "edit"` and `ref_image_count: <N>` instead of size hints. Reference-image edits default to `gpt-image-2.5-sunburst` (`model_resolution.source: "operation_default"`). Multipart transport is reported in **stderr** as the `multipart_prepared` progress event (`type: "multipart_prepared"`), not on stdout. Token usage in `response.usage` splits into `input_tokens_details.image_tokens` and `text_tokens` for edits.

### `transparent generate`

`transparent generate` adds `model_resolution`, `request.model`, `request.background: "transparent"` and `transparency_mode: "upstream-native"`. It sends one native transparent request and performs only final alpha verification.

### `request create`

Returns the raw upstream JSON wrapped in the standard envelope:

```json
{
  "ok": true,
  "data": { "...": "raw OpenAI or Codex response body" }
}
```

When `--expect-image` is set, the runtime decodes the first image payload into `--out-image` and adds `image_path` to `data`.

A `model` inside the body file is authoritative (`model_resolution.source: "explicit_model"`). When the body omits `model`, the runtime injects the routed default for `--request-operation generate` / `edit` and reports it in `model_resolution`.

### `transparent generate`

Returns the final verified transparent PNG. The command fails with `transparent_verification_failed` if the final file does not pass the built-in gate.

```json
{
  "ok": true,
  "command": "transparent generate",
  "provider": "openai",
  "transparency_mode": "upstream-native",
  "model_resolution": {
    "operation": "generate",
    "tier": "speed",
    "resolved_model": "gpt-5.4",
    "delegated_to_server": true,
    "...": "..."
  },
  "request": {
    "prompt": "...",
    "model": "gpt-5.4",
    "background": "transparent",
    "output_format": "png"
  },
  "generation": { "...": "upstream images payload" },
  "verification": {
    "passed": true,
    "profile": "generic",
    "is_png": true,
    "has_alpha": true,
    "input_has_alpha": true,
    "alpha_min": 0,
    "alpha_max": 255,
    "transparent_ratio": 0.42,
    "warnings": []
  },
  "output": {
    "path": "/tmp/asset.png",
    "bytes": 123456,
    "files": [{ "index": 0, "path": "/tmp/asset.png", "bytes": 123456 }]
  }
}
```

<!-- 原生透明生成不返回 source/extraction/attempts；以下示例属于旧版本，仅保留 extract 字段说明。 -->
<!--
    "source_prompt": "...",
    "final_background_intent": "transparent",
    "intermediate_extraction_background": {
      "requested_matte_color": null,
      "selected_matte_color": "#ff00ff",
      "selected_matte_name": "magenta",
      "rule_bucket": "saturated_asset_family",
      "reason": "saturated matte for compact assets",
      "retry_candidates": ["#00ffff", "#0000ff"]
    },
    "method": "chroma",
    "profile": "generic",
    "material": null,
    "requested_matte_color": null,
    "selected_matte_color": "#ff00ff",
    "selected_matte_name": "magenta",
    "matte_color": "#ff00ff",
    "matte_color_source": "auto-sampled",
    "threshold": 28.0,
    "softness": 34.0,
    "spill_suppression": 0.85,
    "format": "png"
  },
  "source": {
    "path": "/tmp/source.png",
    "kept": false,
    "attempts": [
      {
        "attempt": 1,
        "selected": true,
        "matte_color": "#ff00ff",
        "rule_bucket": "saturated_asset_family",
        "reason": "saturated matte for compact assets",
        "path": "/tmp/source.png",
        "source_prompt": "..."
      }
    ],
    "generation": { "...": "images generate payload" }
  },
  "extraction": { "method": "chroma", "...": "..." },
  "verification": {
    "passed": true,
    "profile": "generic",
    "is_png": true,
    "has_alpha": true,
    "input_has_alpha": true,
    "alpha_min": 0,
    "alpha_max": 255,
    "transparent_ratio": 0.42,
    "partial_pixels": 1234,
    "checkerboard_detected": false,
    "touches_edge": false,
    "edge_margin_px": 96,
    "stray_pixel_count": 0,
    "largest_component_ratio": 1.0,
    "matte_residue_checked": true,
    "matte_residue_score": 0.01,
    "halo_score": 0.0,
    "transparent_rgb_scrubbed": true,
    "alpha_health_score": 1.0,
    "residue_score": 0.99,
    "quality_score": 0.99,
    "failure_reasons": [],
    "warnings": []
  },
  "output": {
    "path": "/tmp/asset.png",
    "bytes": 123456,
    "files": [{ "index": 0, "path": "/tmp/asset.png", "bytes": 123456 }]
  }
}
```
-->

### `transparent extract`

Runs local extraction only. Use `--strict` when the command should fail if verification does not pass.

```json
{
  "ok": true,
  "command": "transparent extract",
  "method": "dual",
  "selected_strategy": "dual",
  "profile": "glow",
  "material": null,
  "attempts": [
    {
      "strategy": "dual",
      "selected": true,
      "success": true,
      "passed": true,
      "quality_score": 0.99,
      "error": null
    }
  ],
  "extraction": {
    "method": "dual",
    "rgb_scrubbed": true,
    "dual_alignment": {
      "score": 0.92,
      "passed": true,
      "negative_delta_ratio": 0.0,
      "delta_channel_noise": 0.03,
      "color_space": "srgb"
    }
  },
  "verification": { "passed": true, "...": "..." },
  "output": { "path": "/tmp/asset.png", "files": [] }
}
```

`selected_strategy` tells you which local extraction path produced the final file: `background-remove`, `chroma`, or `dual`. `attempts` summarizes those extraction attempts and applies to `transparent extract`; native `transparent generate` reports `transparency_mode`, `request.background`, `generation`, and final `verification` instead.

Method semantics:

- `auto` — prefer `background-remove`, then fallback to chroma
- `rembg` — force `background-remove`
- `chroma` — force local chroma extraction
- `dual` — force dual-background extraction

Chroma extraction reports `matte_color`, `matte_color_source`, `threshold`, `softness`, `spill_suppression`, and `material`. `matte_color_source` is `"auto-sampled"` when `--matte-color auto` was used or no matte was provided, and `"provided"` when a color was explicit. `spill_suppression` is a `0..1` matte-edge cleanup strength and defaults to `0.85`.

### `transparent verify`

Verifies any image file as a transparent PNG deliverable. With `--strict`, a failed verification returns the standard error envelope.

```json
{
  "ok": true,
  "command": "transparent verify",
  "profile": "icon",
  "passed": true,
  "verification": {
    "profile": "icon",
    "width": 2048,
    "height": 2048,
    "is_png": true,
    "has_alpha": true,
    "input_has_alpha": true,
    "alpha_min": 0,
    "alpha_max": 255,
    "transparent_pixels": 1000000,
    "partial_pixels": 50000,
    "checkerboard_detected": false,
    "touches_edge": false,
    "edge_margin_px": 80,
    "component_count": 1,
    "largest_component_ratio": 0.99,
    "stray_pixel_count": 24,
    "alpha_noise_score": 0.00001,
    "matte_residue_checked": false,
    "matte_residue_score": null,
    "halo_score": 0.0,
    "transparent_rgb_scrubbed": true,
    "alpha_health_score": 1.0,
    "residue_score": 0.99,
    "quality_score": 0.99,
    "failure_reasons": [],
    "warnings": []
  }
}
```

`matte_residue_checked` is false unless the verifier received `--expected-matte-color`. For chroma-derived outputs, a passing verification with `matte_residue_checked: false` did not check source-matte edge residue.

## When `--json` is omitted

Without `--json`, errors print to stderr and successful commands print human-readable summaries to stdout. Always pass `--json` when an agent is parsing the result.
