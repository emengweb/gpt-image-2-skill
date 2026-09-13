# Troubleshooting

Decision tree for the most common failures.

Let `{skill_root}` mean the absolute directory containing this skill's `SKILL.md`. Resolve `SKILL_DIR` once and always invoke the bundled launcher by absolute path; never use a globally installed CLI:

```bash
SKILL_DIR="{skill_root}"

node "$SKILL_DIR/scripts/gpt_image_2_skill.cjs" --json doctor
```

For direct cutout issues, also run `node "$SKILL_DIR/scripts/gpt_image_2_skill.cjs" --json background doctor` or `node "$SKILL_DIR/scripts/gpt_image_2_skill.cjs" --json background init` to confirm the merged background-removal runtime is available.

## Bundled runtime cannot start

The launcher at `{skill_root}/scripts/gpt_image_2_skill.cjs` is missing, incomplete, or its local dependencies are absent. The skill only runs this bundled launcher; it never falls back to a PATH or globally installed CLI.

Typical messages:

- `Bundled runtime dependencies are missing: pngjs, jpeg-js.`
- `Cannot find module 'pngjs'` (older copies of the launcher)
- `The bundled TypeScript runtime requires Node.js >= 22.18 ...`

Fixes:

- Initialize this skill copy's dependencies once (nothing is installed globally):

```bash
npm install --omit=dev --no-audit --no-fund --prefix "{skill_root}/scripts"
```

- Verify the runtime starts, then retry the original command:

```bash
node "{skill_root}/scripts/gpt_image_2_skill.cjs" --version
node "{skill_root}/scripts/gpt_image_2_skill.cjs" --json doctor
```

- If the message names a Node.js version, upgrade Node.js: the bundled TypeScript runtime requires Node.js >= 22.18 (the package `engines` field matches this requirement).
- If the launcher file itself is missing, reinstall or update the skill copy instead of installing a global CLI:

```bash
npx skills add https://github.com/emengweb/gpt-image-2-skill --skill gpt-image-2-skill --copy
```

The standalone npm CLI (the `gpt-image-2-skill` package installed globally) is a separate product for shell and automation users; the skill does not use it.

## Documented command is missing

If a command from the skill docs fails with `unrecognized subcommand`, treat it as a stale bundled runtime first.

Check the bundled runtime version and the upstream release:

```bash
node "$SKILL_DIR/scripts/gpt_image_2_skill.cjs" --version
npm view gpt-image-2-skill version
```

If the bundled runtime is older than this document, update the skill copy itself (re-run the `npx skills add ... --copy` command above) rather than installing a global CLI, then re-check:

```bash
node "$SKILL_DIR/scripts/gpt_image_2_skill.cjs" --version
node "$SKILL_DIR/scripts/gpt_image_2_skill.cjs" --json doctor
node "$SKILL_DIR/scripts/selftest.cjs"
```

## `auth_missing`

Provider auth absent for the resolved provider.

- OpenAI: export `OPENAI_API_KEY` or pass `--api-key sk-...`
- Codex: ensure `~/.codex/auth.json` exists. The Codex desktop app writes it on first sign-in. `$CODEX_HOME` overrides the directory.

Use `--json auth inspect` to see which provider has `ready: true`.

## Unknown or unsupported model

The runtime sends `model_resolution.resolved_model` as the request `model`. Upstream failures surface as `http_error` with a 400/404 body such as `model_not_found` or `unknown model`.

- Check what was actually sent: read `model_resolution` in the JSON result, or run `--json doctor`. `doctor` reports the routing defaults under `model_routing` and lists providers whose legacy `gpt-image-2` pin was dropped under `model_routing.legacy_model_pins`.
- Defaults are `gpt-image-2.5-flare` (generate) and `gpt-image-2.5-sunburst` (edit). A proxy or vendor endpoint that serves only another name must be pinned with `--model <name>` or `config add-provider --model <name>`.
- If an upstream still serves only the previous generation, pass `--model gpt-image-2` per call or re-pin the provider with `config add-provider --model gpt-image-2`.
- Config version 1 pinned `model: "gpt-image-2"` on providers; that legacy pin is dropped once when the config is migrated to version 2 so routing applies. A pin added afterwards (config version 2) is honored. See `references/providers.md`.

## `auth_parse_failed`

`auth.json` exists but cannot be parsed. Re-sign-in through Codex desktop, or restore a known-good `auth.json` from backup.

## Codex `401` and `refresh_failed`

A `401` from the Codex endpoint triggers exactly one access-token refresh against `https://auth.openai.com/oauth/token`, then one retry. If refresh itself fails:

- `refresh_failed` with `error.detail.error` containing the underlying message
- common causes: expired refresh token (re-sign-in needed), network blocked, OAuth server outage

## Retries and transient errors

The runtime retries up to `DEFAULT_RETRY_COUNT = 3` times with exponential backoff (`1s → 2s → 4s`). Non-retryable errors fail fast.

Watch retry behavior live with `--json-events` and grep stderr for `"phase":"retry_scheduled"`.

## Image-size rejections

`code: "invalid_argument"` with a size-related message means a custom `WIDTHxHEIGHT` violated one of:

- both edges multiples of 16
- max edge 3840
- max total pixels 8,294,400
- max aspect ratio 3:1

Use `2K` or `4K` aliases when in doubt.

## `transparent_verification_failed`

The transparent pipeline wrote an output image, but the final alpha gate did not pass. Do not deliver the file.

常见原因：

- 上游服务忽略了 `background: transparent`，返回了没有 alpha 的 PNG
- 主体接触图像边缘
- 检查器识别出棋盘格伪透明图
- 全透明像素仍包含不应保留的 RGB 值
- 严格 profile 与素材类型不匹配
- 对光效、烟雾或玻璃素材选择了单图抠图而不是双背景提取
- 黑白双背景源图没有对齐

处理方式：

- 原生透明失败时，先确认 provider 是否支持 `background: transparent`；兼容服务若不支持，改用 `images generate/edit` 生成 RGB 源图后再运行 `transparent extract`
- 对已有 AI 平面底图使用 `transparent extract --matte-color auto`，让 CLI 从边缘采样实际底色
- 根据素材选择 `--material soft-3d`、`flat-icon`、`sticker` 或 `glow`
- 半透明效果使用对齐的黑白源图，并显式运行 `transparent extract --method dual`
- 显式选择校验档位：`--profile icon`、`product`、`sticker`、`seal`、`translucent`、`glow`、`shadow` 或 `effect`
- 不要给 `transparent generate` 传 `--report-dir`、`--keep-sources`、`--matte-color` 等已移除的本地抠图参数
- pass `--expected-matte-color <color>` during verification when checking chroma residue
- always re-run `transparent verify --profile <profile> --strict` on the final PNG

Use `failure_reasons` from the JSON to pick the retry:

| Reason | Retry |
|---|---|
| `missing_alpha_channel` | run local extraction or reject provider-native transparency |
| `checkerboard_detected` | reject and regenerate with controlled matte |
| `subject_touches_edge` / `effect_touches_edge` | regenerate with larger margin |
| `matte_residue_too_high` | retry with `--matte-color auto`, then try a different source matte color |
| `profile_requires_partial_alpha` | use dual extraction or a translucent/glow/shadow source flow |
| `too_many_stray_pixels` | retry with cleaner matte, or use `sticker`, `seal`, or `effect` if multiple components are intentional |
| `transparent_rgb_not_scrubbed` | re-run extraction so transparent RGB is scrubbed |

## `transparent_input_mismatch`

Dual extraction requires black/white source images with identical dimensions. Regenerate both images with the same `--size`, or use reference-image editing to preserve alignment.

## `background remove` is not ready

The merged standalone background-removal workflow depends on local Python packages.

Checks:

- `node "$SKILL_DIR/scripts/gpt_image_2_skill.cjs" --json background doctor`
- `node "$SKILL_DIR/scripts/gpt_image_2_skill.cjs" --json background init`
- `node "$SKILL_DIR/scripts/gpt_image_2_skill.cjs" --json background doctor --fix`
- `node "$SKILL_DIR/scripts/gpt_image_2_skill.cjs" --json background init --install`

Typical fixes:

- install Python 3 if no Python runtime is detected
- `pip install Pillow`
- `pip install rembg[gpu]` or `pip install rembg`

Notes:

- `rembg` is optional for the fast built-in method, but `Pillow` is still required
- `numpy` is optional; the built-in fallback works without it, but may be slower
- Python packages are only auto-installed on explicit request through `--fix` or `--install`

## Moderation refusals (OpenAI)

OpenAI may reject prompts. The runtime surfaces the upstream error verbatim under `error.detail`. Adjust the prompt or set `--moderation low` (where supported by the account) and retry.

## Network and timeout

- `network_error` — transport-level failure (DNS, TLS, connection reset). Retried automatically.
- Hard timeout: `DEFAULT_REQUEST_TIMEOUT = 300s` for image requests, `DEFAULT_REFRESH_TIMEOUT = 60s` for token refresh.

## Self-test

Run the bundled self-test as a smoke check:

```bash
node "{skill_root}/scripts/selftest.cjs"
```

It calls `--json doctor` and `--json auth inspect`, then prints a one-line summary including which providers are ready.
