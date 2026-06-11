---
name: gpt-image-2-skill
description: This skill should be used when the user asks to "generate an image", "create a logo", "draw an icon", "edit this photo", "change background to transparent", "remove background", "transparent background", "cut out", "isolate subject", "remove bg", "make transparent", "extract subject", "background removal", "批量抠图", "用 GPT image 生成图片", "用 Codex 画图", "帮我生成一张图", "改成透明背景", "抠图", "把背景去掉", "把这张图编辑一下", or any prompt-to-image, reference-image-edit, standalone background-removal, or transparent PNG delivery task that benefits from a structured CLI returning JSON results and JSONL progress events. Supports OpenAI `gpt-image-2` (via `OPENAI_API_KEY` or OpenAI-compatible base URL), Codex `image_generation` (via `~/.codex/auth.json`), and merged `background-remove` local cutout workflows under one command surface, with masks, custom sizes up to 4K, transparent PNG verification, single-image and batch background removal, and a raw request escape hatch.
---

Run image generation and editing through one CLI surface that hides provider differences. The runtime in `scripts/` is now pure TypeScript plus a thin CJS launcher.

## Runtime advice

- Prefer the installed global `gpt-image-2-skill` CLI so the skill does not create or reuse repo-local `scripts/node_modules`.
- If the global CLI is missing, install it globally instead of writing dependencies into `scripts/`.
- Reuse one resolved command string for the rest of the session so all examples hit the same runtime.

```bash
command -v gpt-image-2-skill >/dev/null 2>&1 || npm install --global gpt-image-2-skill
SKILL_CMD="gpt-image-2-skill"
```

## When to use this skill

- Generate or edit an image and capture a structured result an agent can parse.
- Switch between `OPENAI_API_KEY`, an OpenAI-compatible base URL, and Codex `auth.json` without changing command shape.
- Respect shared provider config at `$CODEX_HOME/gpt-image-2-skill/config.json` so CLI, App, and Skill use the same default provider.
- Need final transparent PNG deliverables, masks, custom sizes up to 4K, or raw request bodies.
- Need direct background removal without image generation, including environment checks and initialization hints.
- Want live progress events (retries, multipart prep, Codex SSE) on stderr while the final JSON lands on stdout.

## Quick start

Always pass `--json` so the result is machine-readable. Add `--json-events` when progress visibility matters.

```bash
# 0. Resolve the runtime once
command -v gpt-image-2-skill >/dev/null 2>&1 || npm install --global gpt-image-2-skill
SKILL_CMD="gpt-image-2-skill"

# 1. Confirm runtime + provider readiness
$SKILL_CMD --json config inspect
$SKILL_CMD --json doctor
$SKILL_CMD --json auth inspect

# 2. Generate a final transparent PNG deliverable
$SKILL_CMD --json --json-events \
  transparent generate --prompt "..." --out /tmp/asset.png \
  --size 2K --quality high

# 3. Generate a normal image (auto-selects provider; OpenAI first, then Codex)
$SKILL_CMD --json --json-events \
  images generate --prompt "..." --out /tmp/out.png \
  --format png --size 2K

# 4. Edit a reference image (OpenAI multipart)
$SKILL_CMD --json --json-events \
  images edit --prompt "..." --ref-image /tmp/in.png --out /tmp/out.png

# 5. Remove a controlled background from existing source images
$SKILL_CMD --json \
  transparent extract --input /tmp/source-green.png --out /tmp/asset.png \
  --method auto --matte-color auto --strict

# 6. Run standalone background-removal environment checks or direct cutouts
$SKILL_CMD --json \\
  transparent extract --input /tmp/source-green.png --out /tmp/asset.png \\
  --method auto --matte-color auto --strict

# 7. Verify the final file before delivery
$SKILL_CMD --json \\
  transparent verify --input /tmp/asset.png --profile icon --strict

# 8. Raw request escape hatch
$SKILL_CMD --json \\
  request create --request-operation generate \\
  --body-file /tmp/body.json --out-image /tmp/out.png --expect-image

# 9. Optional smoke check
$SKILL_CMD --json doctor
```

Force a provider with `--provider openai`, `--provider codex`, or any named provider from `config inspect`. You can place `--provider <id>` before the command group or inside the subcommand; leave the default `--provider auto` to use `default_provider` first. Streaming now defaults to off; pass `--stream` when you want SSE/streaming behavior for a single request, or persist it on a provider via `config add-provider --stream`.

## Runtime consistency check

Before using newly documented command groups, especially `transparent generate`, `transparent extract`, or `transparent verify`, confirm the selected runtime is ready:

```bash
command -v gpt-image-2-skill >/dev/null 2>&1 || npm install --global gpt-image-2-skill
SKILL_CMD="gpt-image-2-skill"

$SKILL_CMD --json doctor
```

If a documented subcommand fails unexpectedly, first check the installed global CLI version and reinstall or upgrade it before troubleshooting provider behavior.

For standalone cutout workflows, use `transparent extract` first. It works on a single source image and performs local background removal plus transparent verification. If a documented subcommand fails unexpectedly, first check the installed global CLI version and reinstall or upgrade it before troubleshooting provider behavior.

Background-removal prerequisites and behavior:

- `transparent extract --method auto` is the default cutout path.
- `Pillow` is required for local extraction helpers.
- `numpy` is optional; it can speed up the built-in extraction path but is not required.

Typical installs:

```bash
pip install Pillow
pip install rembg
# or, when GPU/CUDA support is desired:
pip install rembg[gpu]
```

Auto-install behavior:

- The runtime never installs Python packages implicitly during ordinary `background remove`, `transparent extract`, or `transparent generate` calls.
- Use `background init --install` to explicitly install missing `Pillow`, `rembg`, and optional `numpy`.
- Use `background doctor --fix` as a synonym when you want the environment report plus the same explicit install attempt in one step.

## Shared config

Use the CLI config surface when the user asks to add or pin a provider:

```bash
command -v gpt-image-2-skill >/dev/null 2>&1 || npm install --global gpt-image-2-skill
SKILL_CMD="gpt-image-2-skill"

$SKILL_CMD --json config path
$SKILL_CMD --json config add-provider \
  --name my-image-api \
  --type openai-compatible \
  --api-base https://example.com/v1 \
  --api-key sk-... \
  --set-default
$SKILL_CMD --json config test-provider my-image-api
```

Credential sources supported by CLI, App, and Skill: `file`, `env`, and `keychain`. File credentials are stored in the shared config file; JSON output redacts them.

The shared config also supports a global `user_agent`. Use `config set-user-agent --value <ua>` to set it and `config clear-user-agent` to remove it. When unset, the runtime uses `OpenAI/JS 4.96.0`.

## Flags vs prompt — what each controls

Output **properties** (not "what to draw") are flag-controlled. Putting them in the prompt is unreliable and provider-dependent.

| Property | Use this flag, not the prompt |
|---|---|
| Output background (transparent / opaque / auto) | `--background auto\|transparent\|opaque` |
| Output dimensions | `--size 2K`, `--size 4K`, or `--size WIDTHxHEIGHT` |
| Output container | `--format png\|jpeg\|webp` |
| Compression level | `--compression 0..100` |
| Render quality | `--quality low\|medium\|high\|auto` |
| Number of images | `--n <count>` (OpenAI only) |
| Edit mask region | `--mask <png>` (OpenAI only) |

The prompt is for "what is in the picture"; background, size, format, count, and mask are not. For example, to turn a transparent PNG into a white-background PNG, pass `--background opaque` — describing "white background" only in the prompt is **not reliable**.

**Provider asymmetry**: `--background`, `--n`, `--moderation`, `--mask`, and `--input-fidelity` are honored only by OpenAI (and OpenAI-compatible bases that proxy them). Codex `image_generation` does not honor `--background`; the runtime accepts the flag but the upstream tool drops it. The other four return `code: "unsupported_option"` if passed with `--provider codex`.

## Transparent PNG deliverables

For transparent output, do not rely on provider-native transparency. Use the `transparent` command group as the Agent-facing tool layer:

- `transparent generate` — prompt-to-final PNG. It generates a controlled matte source, tries the integrated `background-remove` pipeline first, falls back to local chroma extraction when needed, verifies the result, and only succeeds when the final PNG passes transparency checks.
- `transparent extract` — direct cutout for an existing source image. Use `--method auto` by default; the runtime picks the best available local extraction path and verifies the PNG before returning success.
- `transparent verify` — final gate for any PNG before delivery. Use `--strict` and the right `--profile` when the file must be accepted or fail the task.

`transparent generate` now also reports `final_background_intent`, `selected_matte_color`, and `intermediate_extraction_background` in JSON so the agent can see the deterministic matte choice and retry candidates used internally.

## Direct cutout workflow

Use `transparent extract` when the user wants to remove the background from an existing image.

Recommended direct-cutout workflow:

1. Confirm the source image or list of source images.
2. Use `transparent extract --method auto` for the first pass.
3. If the result is unsatisfactory on a simple flat-matte source, retry with `--method chroma` and explicit extraction tuning.
4. If the task needs dual black/white extraction for translucent assets, use `--method dual` with `--dark-image` and `--light-image`.
5. If the user does not specify an output path, save beside the source with an `_nobg` suffix.
6. Deliver PNG by default unless the user explicitly wants a different format.

Direct-cutout quick examples:

```bash
# Single image, default cutout path
$SKILL_CMD --json \
  transparent extract --input /tmp/photo.jpg --out /tmp/photo_nobg.png \
  --method auto --profile generic

# Force chroma extraction for flat-matte graphics
$SKILL_CMD --json \
  transparent extract --input /tmp/icon.png --out /tmp/icon_nobg.png \
  --method chroma --profile icon --strict

# Dual extraction for translucent assets
$SKILL_CMD --json \
  transparent extract --dark-image /tmp/glass-black.png --light-image /tmp/glass-white.png \
  --out /tmp/glass_nobg.png --method dual --profile translucent --strict
```

Direct-cutout method guidance:

| Method | Best for | Notes |
|---|---|---|
| `auto` | first-pass cutouts for most images | lets the runtime choose the best available local extraction path |
| `chroma` | icons, logos, screenshots, graphics with clean flat backgrounds | faster and deterministic on simple matte backgrounds |
| `dual` | translucent or glow-heavy assets | requires matching black/white source renders |

Standalone cutout output behavior:

- Save to the explicit `--out` path you provide.
- PNG is the safest default for final transparent deliverables.
- A transparent deliverable is valid only if the final file has a real PNG alpha channel and passes verification.

`--strict` is profile-based:

| Profile | Use for | Extra strictness |
|---|---|---|
| `generic` | common alpha/file checks | does not over-police unusual assets |
| `icon` | clean single-subject icons and props | requires clean opaque core, margin, low stray noise |
| `product` | product/object cutouts | similar to icon, with residue and edge checks |
| `sticker` | decals, badges, multi-detail props | allows more intentional small components than `icon` |
| `seal` | stamps, seals, logos with inner marks | allows split components such as ring + center symbol |
| `translucent` | glass, liquid, crystal | requires partial alpha |
| `glow` | light ribbons, flame, smoke, particles | requires partial alpha and transparent margin |
| `shadow` | soft shadow assets | requires partial alpha and transparent margin |
| `effect` | hard-alpha particles, bursts, UI effects | transparent margin without requiring partial alpha |

The CLI is intentionally not a material classifier. The Agent should choose generation prompts and extraction methods based on the asset:

| Asset type | Generation guidance | Extraction guidance |
|---|---|---|
| Opaque object, icon, sticker, product | Single isolated subject, clear margin, perfectly flat matte. Prefer black or white first; only fall back to a colored matte if either one blends into the subject. | `transparent generate` or `transparent extract --method auto --matte-color auto`; the runtime tries `background-remove` first, then chroma fallback if verification or extraction fails. |
| Thin edges, hair, fur, lace, chain, netting | Use high resolution, strong subject/background contrast, no contact shadow, no background-colored details. Try magenta/cyan/green mattes if one contaminates the edge. | `background-remove` first, then chroma extraction with `--spill-suppression` when needed; verify with `--expected-matte-color` and retry with a different matte if residue remains. |
| Glass, crystal, liquid, hologram | Ask for a centered asset on flat black and flat white backgrounds, keeping geometry identical. Use reference/edit flow when possible to keep alignment. | `transparent extract --method dual --dark-image black.png --light-image white.png` |
| Glow, flame, smoke, mist, magic particles | Generate dark and light background variants. Avoid textured backgrounds and avoid bloom reaching the image edge unless the edge is intentional. | Prefer dual extraction; verify that `partial_pixels` is non-zero. |
| Shadows | Decide whether the shadow is part of the asset. If not, explicitly forbid contact shadows. If yes, generate on a flat matte with enough margin. | Chroma for opaque shadow silhouettes; dual extraction for soft translucent shadows. |
| Unknown or unusual material | Do not classify it first. Generate controlled source variants, run extraction candidates, and keep the one that passes verification with the cleanest edge. | Use `--report-dir` / `--keep-sources` while iterating, then deliver only the final PNG. |

For chroma extraction, `--matte-color auto` samples the actual flat source background from the image edges. Prefer it when the source was AI-generated, because prompts like "pure #ff00ff" often produce near-matte colors rather than exact RGB values. Use explicit `--matte-color <name|#rrggbb>` only when the source background is known exactly.

For extraction tuning, use `--material` only as a broad hint, not as a subject classifier: `standard`, `soft-3d`, `flat-icon`, `sticker`, or `glow`. Manual `--threshold`, `--softness`, and `--spill-suppression` override the selected preset.

For style-locked transparent assets, `transparent generate` is prompt-only. Use a flat RGB reference image with `images edit --ref-image` to create a controlled matte source, then run `transparent extract`. Do not use a transparent PNG as the reference image unless you intentionally want the alpha/composited edge behavior to influence the edit.

Do not ask the image model to render exact UI text, numbers, scores, labels, or logos as part of the bitmap unless distorted text is acceptable. Generate the visual asset without text, then render exact text in the host app or design tool.

Examples:

```bash
# Simple asset: final transparent PNG, sources hidden unless there is a failure
$SKILL_CMD --json --json-events \
  transparent generate \
  --prompt "a polished fantasy sword game asset, no text, no frame" \
  --out /tmp/sword.png --size 2K --quality high

# Agent-controlled single-image cutout flow (`background-remove` first, chroma fallback)
$SKILL_CMD --json --json-events \
  images generate \
  --prompt "a silver necklace, centered, on a perfectly flat pure magenta background, no shadow" \
  --out /tmp/necklace-magenta.png --format png --size 2K
$SKILL_CMD --json \
  transparent extract --method auto \
  --input /tmp/necklace-magenta.png --matte-color auto \
  --out /tmp/necklace.png --material sticker --strict

# Semi-transparent material flow
$SKILL_CMD --json \
  transparent extract --method dual \
  --dark-image /tmp/glow-on-black.png \
  --light-image /tmp/glow-on-white.png \
  --out /tmp/glow.png --strict
```

Always inspect the JSON verification fields before delivery: `passed`, `alpha_min`, `alpha_max`, `transparent_ratio`, `partial_pixels`, and `warnings`. Also inspect quality fields: `checkerboard_detected`, `touches_edge`, `edge_margin_px`, `stray_pixel_count`, `largest_component_ratio`, `matte_residue_checked`, `matte_residue_score`, `halo_score`, `transparent_rgb_scrubbed`, `alpha_health_score`, `residue_score`, `quality_score`, and `failure_reasons`. If `passed` is false, do not deliver the file as a transparent PNG. If `matte_residue_checked` is false for a chroma-derived PNG, run `transparent verify` again with the source matte via `--expected-matte-color`.

For `transparent generate` and `transparent extract`, also inspect `selected_strategy` and `attempts` in JSON output. They tell you whether the final asset came from integrated `background-remove`, built-in chroma fallback, or dual extraction.

`transparent extract --method` now has explicit semantics:

- `auto` — prefer merged `background-remove`, then fallback to built-in chroma
- `rembg` — force merged `background-remove` only
- `chroma` — force built-in chroma only
- `dual` — force black/white dual-background extraction

For direct cutout tasks, prefer `transparent extract` over any legacy `background` examples unless you explicitly need a different local extraction strategy.

Direct-cutout error handling and retries:

- If `auto` leaves artifacts on a flat-matte image, retry with `--method chroma`.
- If the subject is translucent or glow-heavy, retry with `--method dual` using paired black/white renders.
- If an image is missing or corrupt, fix the input path before retrying.
- For arbitrary-photo cutouts where edge quality matters, inspect `warnings`, `matte_residue_score`, and `quality_score` before delivery.

## Notes

- `openai` defaults to `gpt-image-2`; `codex` defaults to `gpt-5.4` and delegates to `image_generation`.
- Shared options actually honored everywhere: `--size`, `--quality`, `--format`, `--compression`.
- OpenAI-only options: `--background`, `--n`, `--moderation`, `--mask`, `--input-fidelity`.
- Retries: up to 3 with exponential backoff (1s → 2s → 4s). Codex `401` triggers one token refresh + one retry.
- Size aliases: `1K`/`1024` → `1024x1024`, `2K` → `2048x2048`, `3K` → `3072x1728`, `4K` → `3840x2160`. Explicit `WxH` passes through unchanged after validation; oversized inputs such as `5K` or `5120*5120` are auto-shrunk to the nearest in-range `WxH` while preserving ratio as much as possible. Custom sizes still require both edges multiples of 16, max edge 3840, max 8,294,400 pixels, max aspect ratio 3:1.

## Reference files

Load on demand for deeper detail:

- `references/providers.md` — OpenAI / OpenAI-compatible / Codex selection, auth sources, runtime discovery, update policy, and resolution order.
- `references/sizes-and-formats.md` — size aliases, custom constraints, format/quality/compression/background, shared vs OpenAI-only flags.
- `references/transparent-png.md` — Agent playbook for prompt design, controlled mattes, dual-background extraction, verification, and retry loops.
- `references/json-output.md` — `--json` stdout schema, success and error envelopes, per-command shapes.
- `references/json-events.md` — `--json-events` JSONL phases (`request_started`, `multipart_prepared`, `retry_scheduled`) and Codex SSE passthrough.
- `references/troubleshooting.md` — install / command-not-found fixes, `auth_missing`, Codex `401` refresh, retry policy, size rejections, moderation, timeouts.
- `../../docs/planned-transparent-background-strategy.md` — planned deterministic matte-color selection and transparent-intent routing improvements.

## Codex compatibility

The companion file `agents/openai.yaml` is read by Codex Skill runtime only (Claude Code ignores it). Both runtimes execute the commands above with `cwd` at the skill directory, so the `SKILL_CMD` probe can safely decide between the checked-out local wrapper and the globally installed CLI.
