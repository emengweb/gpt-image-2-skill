# Planned Capability: Transparent Matte Strategy

This document records the next-step capability planned for `transparent generate` and related transparent PNG workflows.

## Goal

Replace the current fixed fallback matte color strategy with a smarter, deterministic, code-only policy that keeps transparent extraction stable without violating user intent.

## Why this is planned

- `background-remove` is now the primary cutout path, so transparent workflows no longer depend on a single hard-coded chroma color.
- The existing built-in chroma fallback still benefits from a flat, high-contrast source background.
- A fixed matte such as pure green is unnecessarily rigid and may conflict with prompt content more often than needed.

## Planned design

### 1. Separate final intent from intermediate extraction setup

- `final_background_intent`
  Used for what the user actually wants to receive.
- `intermediate_extraction_background`
  Used only for the internally generated source image that will later be cut out.

This separation lets the runtime preserve transparent delivery goals while still generating a source image that is easier to process.

### 2. Only override prompt background when transparent delivery is the real goal

- If the user explicitly wants a transparent PNG, remove background, or cutout deliverable, the runtime may rewrite the source-background instruction used during internal generation.
- If the user explicitly wants a white, blue, or otherwise non-transparent final background, the runtime should not force the transparent pipeline.
- If both appear together, transparent delivery remains higher priority only when it is clearly the requested output format.

### 3. Replace fixed matte color with deterministic safe-color selection

Use a code-only chooser rather than another AI call.

Initial safe palette:

- `magenta`
- `cyan`
- `blue`
- `green`
- `black`
- `white`

Selection rules should be deterministic and reproducible.

### 4. Add prompt-level color avoidance rules

The chooser should avoid colors already likely to appear in the subject or user-specified scene details.

Examples:

- avoid green for leaves, grass, frogs, emerald products
- avoid white for snow, milk, white plush, white packaging
- avoid black for smoke, dark silhouettes, black fashion items

### 5. Bias by asset family when useful

- glow, smoke, flame, particles: prefer black or white when it improves contrast
- icon, sticker, product, toy, figurine: prefer saturated flat colors first
- unknown assets: use the highest-confidence safe color after prompt avoidance

### 6. Retry policy

If the selected primary path still fails:

- keep the generated source when diagnostics are requested
- switch to a second safe matte candidate
- retry local chroma fallback once before giving up

### 7. JSON observability

Expose the choice so the agent can reason about it:

- requested transparent intent
- selected intermediate matte color
- reason or rule bucket for the choice
- retry history if a second matte was attempted

## Non-goals for the first implementation

- no extra LLM call for color selection
- no image-semantic classifier
- no pixel-level pre-analysis before the first source image is generated

## First implementation checklist

- add a deterministic `chooseMatteColor(prompt, profile)` helper
- wire it into `transparent generate`
- preserve manual `--matte-color` as the highest-priority override
- report the selected matte and strategy in JSON output
- add tests for prompt color avoidance and retry ordering
