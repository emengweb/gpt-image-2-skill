---
name: gpt-image-2-skill
description: This skill should be used when the user asks to "generate an image", "create a logo", "draw an icon", "edit this photo", "change background to transparent", "remove background", "use GPT image", "use Codex to draw", "用 GPT image 生成图片", "用 Codex 画图", "帮我生成一张图", "改成透明背景", "把这张图编辑一下", or any prompt-to-image or reference-image-edit task that benefits from a structured CLI returning JSON results and JSONL progress events. Supports OpenAI `gpt-image-2` (via `OPENAI_API_KEY` or OpenAI-compatible base URL) and Codex `image_generation` (via `~/.codex/auth.json`) under one command surface, with masks, custom sizes up to 4K, transparent backgrounds, and a raw request escape hatch.
---

Run image generation and editing through one CLI surface that hides provider differences. The runtime in `scripts/` is now pure TypeScript plus a thin CJS launcher.

## Runtime advice

- If the system already has `bun`, prefer `bun` over `node` as the local runtime.
- If `scripts/node_modules` does not exist yet, treat this as first use and install the local script dependencies before invoking the skill.
- Prefer working from the checked-out skill directory instead of looking for an older globally installed CLI.

```bash
RUNNER=node
command -v bun >/dev/null 2>&1 && RUNNER=bun

test -d scripts/node_modules || {
  if [ "$RUNNER" = "bun" ]; then
    bun install --cwd scripts
  else
    npm install --prefix scripts --cache /private/tmp/gpt-image-2-skill-npm-cache
  fi
}
```

## When to use this skill

- Generate or edit an image and capture a structured result an agent can parse.
- Switch between `OPENAI_API_KEY`, an OpenAI-compatible base URL, and Codex `auth.json` without changing command shape.
- Respect shared provider config at `$CODEX_HOME/gpt-image-2-skill/config.json` so CLI, App, and Skill use the same default provider.
- Need final transparent PNG deliverables, masks, custom sizes up to 4K, or raw request bodies.
- Want live progress events (retries, multipart prep, Codex SSE) on stderr while the final JSON lands on stdout.

## Quick start

Always pass `--json` so the result is machine-readable. Add `--json-events` when progress visibility matters.

```bash
# 0. Pick a runtime
RUNNER=node
command -v bun >/dev/null 2>&1 && RUNNER=bun

# 1. Confirm runtime + provider readiness
$RUNNER scripts/gpt_image_2_skill.cjs --json config inspect
$RUNNER scripts/gpt_image_2_skill.cjs --json doctor
$RUNNER scripts/gpt_image_2_skill.cjs --json auth inspect

# 2. Generate a final transparent PNG deliverable
$RUNNER scripts/gpt_image_2_skill.cjs --json --json-events \
  transparent generate --prompt "..." --out /tmp/asset.png \
  --size 2K --quality high

# 3. Generate a normal image (auto-selects provider; OpenAI first, then Codex)
$RUNNER scripts/gpt_image_2_skill.cjs --json --json-events \
  images generate --prompt "..." --out /tmp/out.png \
  --format png --size 2K

# 4. Edit a reference image (OpenAI multipart)
$RUNNER scripts/gpt_image_2_skill.cjs --json --json-events \
  images edit --prompt "..." --ref-image /tmp/in.png --out /tmp/out.png

# 5. Remove a controlled background from existing source images
$RUNNER scripts/gpt_image_2_skill.cjs --json \
  transparent extract --input /tmp/source-green.png --out /tmp/asset.png \
  --method chroma --matte-color auto --strict

# 6. Verify the final file before delivery
$RUNNER scripts/gpt_image_2_skill.cjs --json \
  transparent verify --input /tmp/asset.png --profile icon --strict

# 7. Raw request escape hatch
$RUNNER scripts/gpt_image_2_skill.cjs --json \
  request create --request-operation generate \
  --body-file /tmp/body.json --out-image /tmp/out.png --expect-image

# 8. Self-test (calls doctor + auth inspect)
$RUNNER scripts/selftest.cjs
```

Force a provider with `--provider openai`, `--provider codex`, or any named provider from `config inspect`; leave the default `--provider auto` to use `default_provider` first. Override the legacy OpenAI base URL with `--openai-api-base https://...`.

## Runtime consistency check

Before using newly documented command groups, especially `transparent generate`, `transparent extract`, or `transparent verify`, confirm the local script runtime is ready:

```bash
RUNNER=node
command -v bun >/dev/null 2>&1 && RUNNER=bun

test -d scripts/node_modules || {
  if [ "$RUNNER" = "bun" ]; then
    bun install --cwd scripts
  else
    npm install --prefix scripts --cache /private/tmp/gpt-image-2-skill-npm-cache
  fi
}

$RUNNER scripts/gpt_image_2_skill.cjs --json doctor
$RUNNER scripts/selftest.cjs
```

If a documented subcommand fails unexpectedly, diagnose local dependency drift in `scripts/node_modules` first rather than checking for old Rust sidecars or globally installed CLI binaries.

## Shared config

Use the CLI config surface when the user asks to add or pin a provider:

```bash
RUNNER=node
command -v bun >/dev/null 2>&1 && RUNNER=bun

$RUNNER scripts/gpt_image_2_skill.cjs --json config path
$RUNNER scripts/gpt_image_2_skill.cjs --json config add-provider \
  --name my-image-api \
  --type openai-compatible \
  --api-base https://example.com/v1 \
  --api-key sk-... \
  --set-default
$RUNNER scripts/gpt_image_2_skill.cjs --json config test-provider my-image-api
```

Credential sources supported by CLI, App, and Skill: `file`, `env`, and `keychain`. File credentials are stored in the shared config file; JSON output redacts them.

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

- `transparent generate` — prompt-to-final PNG. It generates a controlled matte source, extracts alpha locally, verifies the result, and only succeeds when the final PNG passes transparency checks.
- `transparent extract` — local background removal from controlled source images you generated yourself. It is not a general-purpose background remover for arbitrary photos.
- `transparent verify` — final gate for any PNG before delivery. Use `--strict` and the right `--profile` when the file must be accepted or fail the task.

A transparent deliverable is valid only if the final file has a real PNG alpha channel and passes verification. A visual appearance of transparency, a white background, or a checkerboard pattern is not sufficient.

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
| Opaque object, icon, sticker, product | Single isolated subject, clear margin, perfectly flat chroma matte. Pick a matte color absent from the object. | `transparent generate` or `transparent extract --method chroma --matte-color auto` |
| Thin edges, hair, fur, lace, chain, netting | Use high resolution, strong subject/background contrast, no contact shadow, no background-colored details. Try magenta/cyan/green mattes if one contaminates the edge. | Chroma extraction with `--spill-suppression` when needed, then verify with `--expected-matte-color`; retry with a different matte if residue remains. |
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
$RUNNER scripts/gpt_image_2_skill.cjs --json --json-events \
  transparent generate \
  --prompt "a polished fantasy sword game asset, no text, no frame" \
  --out /tmp/sword.png --size 2K --quality high

# Agent-controlled chroma flow
$RUNNER scripts/gpt_image_2_skill.cjs --json --json-events \
  images generate \
  --prompt "a silver necklace, centered, on a perfectly flat pure magenta background, no shadow" \
  --out /tmp/necklace-magenta.png --format png --size 2K
$RUNNER scripts/gpt_image_2_skill.cjs --json \
  transparent extract --method chroma \
  --input /tmp/necklace-magenta.png --matte-color auto \
  --out /tmp/necklace.png --material sticker --strict

# Semi-transparent material flow
$RUNNER scripts/gpt_image_2_skill.cjs --json \
  transparent extract --method dual \
  --dark-image /tmp/glow-on-black.png \
  --light-image /tmp/glow-on-white.png \
  --out /tmp/glow.png --strict
```

Always inspect the JSON verification fields before delivery: `passed`, `alpha_min`, `alpha_max`, `transparent_ratio`, `partial_pixels`, and `warnings`. Also inspect quality fields: `checkerboard_detected`, `touches_edge`, `edge_margin_px`, `stray_pixel_count`, `largest_component_ratio`, `matte_residue_checked`, `matte_residue_score`, `halo_score`, `transparent_rgb_scrubbed`, `alpha_health_score`, `residue_score`, `quality_score`, and `failure_reasons`. If `passed` is false, do not deliver the file as a transparent PNG. If `matte_residue_checked` is false for a chroma-derived PNG, run `transparent verify` again with the source matte via `--expected-matte-color`.

## Notes

- `openai` defaults to `gpt-image-2`; `codex` defaults to `gpt-5.4` and delegates to `image_generation`.
- Shared options actually honored everywhere: `--size`, `--quality`, `--format`, `--compression`.
- OpenAI-only options: `--background`, `--n`, `--moderation`, `--mask`, `--input-fidelity`.
- Retries: up to 3 with exponential backoff (1s → 2s → 4s). Codex `401` triggers one token refresh + one retry.
- Size aliases: `2K` → `2048x2048`, `4K` → `3840x2160`. Custom `WxH` requires both edges multiples of 16, max edge 3840, max 8,294,400 pixels, max aspect ratio 3:1.

## Reference files

Load on demand for deeper detail:

- `references/providers.md` — OpenAI / OpenAI-compatible / Codex selection, auth sources, runtime discovery, update policy, and resolution order.
- `references/sizes-and-formats.md` — size aliases, custom constraints, format/quality/compression/background, shared vs OpenAI-only flags.
- `references/transparent-png.md` — Agent playbook for prompt design, controlled mattes, dual-background extraction, verification, and retry loops.
- `references/json-output.md` — `--json` stdout schema, success and error envelopes, per-command shapes.
- `references/json-events.md` — `--json-events` JSONL phases (`request_started`, `multipart_prepared`, `retry_scheduled`) and Codex SSE passthrough.
- `references/troubleshooting.md` — `runtime_unavailable`, `auth_missing`, Codex `401` refresh, retry policy, size rejections, moderation, timeouts.

## Codex compatibility

The companion file `agents/openai.yaml` is read by Codex Skill runtime only (Claude Code ignores it). Both runtimes execute the commands above with `cwd` at the skill directory, so relative paths like `scripts/gpt_image_2_skill.cjs` resolve in either harness.
