import { CliError } from "./errors.ts";

const MAX_EDGE = 3840;
const MAX_TOTAL_PIXELS = 8_294_400;
const MAX_ASPECT_RATIO = 3;
const SIZE_STEP = 16;

const SIZE_ALIASES: Record<string, string> = {
  "1k": "1024x1024",
  "2k": "2048x2048",
  "3k": "3072x1728",
  "4k": "3840x2160",
};

export type ImageSizeResolution = {
  requested: string;
  normalized_input: string;
  resolved: string;
  changed: boolean;
  oversize_adjusted: boolean;
  message?: string;
};

export function resolveImageSize(size: string | number): ImageSizeResolution {
  const requested = typeof size === "number" ? String(Math.trunc(size)) : size.trim();
  const normalizedInput = normalizeImageSizeInput(size);
  if (normalizedInput === "auto") {
    return {
      requested,
      normalized_input: "auto",
      resolved: "auto",
      changed: requested !== "auto",
      oversize_adjusted: false,
    };
  }
  const resolved = validateAndFitNormalizedImageSize(normalizedInput);
  const changed = resolved !== requested;
  const oversizeAdjusted = resolved !== normalizedInput;
  return {
    requested,
    normalized_input: normalizedInput,
    resolved,
    changed,
    oversize_adjusted: oversizeAdjusted,
    ...(oversizeAdjusted
      ? {
          message: `Requested size ${requested} exceeds the model limits and was automatically reduced to ${resolved}.`,
        }
      : {}),
  };
}

export function normalizeImageSizeInput(size: string | number) {
  const normalized =
    typeof size === "number"
      ? String(Math.trunc(size))
      : size.trim().toLowerCase().replaceAll("×", "x").replaceAll("*", "x");
  if (!normalized) {
    throw new CliError(
      "invalid_command",
      "Image size must be auto, 1K, 2K, 3K, 4K, a single edge such as 1024, or WIDTHxHEIGHT.",
    );
  }
  if (normalized === "auto") return "auto";
  if (SIZE_ALIASES[normalized]) return SIZE_ALIASES[normalized];

  const kMatch = /^(\d+)k$/.exec(normalized);
  if (kMatch) {
    const kilo = Number(kMatch[1]);
    if (kilo <= 0) {
      throw new CliError("invalid_argument", "K-based sizes must be positive integers.");
    }
    if (kilo <= 4) {
      return SIZE_ALIASES[`${kilo}k`];
    }
    const pixels = kilo * 1024;
    return `${pixels}x${pixels}`;
  }

  if (/^\d+$/.test(normalized)) return `${normalized}x${normalized}`;
  const match = /^(\d+)x(\d+)$/.exec(normalized);
  if (!match) {
    throw new CliError(
      "invalid_command",
      "Image size must be auto, 1K, 2K, 3K, 4K, a single edge such as 1024, or WIDTHxHEIGHT.",
    );
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width <= 0 || height <= 0) {
    throw new CliError("invalid_argument", "Width and height must be positive integers.");
  }
  return `${width}x${height}`;
}

export function validateAndFitNormalizedImageSize(size: string) {
  const match = /^(\d+)x(\d+)$/i.exec(size);
  if (!match) {
    throw new CliError(
      "invalid_command",
      "Image size must be auto, 1K, 2K, 3K, 4K, a single edge such as 1024, or WIDTHxHEIGHT.",
    );
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width % SIZE_STEP !== 0 || height % SIZE_STEP !== 0) {
    throw new CliError("invalid_command", "Width and height must be multiples of 16.");
  }
  if (Math.max(width / height, height / width) > MAX_ASPECT_RATIO) {
    throw new CliError("invalid_argument", "Max aspect ratio is 3:1.");
  }
  const scaled = fitWithinLimits(width, height);
  return `${scaled.width}x${scaled.height}`;
}

function fitWithinLimits(width: number, height: number) {
  if (width <= MAX_EDGE && height <= MAX_EDGE && width * height <= MAX_TOTAL_PIXELS) {
    return { width, height };
  }
  const scale = Math.min(
    MAX_EDGE / width,
    MAX_EDGE / height,
    Math.sqrt(MAX_TOTAL_PIXELS / (width * height)),
    1,
  );
  const scaledWidth = Math.max(SIZE_STEP, Math.floor((width * scale) / SIZE_STEP) * SIZE_STEP);
  const scaledHeight = Math.max(SIZE_STEP, Math.floor((height * scale) / SIZE_STEP) * SIZE_STEP);
  return {
    width: scaledWidth,
    height: scaledHeight,
  };
}

export function normalizeAndValidateImageSize(size: string | number) {
  return resolveImageSize(size).resolved;
}

export function normalizeImageSizeInBody(body: Record<string, unknown>) {
  if (typeof body.size !== "string" && typeof body.size !== "number") {
    return { body, sizeResolution: null as ImageSizeResolution | null };
  }
  const sizeResolution = resolveImageSize(body.size);
  return {
    body: {
      ...body,
      size: sizeResolution.resolved,
    },
    sizeResolution,
  };
}
