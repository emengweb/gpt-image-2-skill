import fs from "node:fs";
import { createRequire } from "node:module";
import { CliError } from "./errors.ts";
import { ensureParentDir } from "./fs-helpers.ts";

const require = createRequire(import.meta.url);
const { PNG } = require("pngjs") as typeof import("pngjs");
const jpeg = require("jpeg-js") as typeof import("jpeg-js");

const DEFAULT_CHROMA_THRESHOLD = 28;
const DEFAULT_CHROMA_SOFTNESS = 34;
const DEFAULT_SPILL_SUPPRESSION = 0.85;
const TRANSPARENT_ALPHA_MAX = 5;
const NONTRANSPARENT_ALPHA_MIN = 20;
const MIN_TRANSPARENT_RATIO = 0.005;
const STRICT_MIN_TRANSPARENT_RATIO = 0.05;
const MIN_OPAQUE_ALPHA = 250;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export type TransparentProfile =
  | "generic"
  | "icon"
  | "product"
  | "sticker"
  | "seal"
  | "translucent"
  | "glow"
  | "shadow"
  | "effect";

export type TransparentMaterial = "standard" | "soft-3d" | "flat-icon" | "sticker" | "glow";

type ChromaSettings = {
  threshold: number;
  softness: number;
  spill_suppression: number;
  material: TransparentMaterial | null;
};

export type VerificationOptions = {
  profile?: TransparentProfile;
  expectedMatteColor?: string | null;
};

export type ExtractionReport = {
  method: "chroma" | "dual";
  inputs: Record<string, unknown>;
  output: {
    path: string;
    bytes: number;
    files: Array<{ index: number; path: string; bytes: number }>;
  };
  matte_color: string | null;
  matte_color_source: string | null;
  threshold: number | null;
  softness: number | null;
  spill_suppression: number | null;
  material: string | null;
  matte_decontamination_applied: boolean;
  rgb_scrubbed: boolean;
  dual_alignment: {
    score: number;
    passed: boolean;
    negative_delta_ratio: number;
    delta_channel_noise: number;
    color_space: string;
  } | null;
};

export type TransparentVerification = {
  path: string;
  profile: TransparentProfile;
  width: number;
  height: number;
  is_png: boolean;
  color_type: string;
  has_alpha: boolean;
  input_has_alpha: boolean;
  alpha_min: number;
  alpha_max: number;
  transparent_pixels: number;
  partial_pixels: number;
  opaque_pixels: number;
  nontransparent_pixels: number;
  transparent_ratio: number;
  partial_ratio: number;
  opaque_ratio: number;
  edge_nontransparent_pixels: number;
  edge_nontransparent_ratio: number;
  touches_edge: boolean;
  edge_margin_px: number | null;
  component_count: number;
  largest_component_pixels: number;
  largest_component_ratio: number;
  stray_pixel_count: number;
  alpha_noise_score: number;
  matte_residue_score: number | null;
  matte_residue_checked: boolean;
  halo_score: number;
  transparent_rgb_scrubbed: boolean;
  checkerboard_detected: boolean;
  alpha_health_score: number;
  residue_score: number;
  quality_score: number;
  bbox: { x: number; y: number; width: number; height: number } | null;
  passed: boolean;
  failure_reasons: string[];
  warnings: string[];
};

type LoadedImage = {
  width: number;
  height: number;
  data: Uint8Array;
  format: "png" | "jpeg" | "unknown";
  colorType: string;
  hasAlpha: boolean;
};

export function resolveChromaSettings(
  material?: string | null,
  threshold?: number,
  softness?: number,
  spillSuppression?: number,
): ChromaSettings {
  const normalized = normalizeMaterial(material);
  const preset = chromaPreset(normalized);
  return {
    threshold: threshold ?? preset.threshold,
    softness: softness ?? preset.softness,
    spill_suppression: spillSuppression ?? preset.spill_suppression,
    material: normalized,
  };
}

export function parseMatteColorOrAuto(value?: string | null) {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (["auto", "sample", "auto-sample", "auto_sample"].includes(normalized)) {
    return null;
  }
  return parseMatteColor(value);
}

export function parseMatteColor(value: string) {
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "black":
      return [0, 0, 0] as const;
    case "white":
      return [255, 255, 255] as const;
    case "green":
    case "chroma-green":
      return [0, 255, 0] as const;
    case "magenta":
      return [255, 0, 255] as const;
    case "cyan":
      return [0, 255, 255] as const;
    case "blue":
      return [0, 0, 255] as const;
    default:
      break;
  }
  const hex = normalized.startsWith("#") ? normalized.slice(1) : normalized;
  if (!/^[0-9a-f]{6}$/.test(hex)) {
    throw new CliError("invalid_argument", "Matte color must be a named color or #RRGGBB.", {
      value,
    });
  }
  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
  ] as const;
}

export function controlledMattePrompt(prompt: string, matte: string) {
  const color = colorToHex(parseMatteColor(matte));
  return `${prompt}\n\nExtraction setup: render exactly one isolated asset, centered with a clear margin, on a perfectly flat uniform matte background of pure ${color}. Do not use gradients, texture, vignette, shadows, reflections, contact shadows, scenery, props, labels, frames, or background-colored details. Keep the full subject visible and separated from the matte.`;
}

export function extractChromaFile(inputPath: string, outputPath: string, matteColor: string | null, settings: ChromaSettings): ExtractionReport {
  const image = loadImage(inputPath);
  const matte = matteColor ? parseMatteColor(matteColor) : estimateMatteColor(image);
  const matteSource = matteColor ? "provided" : "auto-sampled";
  const output = extractChroma(image, matte, settings.threshold, settings.softness, settings.spill_suppression);
  scrubTransparentRgb(output);
  writePng(normalizePngOutputPath(outputPath), output);
  return {
    method: "chroma",
    inputs: { input: inputPath },
    output: outputFileValue(normalizePngOutputPath(outputPath)),
    matte_color: colorToHex(matte),
    matte_color_source: matteSource,
    threshold: settings.threshold,
    softness: settings.softness,
    spill_suppression: settings.spill_suppression,
    material: settings.material,
    matte_decontamination_applied: true,
    rgb_scrubbed: true,
    dual_alignment: null,
  };
}

export function extractDualFile(darkPath: string, lightPath: string, outputPath: string): ExtractionReport {
  const dark = loadImage(darkPath);
  const light = loadImage(lightPath);
  if (dark.width !== light.width || dark.height !== light.height) {
    throw new CliError(
      "transparent_input_mismatch",
      "Dual-background images must have identical dimensions.",
      {
        dark_image: darkPath,
        light_image: lightPath,
        dark_size: { width: dark.width, height: dark.height },
        light_size: { width: light.width, height: light.height },
      },
    );
  }
  const alignment = dualAlignmentReport(dark, light);
  const output = extractDual(dark, light);
  scrubTransparentRgb(output);
  writePng(normalizePngOutputPath(outputPath), output);
  return {
    method: "dual",
    inputs: { dark_image: darkPath, light_image: lightPath },
    output: outputFileValue(normalizePngOutputPath(outputPath)),
    matte_color: null,
    matte_color_source: null,
    threshold: null,
    softness: null,
    spill_suppression: null,
    material: null,
    matte_decontamination_applied: false,
    rgb_scrubbed: true,
    dual_alignment: alignment,
  };
}

export function verifyTransparentFile(path: string, options: VerificationOptions = {}): TransparentVerification {
  const image = loadImage(path);
  const profile = normalizeProfile(options.profile);
  const expectedMatte = options.expectedMatteColor ? parseMatteColor(options.expectedMatteColor) : null;
  const total = image.width * image.height;
  let alphaMin = 255;
  let alphaMax = 0;
  let transparentPixels = 0;
  let partialPixels = 0;
  let opaquePixels = 0;
  let nontransparentPixels = 0;
  let edgeNontransparentPixels = 0;
  let minX = image.width;
  let minY = image.height;
  let maxX = 0;
  let maxY = 0;
  forEachPixel(image, (x, y, rgba) => {
    const alpha = rgba[3];
    alphaMin = Math.min(alphaMin, alpha);
    alphaMax = Math.max(alphaMax, alpha);
    if (alpha <= TRANSPARENT_ALPHA_MAX) {
      transparentPixels += 1;
      return;
    }
    nontransparentPixels += 1;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    if (x === 0 || y === 0 || x + 1 === image.width || y + 1 === image.height) {
      edgeNontransparentPixels += 1;
    }
    if (alpha >= MIN_OPAQUE_ALPHA) opaquePixels += 1;
    else partialPixels += 1;
  });
  const transparentRatio = ratio(transparentPixels, total);
  const partialRatio = ratio(partialPixels, total);
  const opaqueRatio = ratio(opaquePixels, total);
  const edgePixels =
    image.width === 0 || image.height === 0
      ? 0
      : image.width === 1 || image.height === 1
        ? total
        : image.width * 2 + (image.height - 2) * 2;
  const edgeNontransparentRatio = ratio(edgeNontransparentPixels, edgePixels);
  const bbox =
    nontransparentPixels === 0
      ? null
      : {
          x: minX,
          y: minY,
          width: maxX - minX + 1,
          height: maxY - minY + 1,
        };
  const edgeMarginPx =
    bbox === null
      ? null
      : Math.min(
          bbox.x,
          bbox.y,
          image.width - (bbox.x + bbox.width),
          image.height - (bbox.y + bbox.height),
        );
  const touchesEdge = edgeMarginPx === 0;
  const component = componentStats(image);
  const transparentRgb = transparentRgbScrubbed(image);
  const matteResidueChecked = expectedMatte !== null;
  const matteResidueScoreValue = expectedMatte ? matteResidueScore(image, expectedMatte) : null;
  const halo = haloScore(image);
  const checkerboard = (!image.hasAlpha || transparentRatio < MIN_TRANSPARENT_RATIO) && detectCheckerboard(image);
  const warnings: string[] = [];
  if (touchesEdge || edgeNontransparentRatio > 0.15) {
    warnings.push("nontransparent pixels reach the image edge; consider adding margin before extraction");
  }
  if (partialPixels === 0) {
    warnings.push("no semi-transparent pixels detected");
  }
  if (checkerboard) {
    warnings.push("checkerboard-like pattern detected; visual transparency is not enough");
  }
  if (!transparentRgb) {
    warnings.push("fully transparent pixels contain non-zero RGB values; scrub them to avoid compositing artifacts");
  }
  if (matteResidueScoreValue !== null && matteResidueScoreValue > 0.12) {
    warnings.push("possible matte-color residue on semi-transparent edge pixels");
  }
  if (
    !matteResidueChecked &&
    ["icon", "product", "sticker", "seal"].includes(profile) &&
    partialPixels > 0
  ) {
    warnings.push("matte residue was not checked; pass --expected-matte-color when verifying chroma outputs");
  }
  const gate = evaluateTransparencyGate({
    profile,
    is_png: image.format === "png",
    has_alpha: image.hasAlpha,
    alpha_min: alphaMin,
    alpha_max: alphaMax,
    nontransparent_pixels: nontransparentPixels,
    transparent_ratio: transparentRatio,
    partial_pixels: partialPixels,
    touches_edge: touchesEdge,
    largest_component_ratio: component.largest_component_ratio,
    alpha_noise_score: component.alpha_noise_score,
    matte_residue_score: matteResidueScoreValue,
    checkerboard_detected: checkerboard,
    transparent_rgb_scrubbed: transparentRgb,
  });
  const alphaHealth = alphaHealthScore({
    is_png: image.format === "png",
    has_alpha: image.hasAlpha,
    alpha_min: alphaMin,
    alpha_max: alphaMax,
    nontransparent_pixels: nontransparentPixels,
    transparent_ratio: transparentRatio,
    checkerboard_detected: checkerboard,
    transparent_rgb_scrubbed: transparentRgb,
  });
  const residue = residueScore(component.alpha_noise_score, matteResidueScoreValue, halo, touchesEdge);
  const quality = qualityScore(
    gate.passed,
    touchesEdge,
    component.alpha_noise_score,
    matteResidueScoreValue,
    halo,
    checkerboard,
    transparentRgb,
  );
  return {
    path,
    profile,
    width: image.width,
    height: image.height,
    is_png: image.format === "png",
    color_type: image.colorType,
    has_alpha: image.hasAlpha,
    input_has_alpha: image.hasAlpha,
    alpha_min: alphaMin,
    alpha_max: alphaMax,
    transparent_pixels: transparentPixels,
    partial_pixels: partialPixels,
    opaque_pixels: opaquePixels,
    nontransparent_pixels: nontransparentPixels,
    transparent_ratio: transparentRatio,
    partial_ratio: partialRatio,
    opaque_ratio: opaqueRatio,
    edge_nontransparent_pixels: edgeNontransparentPixels,
    edge_nontransparent_ratio: edgeNontransparentRatio,
    touches_edge: touchesEdge,
    edge_margin_px: edgeMarginPx,
    component_count: component.component_count,
    largest_component_pixels: component.largest_component_pixels,
    largest_component_ratio: component.largest_component_ratio,
    stray_pixel_count: component.stray_pixel_count,
    alpha_noise_score: component.alpha_noise_score,
    matte_residue_score: matteResidueScoreValue,
    matte_residue_checked: matteResidueChecked,
    halo_score: halo,
    transparent_rgb_scrubbed: transparentRgb,
    checkerboard_detected: checkerboard,
    alpha_health_score: alphaHealth,
    residue_score: residue,
    quality_score: quality,
    bbox,
    passed: gate.passed,
    failure_reasons: gate.failure_reasons,
    warnings,
  };
}

export function normalizePngOutputPath(filePath: string) {
  return filePath.toLowerCase().endsWith(".png") ? filePath : `${filePath}.png`;
}

function normalizeProfile(profile?: string): TransparentProfile {
  const value = (profile ?? "generic").toLowerCase();
  const known: TransparentProfile[] = [
    "generic",
    "icon",
    "product",
    "sticker",
    "seal",
    "translucent",
    "glow",
    "shadow",
    "effect",
  ];
  return known.includes(value as TransparentProfile) ? (value as TransparentProfile) : "generic";
}

function normalizeMaterial(material?: string | null): TransparentMaterial | null {
  const value = material?.trim().toLowerCase();
  if (!value) return null;
  if (value === "soft3d") return "soft-3d";
  const known: TransparentMaterial[] = ["standard", "soft-3d", "flat-icon", "sticker", "glow"];
  return known.includes(value as TransparentMaterial) ? (value as TransparentMaterial) : null;
}

function chromaPreset(material: TransparentMaterial | null): ChromaSettings {
  switch (material) {
    case "soft-3d":
      return { threshold: 60, softness: 40, spill_suppression: 0.2, material };
    case "flat-icon":
      return { threshold: 32, softness: 28, spill_suppression: 0.75, material };
    case "sticker":
      return { threshold: 45, softness: 38, spill_suppression: 0.45, material };
    case "glow":
      return { threshold: 18, softness: 62, spill_suppression: 0.15, material };
    case "standard":
    case null:
    default:
      return {
        threshold: DEFAULT_CHROMA_THRESHOLD,
        softness: DEFAULT_CHROMA_SOFTNESS,
        spill_suppression: DEFAULT_SPILL_SUPPRESSION,
        material,
      };
  }
}

function extractChroma(image: LoadedImage, matte: readonly [number, number, number], threshold: number, softness: number, spillSuppression: number): LoadedImage {
  const low = Math.max(0, threshold);
  const high = Math.max(low + 1, threshold + Math.max(1, softness));
  const output = cloneImage(image);
  forEachPixel(output, (_x, _y, rgba, index) => {
    const distance = colorDistance([rgba[0], rgba[1], rgba[2]], matte);
    const t = clamp01((distance - low) / (high - low));
    const smoothed = t * t * (3 - 2 * t);
    const alpha = Math.round(smoothed * 255);
    const out = decontaminatePixel(rgba, matte, alpha, spillSuppression);
    output.data[index] = out[0];
    output.data[index + 1] = out[1];
    output.data[index + 2] = out[2];
    output.data[index + 3] = out[3];
  });
  output.hasAlpha = true;
  output.colorType = "Rgba8";
  output.format = "png";
  return output;
}

function extractDual(dark: LoadedImage, light: LoadedImage): LoadedImage {
  const output = createImage(dark.width, dark.height);
  for (let index = 0; index < dark.data.length; index += 4) {
    const delta =
      (Math.max(0, light.data[index] - dark.data[index]) +
        Math.max(0, light.data[index + 1] - dark.data[index + 1]) +
        Math.max(0, light.data[index + 2] - dark.data[index + 2])) /
      3;
    const alphaFloat = clamp01(1 - delta / 255);
    const alpha = Math.round(alphaFloat * 255);
    if (alpha <= TRANSPARENT_ALPHA_MAX) {
      output.data[index] = 0;
      output.data[index + 1] = 0;
      output.data[index + 2] = 0;
      output.data[index + 3] = 0;
      continue;
    }
    output.data[index] = Math.round(clamp(0, 255, dark.data[index] / Math.max(alphaFloat, 0.001)));
    output.data[index + 1] = Math.round(clamp(0, 255, dark.data[index + 1] / Math.max(alphaFloat, 0.001)));
    output.data[index + 2] = Math.round(clamp(0, 255, dark.data[index + 2] / Math.max(alphaFloat, 0.001)));
    output.data[index + 3] = alpha;
  }
  return output;
}

function decontaminatePixel(source: readonly number[], matte: readonly [number, number, number], alpha: number, spillSuppression: number) {
  if (alpha <= TRANSPARENT_ALPHA_MAX) return [0, 0, 0, 0] as const;
  const alphaFloat = alpha / 255;
  const out = [0, 0, 0, Math.min(alpha, source[3])] as [number, number, number, number];
  for (let channel = 0; channel < 3; channel += 1) {
    out[channel] = Math.round(
      clamp(
        0,
        255,
        (source[channel] - matte[channel] * (1 - alphaFloat)) / Math.max(alphaFloat, 0.001),
      ),
    );
  }
  suppressMatteSpill(out, matte, alpha, spillSuppression);
  return out;
}

function suppressMatteSpill(rgba: [number, number, number, number], matte: readonly [number, number, number], alpha: number, amount: number) {
  const clampedAmount = clamp01(amount);
  if (clampedAmount <= 0 || alpha <= TRANSPARENT_ALPHA_MAX) return;
  const maxMatte = Math.max(...matte);
  const minMatte = Math.min(...matte);
  if (maxMatte < 192 || maxMatte - minMatte < 128) return;
  const dominantChannels = [0, 1, 2].filter((channel) => matte[channel] >= maxMatte - 8);
  const otherChannels = [0, 1, 2].filter((channel) => !dominantChannels.includes(channel));
  if (!dominantChannels.length || !otherChannels.length) return;
  const similarity = clamp01(1 - colorDistance([rgba[0], rgba[1], rgba[2]], matte) / (255 * Math.sqrt(3)));
  const alphaEdgeFactor = Math.sqrt(clamp01(1 - alpha / 255));
  const strength = clampedAmount * Math.max(Math.sqrt(similarity), alphaEdgeFactor);
  if (strength <= 0.01) return;
  const reference = Math.max(...otherChannels.map((channel) => rgba[channel]));
  for (const channel of dominantChannels) {
    if (rgba[channel] <= reference) continue;
    const excess = rgba[channel] - reference;
    rgba[channel] = Math.round(clamp(0, 255, rgba[channel] - excess * strength));
  }
}

function componentStats(image: LoadedImage) {
  const total = image.width * image.height;
  if (image.width === 0 || image.height === 0 || total === 0) {
    return {
      component_count: 0,
      largest_component_pixels: 0,
      largest_component_ratio: 0,
      stray_pixel_count: 0,
      alpha_noise_score: 0,
    };
  }
  const visited = new Uint8Array(total);
  let componentCount = 0;
  let largest = 0;
  let nontransparent = 0;
  const stack: number[] = [];
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const start = y * image.width + x;
      if (visited[start] || pixelAlpha(image, x, y) <= TRANSPARENT_ALPHA_MAX) continue;
      componentCount += 1;
      let count = 0;
      visited[start] = 1;
      stack.push(start);
      while (stack.length) {
        const current = stack.pop()!;
        const cx = current % image.width;
        const cy = Math.floor(current / image.width);
        count += 1;
        for (let ny = Math.max(0, cy - 1); ny <= Math.min(image.height - 1, cy + 1); ny += 1) {
          for (let nx = Math.max(0, cx - 1); nx <= Math.min(image.width - 1, cx + 1); nx += 1) {
            const next = ny * image.width + nx;
            if (visited[next] || pixelAlpha(image, nx, ny) <= TRANSPARENT_ALPHA_MAX) continue;
            visited[next] = 1;
            stack.push(next);
          }
        }
      }
      nontransparent += count;
      largest = Math.max(largest, count);
    }
  }
  const stray = Math.max(0, nontransparent - largest);
  return {
    component_count: componentCount,
    largest_component_pixels: largest,
    largest_component_ratio: ratio(largest, nontransparent),
    stray_pixel_count: stray,
    alpha_noise_score: ratio(stray, nontransparent),
  };
}

function evaluateTransparencyGate(input: {
  profile: TransparentProfile;
  is_png: boolean;
  has_alpha: boolean;
  alpha_min: number;
  alpha_max: number;
  nontransparent_pixels: number;
  transparent_ratio: number;
  partial_pixels: number;
  touches_edge: boolean;
  largest_component_ratio: number;
  alpha_noise_score: number;
  matte_residue_score: number | null;
  checkerboard_detected: boolean;
  transparent_rgb_scrubbed: boolean;
}) {
  const failures: string[] = [];
  if (!input.is_png) failures.push("not_png");
  if (!input.has_alpha) failures.push("missing_alpha_channel");
  if (input.checkerboard_detected) failures.push("checkerboard_detected");
  if (input.nontransparent_pixels === 0) failures.push("empty_subject");
  if (input.alpha_min > TRANSPARENT_ALPHA_MAX) failures.push("no_fully_transparent_pixels");
  if (input.alpha_max < NONTRANSPARENT_ALPHA_MIN) failures.push("alpha_range_too_low");
  if (input.transparent_ratio < MIN_TRANSPARENT_RATIO) failures.push("transparent_area_too_small");
  if (!input.transparent_rgb_scrubbed) failures.push("transparent_rgb_not_scrubbed");
  switch (input.profile) {
    case "icon":
    case "product":
      if (input.alpha_max < MIN_OPAQUE_ALPHA) failures.push("profile_requires_opaque_pixels");
      if (input.transparent_ratio < STRICT_MIN_TRANSPARENT_RATIO) failures.push("profile_transparent_area_too_small");
      if (input.touches_edge) failures.push("subject_touches_edge");
      if (input.largest_component_ratio < 0.92 || input.alpha_noise_score > 0.08) failures.push("too_many_stray_pixels");
      if (input.matte_residue_score !== null && input.matte_residue_score > 0.18) failures.push("matte_residue_too_high");
      break;
    case "sticker":
      if (input.alpha_max < MIN_OPAQUE_ALPHA) failures.push("profile_requires_opaque_pixels");
      if (input.transparent_ratio < STRICT_MIN_TRANSPARENT_RATIO) failures.push("profile_transparent_area_too_small");
      if (input.touches_edge) failures.push("subject_touches_edge");
      if (input.largest_component_ratio < 0.75 || input.alpha_noise_score > 0.25) failures.push("too_many_stray_pixels");
      if (input.matte_residue_score !== null && input.matte_residue_score > 0.22) failures.push("matte_residue_too_high");
      break;
    case "seal":
      if (input.alpha_max < MIN_OPAQUE_ALPHA) failures.push("profile_requires_opaque_pixels");
      if (input.transparent_ratio < STRICT_MIN_TRANSPARENT_RATIO) failures.push("profile_transparent_area_too_small");
      if (input.touches_edge) failures.push("subject_touches_edge");
      if (input.alpha_noise_score > 0.6) failures.push("too_many_stray_pixels");
      if (input.matte_residue_score !== null && input.matte_residue_score > 0.24) failures.push("matte_residue_too_high");
      break;
    case "effect":
      if (input.transparent_ratio < 0.02) failures.push("profile_transparent_area_too_small");
      if (input.touches_edge) failures.push("effect_touches_edge");
      break;
    case "translucent":
    case "glow":
    case "shadow":
      if (input.partial_pixels === 0) failures.push("profile_requires_partial_alpha");
      if (input.transparent_ratio < 0.02) failures.push("profile_transparent_area_too_small");
      if (input.touches_edge) failures.push("effect_touches_edge");
      break;
    case "generic":
    default:
      break;
  }
  return { passed: failures.length === 0, failure_reasons: failures };
}

function qualityScore(
  passed: boolean,
  touchesEdge: boolean,
  alphaNoiseScore: number,
  matteResidueScoreValue: number | null,
  halo: number,
  checkerboard: boolean,
  transparentRgb: boolean,
) {
  let score = passed ? 1 : 0.65;
  if (touchesEdge) score -= 0.2;
  if (checkerboard) score -= 0.45;
  if (!transparentRgb) score -= 0.2;
  score -= Math.min(1, alphaNoiseScore) * 0.25;
  score -= Math.min(1, matteResidueScoreValue ?? 0) * 0.25;
  score -= Math.min(1, halo) * 0.1;
  return clamp01(score);
}

function alphaHealthScore(input: {
  is_png: boolean;
  has_alpha: boolean;
  alpha_min: number;
  alpha_max: number;
  nontransparent_pixels: number;
  transparent_ratio: number;
  checkerboard_detected: boolean;
  transparent_rgb_scrubbed: boolean;
}) {
  let score = 1;
  if (!input.is_png) score -= 0.2;
  if (!input.has_alpha) score -= 0.45;
  if (input.nontransparent_pixels === 0) score -= 0.35;
  if (input.alpha_min > TRANSPARENT_ALPHA_MAX) score -= 0.2;
  if (input.alpha_max < NONTRANSPARENT_ALPHA_MIN) score -= 0.25;
  if (input.transparent_ratio < MIN_TRANSPARENT_RATIO) score -= 0.2;
  if (input.checkerboard_detected) score -= 0.35;
  if (!input.transparent_rgb_scrubbed) score -= 0.12;
  return clamp01(score);
}

function residueScore(alphaNoiseScore: number, matteResidueScoreValue: number | null, halo: number, touchesEdge: boolean) {
  let score = 1;
  score -= Math.min(1, alphaNoiseScore) * 0.35;
  score -= Math.min(1, matteResidueScoreValue ?? 0) * 0.35;
  score -= Math.min(1, halo) * 0.15;
  if (touchesEdge) score -= 0.15;
  return clamp01(score);
}

function transparentRgbScrubbed(image: LoadedImage) {
  for (let index = 0; index < image.data.length; index += 4) {
    if (image.data[index + 3] > TRANSPARENT_ALPHA_MAX) continue;
    if (image.data[index] > 2 || image.data[index + 1] > 2 || image.data[index + 2] > 2) {
      return false;
    }
  }
  return true;
}

function scrubTransparentRgb(image: LoadedImage) {
  for (let index = 0; index < image.data.length; index += 4) {
    if (image.data[index + 3] <= TRANSPARENT_ALPHA_MAX) {
      image.data[index] = 0;
      image.data[index + 1] = 0;
      image.data[index + 2] = 0;
      image.data[index + 3] = 0;
    }
  }
}

function matteResidueScore(image: LoadedImage, matte: readonly [number, number, number]) {
  const maxMatte = Math.max(...matte);
  const minMatte = Math.min(...matte);
  const dominantChannels = [0, 1, 2].filter((channel) => matte[channel] >= maxMatte - 8);
  const otherChannels = [0, 1, 2].filter((channel) => !dominantChannels.includes(channel));
  if (maxMatte >= 192 && maxMatte - minMatte >= 128 && otherChannels.length > 0) {
    return saturatedMatteResidueScore(image, dominantChannels, otherChannels);
  }
  let weighted = 0;
  let totalWeight = 0;
  for (let index = 0; index < image.data.length; index += 4) {
    const alpha = image.data[index + 3];
    if (alpha <= TRANSPARENT_ALPHA_MAX || alpha >= MIN_OPAQUE_ALPHA) continue;
    const alphaWeight = 1 - alpha / 255;
    const similarity =
      1 -
      colorDistance(
        [image.data[index], image.data[index + 1], image.data[index + 2]],
        matte,
      ) /
        (255 * Math.sqrt(3));
    weighted += clamp01(similarity) * alphaWeight;
    totalWeight += alphaWeight;
  }
  return totalWeight === 0 ? 0 : weighted / totalWeight;
}

function saturatedMatteResidueScore(image: LoadedImage, dominantChannels: number[], otherChannels: number[]) {
  let weighted = 0;
  let totalWeight = 0;
  for (let index = 0; index < image.data.length; index += 4) {
    const alpha = image.data[index + 3];
    if (alpha <= TRANSPARENT_ALPHA_MAX || alpha >= MIN_OPAQUE_ALPHA) continue;
    const alphaWeight = 1 - alpha / 255;
    const reference = Math.max(...otherChannels.map((channel) => image.data[index + channel]));
    const excess =
      dominantChannels
        .map((channel) => Math.max(0, image.data[index + channel] - reference))
        .reduce((sum, value) => sum + value, 0) / dominantChannels.length;
    weighted += (excess / 255) * alphaWeight;
    totalWeight += alphaWeight;
  }
  return totalWeight === 0 ? 0 : weighted / totalWeight;
}

function haloScore(image: LoadedImage) {
  let haloPixels = 0;
  let sampled = 0;
  for (let index = 0; index < image.data.length; index += 4) {
    const red = image.data[index];
    const green = image.data[index + 1];
    const blue = image.data[index + 2];
    const alpha = image.data[index + 3];
    if (alpha <= TRANSPARENT_ALPHA_MAX || alpha >= MIN_OPAQUE_ALPHA) continue;
    sampled += 1;
    const luma = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
    const chroma = (Math.max(red, green, blue) - Math.min(red, green, blue)) / 255;
    if ((luma < 0.04 || luma > 0.96) && chroma < 0.08) haloPixels += 1;
  }
  return ratio(haloPixels, sampled);
}

function detectCheckerboard(image: LoadedImage) {
  if (image.width < 32 || image.height < 32) return false;
  return [8, 16, 32].some((cellSize) => checkerboardAtCellSize(image, cellSize));
}

function checkerboardAtCellSize(image: LoadedImage, cellSize: number) {
  const cellsX = Math.floor(image.width / cellSize);
  const cellsY = Math.floor(image.height / cellSize);
  if (cellsX < 4 || cellsY < 4) return false;
  const sums = [
    [0, 0, 0],
    [0, 0, 0],
  ];
  const counts = [0, 0];
  const cellColors: Array<{ parity: 0 | 1; color: [number, number, number] }> = [];
  for (let cy = 0; cy < cellsY; cy += 1) {
    for (let cx = 0; cx < cellsX; cx += 1) {
      const color = averageCellColor(image, cx * cellSize, cy * cellSize, cellSize);
      const parity = ((cx + cy) % 2) as 0 | 1;
      for (let channel = 0; channel < 3; channel += 1) sums[parity][channel] += color[channel];
      counts[parity] += 1;
      cellColors.push({ parity, color });
    }
  }
  if (counts[0] === 0 || counts[1] === 0) return false;
  const means = [
    sums[0].map((value) => value / counts[0]) as [number, number, number],
    sums[1].map((value) => value / counts[1]) as [number, number, number],
  ];
  if (colorDistanceF64(means[0], means[1]) < 25) return false;
  let squared = 0;
  let samples = 0;
  for (const cell of cellColors) {
    for (let channel = 0; channel < 3; channel += 1) {
      const delta = cell.color[channel] - means[cell.parity][channel];
      squared += delta * delta;
      samples += 1;
    }
  }
  const rmse = Math.sqrt(squared / Math.max(1, samples));
  return rmse < 18;
}

function averageCellColor(image: LoadedImage, startX: number, startY: number, cellSize: number) {
  const endX = Math.min(image.width, startX + cellSize);
  const endY = Math.min(image.height, startY + cellSize);
  let red = 0;
  let green = 0;
  let blue = 0;
  let count = 0;
  for (let y = startY; y < endY; y += 1) {
    for (let x = startX; x < endX; x += 1) {
      const index = offset(image.width, x, y);
      red += image.data[index];
      green += image.data[index + 1];
      blue += image.data[index + 2];
      count += 1;
    }
  }
  if (count === 0) return [0, 0, 0] as [number, number, number];
  return [Math.round(red / count), Math.round(green / count), Math.round(blue / count)] as [number, number, number];
}

function dualAlignmentReport(dark: LoadedImage, light: LoadedImage) {
  let negativeChannels = 0;
  let totalChannels = 0;
  let noiseSum = 0;
  let pixelCount = 0;
  for (let index = 0; index < dark.data.length; index += 4) {
    const deltas = [
      light.data[index] - dark.data[index],
      light.data[index + 1] - dark.data[index + 1],
      light.data[index + 2] - dark.data[index + 2],
    ];
    for (const delta of deltas) {
      if (delta < -2) negativeChannels += 1;
      totalChannels += 1;
    }
    const mean = (deltas[0] + deltas[1] + deltas[2]) / 3;
    const variance =
      deltas.map((delta) => {
        const centered = delta - mean;
        return centered * centered;
      }).reduce((sum, value) => sum + value, 0) / 3;
    noiseSum += Math.sqrt(variance) / 255;
    pixelCount += 1;
  }
  const negativeDeltaRatio = ratio(negativeChannels, totalChannels);
  const deltaChannelNoise = pixelCount === 0 ? 0 : noiseSum / pixelCount;
  const score = clamp01(1 - negativeDeltaRatio * 1.5 - deltaChannelNoise * 1.2);
  return {
    score,
    passed: score >= 0.55,
    negative_delta_ratio: negativeDeltaRatio,
    delta_channel_noise: deltaChannelNoise,
    color_space: "srgb",
  };
}

function estimateMatteColor(image: LoadedImage) {
  const sample = clamp(1, 32, Math.min(image.width, image.height));
  const red: number[] = [];
  const green: number[] = [];
  const blue: number[] = [];
  for (let y = 0; y < sample; y += 1) {
    for (let x = 0; x < sample; x += 1) {
      pushRgb(pixelAt(image, x, y), red, green, blue);
      pushRgb(pixelAt(image, image.width - 1 - x, y), red, green, blue);
      pushRgb(pixelAt(image, x, image.height - 1 - y), red, green, blue);
      pushRgb(pixelAt(image, image.width - 1 - x, image.height - 1 - y), red, green, blue);
    }
  }
  return [median(red), median(green), median(blue)] as const;
}

function pushRgb(pixel: readonly number[], red: number[], green: number[], blue: number[]) {
  red.push(pixel[0]);
  green.push(pixel[1]);
  blue.push(pixel[2]);
}

function median(values: number[]) {
  if (values.length === 0) return 0;
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)] ?? 0;
}

function colorDistance(a: readonly number[], b: readonly number[]) {
  const red = a[0] - b[0];
  const green = a[1] - b[1];
  const blue = a[2] - b[2];
  return Math.sqrt(red * red + green * green + blue * blue);
}

function colorDistanceF64(a: readonly number[], b: readonly number[]) {
  return colorDistance(a, b);
}

function loadImage(filePath: string): LoadedImage {
  const buffer = fs.readFileSync(filePath);
  if (buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    const png = PNG.sync.read(buffer);
    const colorType = colorTypeName((png as { colorType?: number }).colorType ?? 6);
    const hasAlpha = ((png as { colorType?: number }).colorType ?? 6) === 6 || ((png as { colorType?: number }).colorType ?? 6) === 4;
    return {
      width: png.width,
      height: png.height,
      data: new Uint8Array(png.data),
      format: "png",
      colorType: hasAlpha ? "Rgba8" : "Rgb8",
      hasAlpha,
    };
  }
  try {
    const decoded = jpeg.decode(buffer, { useTArray: true });
    return {
      width: decoded.width,
      height: decoded.height,
      data: new Uint8Array(decoded.data),
      format: "jpeg",
      colorType: "Rgb8",
      hasAlpha: false,
    };
  } catch (error) {
    throw new CliError("image_decode_failed", "Unable to decode image file.", {
      path: filePath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function colorTypeName(colorType: number) {
  switch (colorType) {
    case 0:
      return "L8";
    case 2:
      return "Rgb8";
    case 4:
      return "La8";
    case 6:
      return "Rgba8";
    default:
      return `PngColorType(${colorType})`;
  }
}

function writePng(filePath: string, image: LoadedImage) {
  ensureParentDir(filePath);
  const png = new PNG({ width: image.width, height: image.height, colorType: 6 });
  png.data = Buffer.from(image.data);
  fs.writeFileSync(filePath, PNG.sync.write(png, { colorType: 6 }));
}

function outputFileValue(filePath: string) {
  const bytes = fs.statSync(filePath).size;
  return {
    path: filePath,
    bytes,
    files: [{ index: 0, path: filePath, bytes }],
  };
}

function createImage(width: number, height: number): LoadedImage {
  return {
    width,
    height,
    data: new Uint8Array(width * height * 4),
    format: "png",
    colorType: "Rgba8",
    hasAlpha: true,
  };
}

function cloneImage(image: LoadedImage): LoadedImage {
  return {
    width: image.width,
    height: image.height,
    data: new Uint8Array(image.data),
    format: image.format,
    colorType: image.colorType,
    hasAlpha: image.hasAlpha,
  };
}

function offset(width: number, x: number, y: number) {
  return (y * width + x) * 4;
}

function pixelAt(image: LoadedImage, x: number, y: number) {
  const index = offset(image.width, x, y);
  return image.data.subarray(index, index + 4);
}

function pixelAlpha(image: LoadedImage, x: number, y: number) {
  return image.hasAlpha ? (image.data[offset(image.width, x, y) + 3] ?? 0) : 255;
}

function forEachPixel(
  image: LoadedImage,
  fn: (x: number, y: number, rgba: Uint8Array, index: number) => void,
) {
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const index = offset(image.width, x, y);
      fn(x, y, image.data.subarray(index, index + 4), index);
    }
  }
}

function ratio(count: number, total: number) {
  return total === 0 ? 0 : count / total;
}

function colorToHex(color: readonly number[]) {
  return `#${color.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function clamp(min: number, max: number, value: number) {
  return Math.max(min, Math.min(max, value));
}

function clamp01(value: number) {
  return clamp(0, 1, value);
}
