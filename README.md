# gpt-image-2-skill

<p align="center">
  <img src="https://raw.githubusercontent.com/emengweb/gpt-image-2-skill/main/assets/logo.png" width="160" alt="gpt-image-2-skill logo">
</p>

[![GitHub Release](https://img.shields.io/github/v/release/emengweb/gpt-image-2-skill)](https://github.com/emengweb/gpt-image-2-skill/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/emengweb/gpt-image-2-skill/release-candidate.yml?branch=main&label=release-candidate)](https://github.com/emengweb/gpt-image-2-skill/actions/workflows/release-candidate.yml)
[![License](https://img.shields.io/github/license/emengweb/gpt-image-2-skill)](https://github.com/emengweb/gpt-image-2-skill/blob/main/LICENSE)
[![npm](https://img.shields.io/badge/npm-package-CB3837?logo=npm&logoColor=white)](https://www.npmjs.com/package/gpt-image-2-skill)

**Language: 中文 | [English](#english)**

> 本项目基于源项目 [Wangnov/gpt-image-2-skill](https://github.com/Wangnov/gpt-image-2-skill) 修改而来。
>
> 当前仓库已经移除 Rust/Tauri 运行时，CLI、Skill 与 Web 界面统一为纯 TypeScript 实现。

面向 AI Agent 与 Web 用户的 GPT Image 2 CLI、Skill 和静态前端。一个纯 TypeScript 运行核心同时支持 `OPENAI_API_KEY`、通过 `OPENAI_API_BASE` 或 provider 配置指定的 OpenAI-compatible 服务端，以及 Codex `~/.codex/auth.json` 图片链路。CLI 与 Skill 共用 `$CODEX_HOME/gpt-image-2-skill/config.json`。

## 功能特性

- `images generate`、`images edit`、`transparent generate/extract/verify`、`background remove/doctor/init`、`request create`
- 双模型档位路由：默认生图使用速度优先的 `gpt-image-2.5-flare`，参考图编辑默认使用精度优先的 `gpt-image-2.5-sunburst`；`--model <名称>` 支持任意自定义模型名，`--tier speed|precision` 可按用途切换
- OpenAI 与兼容服务端，支持自定义 base URL 与 provider 配置
- Codex `auth.json` 图片链路，默认编排模型 `gpt-5.4`
- `--json` stdout 结果与 `--json-events` stderr JSONL 进度事件
- 透明 PNG 原生生成：`transparent generate` 直接请求上游透明背景并校验 alpha；已有图片仍可用 `transparent extract` 做本地抠图
- 透明 PNG 验证、尺寸别名与共享配置
- React Web 前端位于 `apps/gpt-image-2-app`
- Cloudflare relay Worker 位于 `workers/gpt-image-2-relay`

## 安装

```bash
npm install --global gpt-image-2-skill
```

本地开发安装：

```bash
just install-local
```

## 快速开始

OpenAI API Key 直连：

```bash
OPENAI_API_KEY=sk-... gpt-image-2-skill --json \
  images generate \
  --prompt "A studio product photo of a red apple on transparent background" \
  --out ./apple.png \
  --background transparent \
  --format png \
  --quality high \
  --size 1024x1024
```

OpenAI-compatible Base URL：

```bash
OPENAI_API_KEY=sk-... OPENAI_API_BASE=https://example.com/v1 \
gpt-image-2-skill --json \
  --provider openai \
  images generate \
  --prompt "A polished geometric app logo on transparent background" \
  --out ./logo.png \
  --background transparent \
  --format png \
  --size 2K
```

Codex `auth.json` 生图：

```bash
gpt-image-2-skill --json --json-events \
  --provider codex \
  images generate \
  --prompt "A glossy red apple sticker on transparent background" \
  --out ./apple.png
```

模型档位（`--model` / `--tier`）：

- 默认路由：`images generate` 与 `transparent generate` 使用速度优先的 `gpt-image-2.5-flare`；`images edit`（基于参考图的编辑）使用精度优先的 `gpt-image-2.5-sunburst`。
- 显式切换：`--tier precision` 提升到精度档，`--tier speed` 回到速度档，`--model <名称>` 直接指定任意模型（`flare` / `sunburst` 为短别名）。
- 优先级：`--model` > `--tier` > provider 配置里的 `model` > 操作默认。
- 结果里的 `model_resolution` 会回显 `resolved_model`、`source`、`tier` 与 `reason`，`doctor` 输出 `model_routing` 默认值。

```bash
# 日常批量出图：默认 flare
gpt-image-2-skill --json images generate --prompt "flat icon set, no text" --out ./icons/1.png

# 广告成品图精修：显式精度档
gpt-image-2-skill --json images edit --ref-image ./draft.png --prompt "keep layout, refine typography and lighting" --out ./final.png --tier precision

# 指定自定义或旧版模型名
gpt-image-2-skill --json images generate --prompt "hero banner" --out ./hero.png --model gpt-image-2
```

历史配置迁移：旧版本会把 `model: "gpt-image-2"` 写进 provider 配置（配置版本 1），该固定值遮蔽了档位路由；配置读取时会一次性迁移到版本 2 并清除这个旧默认值（`doctor` 的 `model_routing.legacy_model_pins` 会列出受影响的 provider）。迁移后写入的固定值会被保留，因此需要旧模型时用 `config add-provider --model gpt-image-2` 重新固定，或每次调用显式传 `--model gpt-image-2`。

透明 PNG 工作流说明：

- `transparent generate` 直接发送上游原生透明参数并输出 PNG，只做最终 alpha 校验，不生成受控底图，也不调用本地抠图。
- `transparent extract --method auto` 用于已有图片，优先走 `background-remove`，失败再回退到本地 chroma/dual 抠图逻辑。
- `transparent extract --method rembg` 表示强制只走融合后的 `background-remove`；`--method chroma` 表示强制只走本地 chroma。
- `transparent generate` 的 JSON 输出包含 `transparency_mode: "upstream-native"`；`selected_strategy` 与 `attempts` 仅适用于 `transparent extract`。

独立抠图与初始化说明：

- `background doctor` 用于检查 Python、`rembg`、`Pillow`、脚本是否齐备。
- `background init` 用于返回当前环境是否已经可用以及下一步安装提示。
- `background remove` 用于单图或批量抠图，完整保留 `background-remove` 的独立使用方式。

```bash
gpt-image-2-skill --json background doctor
gpt-image-2-skill --json background init
gpt-image-2-skill --json background remove --input ./photo.jpg --output ./photo_nobg.png
gpt-image-2-skill --json background remove --input ./a.png ./b.png --output ./out --method builtin
```

**Profile**(`--profile`,验证用)— 决定质量门严格度:

| Profile | 适用 | 额外严格项 |
|---|---|---|
| `generic` | 未知或不规则素材 | PNG alpha、真实透明区、棋盘格拒绝 |
| `icon` | 干净的单主体 icon、道具 | 干净不透明核心、足够边距、低杂散像素 |
| `product` | 产品 / 物体抠图 | 干净不透明核心、足够边距、低残留 |
| `sticker` | 贴纸、徽章、多组件道具 | 比 `icon` 更宽容多组件 |
| `seal` | 印章、徽章、含内嵌符号的 logo | 允许圆环 + 中心符号这类分裂组件 |
| `translucent` | 玻璃、液体、晶体 | 要求 partial alpha;alpha max 不必 255 |
| `glow` | 光带、火焰、烟雾、粒子 | 要求 partial alpha 与透明边距 |
| `shadow` | 软阴影 | 要求 partial alpha 与透明边距 |
| `effect` | 硬 alpha 粒子、爆发、UI 特效 | 要求透明边距,但不强制 partial alpha |

**Material preset**(`--material`,chroma extract 用)— 调 chroma `threshold` / `softness` / `spill_suppression`:`standard` / `soft-3d` / `flat-icon` / `sticker` / `glow`,手动 flag 可继续覆盖。

**Verify 输出关键字段**:`passed`、`alpha_min/alpha_max`、`transparent_ratio`、`partial_pixels`、`checkerboard_detected`、`touches_edge`、`stray_pixel_count`、`matte_residue_score`、`halo_score`、`transparent_rgb_scrubbed`、`alpha_health_score`、`residue_score`、`quality_score`、`failure_reasons`、`warnings`。完整字段表见 [`skills/gpt-image-2-skill/references/transparent-png.md`](skills/gpt-image-2-skill/references/transparent-png.md)。

## Skill 安装

```bash
npx skills add https://github.com/emengweb/gpt-image-2-skill --skill gpt-image-2-skill
```

Skill 推荐优先使用已安装的全局 `gpt-image-2-skill` CLI。若全局 CLI 不存在，可直接安装 npm 包；仓库内调试时也可以直接运行 `node skills/gpt-image-2-skill/scripts/gpt_image_2_skill.cjs`。

## 本地开发

```bash
just test
just app-typecheck
just app-test-browser
just relay-test
just dev-frontend
```

版本同步与发布脚本位于 `scripts/release/`，现在基于 npm 包 `skills/gpt-image-2-skill/scripts/package.json` 作为版本源。

未来待实现能力说明见 [docs/planned-transparent-background-strategy.md](/Users/emengweb/Documents/Project/gpt-image-2-skill/docs/planned-transparent-background-strategy.md)。

## 仓库结构

- `skills/gpt-image-2-skill/`：Skill 定义、CLI runtime、参考文档
- `apps/gpt-image-2-app/`：纯 TypeScript React Web 前端
- `workers/gpt-image-2-relay/`：Cloudflare relay Worker
- `scripts/`：同步、冒烟、发布辅助脚本

## English

Pure TypeScript GPT Image 2 CLI, Skill, and web UI. The repository no longer ships Rust/Tauri runtime code; the shared runtime lives under `skills/gpt-image-2-skill/scripts` and is published directly as the `gpt-image-2-skill` npm package.

Install:

```bash
npm install --global gpt-image-2-skill
```

Useful local commands:

```bash
just test
just app-typecheck
just app-test-browser
just relay-test
just dev-frontend
```
