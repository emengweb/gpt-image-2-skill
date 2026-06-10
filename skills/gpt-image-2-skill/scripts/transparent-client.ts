import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliError, asError } from "./errors.ts";
import { runBackgroundRemove } from "./background-remove-client.ts";
import { requestGenerate } from "./openai-client.ts";
import { runCodexImageCommand } from "./codex-client.ts";
import { ensureParentDir } from "./fs-helpers.ts";
import { JsonEventWriter } from "./json-events.ts";
import type { ProviderConfig } from "./types.ts";
import type { ImageSizeResolution } from "./image-size.ts";
import {
  controlledMattePrompt,
  extractChromaFile,
  extractDualFile,
  normalizePngOutputPath,
  parseMatteColorOrAuto,
  resolveChromaSettings,
  type ExtractionReport,
  type TransparentProfile,
  type TransparentVerification,
  verifyTransparentFile,
} from "./transparent-core.ts";

type VerifyArgs = {
  input: string;
  profile: string;
  strict: boolean;
  expectedMatteColor?: string;
};

type ExtractArgs = {
  method: "auto" | "rembg" | "chroma" | "dual";
  input?: string;
  darkImage?: string;
  lightImage?: string;
  out: string;
  profile: string;
  material?: string;
  matteColor?: string;
  threshold?: number;
  softness?: number;
  spillSuppression?: number;
  strict: boolean;
};

type BackgroundRemoveExtractionReport = {
  method: "background-remove";
  inputs: { input: string };
  output: ReturnType<typeof outputFileValue>;
  matte_color: null;
  matte_color_source: null;
  threshold: null;
  softness: null;
  spill_suppression: null;
  material: null;
  matte_decontamination_applied: false;
  rgb_scrubbed: boolean;
  dual_alignment: null;
  background_remove: {
    requested_method: string;
    resolved_method: string | null;
    fallback_from: string | null;
    python: string | null;
    script_path: string;
    exit_code: number | null;
  };
};

type SelectedExtractionReport = ExtractionReport | BackgroundRemoveExtractionReport;

type ExtractionAttempt = {
  strategy: "background-remove" | "chroma" | "dual";
  selected: boolean;
  success: boolean;
  output?: ReturnType<typeof outputFileValue>;
  verification?: TransparentVerification;
  extraction?: SelectedExtractionReport;
  error?: {
    code: string;
    message: string;
    detail?: unknown;
  };
};

export async function runTransparentVerify(args: VerifyArgs) {
  const verification = verifyTransparentFile(args.input, {
    profile: args.profile as any,
    expectedMatteColor: args.expectedMatteColor ?? null,
  });
  if (args.strict && !verification.passed) {
    throw new CliError("transparent_verification_failed", "Transparent verification failed.", {
      verification,
    });
  }
  return {
    ok: true,
    command: "transparent verify",
    profile: args.profile,
    passed: verification.passed,
    verification,
  };
}

export async function runTransparentExtract(args: ExtractArgs) {
  const method = resolveExtractMethod(args);
  const profile = args.profile as TransparentProfile;
  const extractionResult =
    method === "dual"
      ? runDualExtractionAttempt({
          darkImage: args.darkImage!,
          lightImage: args.lightImage!,
          outPath: normalizePngOutputPath(args.out),
          profile,
          strict: args.strict,
        })
      : runPreferredSingleImageExtraction({
          inputPath: args.input!,
          outPath: normalizePngOutputPath(args.out),
          profile,
          method,
          material: args.material,
          matteColor: args.matteColor,
          threshold: args.threshold,
          softness: args.softness,
          spillSuppression: args.spillSuppression,
          strict: args.strict,
        });
  return {
    ok: true,
    command: "transparent extract",
    method,
    profile: args.profile,
    selected_strategy: extractionResult.selectedStrategy,
    material: args.material ?? null,
    attempts: summarizeAttempts(extractionResult.attempts),
    extraction: extractionResult.extraction,
    verification: extractionResult.verification,
    output: outputFileValue(normalizePngOutputPath(args.out)),
  };
}

export async function runTransparentGenerate(input: {
  providerName: string;
  provider: ProviderConfig;
  prompt: string;
  out: string;
  instructions?: string;
  size?: string;
  sizeResolution?: ImageSizeResolution | null;
  quality?: string;
  compression?: number;
  moderation?: string;
  method?: string;
  profile?: string;
  material?: string;
  matteColor?: string;
  sourcePrompt?: string;
  sourceOut?: string;
  reportDir?: string;
  keepSources?: boolean;
  threshold?: number;
  softness?: number;
  spillSuppression?: number;
  apiKey?: string;
  stream?: boolean;
  events: JsonEventWriter;
}) {
  if ((input.method ?? "auto") === "dual") {
    throw new CliError(
      "unsupported_option",
      "transparent generate does not generate aligned dual-background sources. Generate the source pair explicitly, then call transparent extract --method dual.",
    );
  }
  const requestedMatteColor = input.matteColor || "#00ff00";
  const sourcePrompt = input.sourcePrompt || controlledMattePrompt(input.prompt, requestedMatteColor);
  const sourcePath = sourceOutputPath(input);
  let sourceGeneration: Record<string, unknown>;
  if (input.provider.type === "codex") {
    const result = await runCodexImageCommand({
      providerName: input.providerName,
      provider: input.provider,
      command: "generate",
      prompt: sourcePrompt,
      out: sourcePath,
      instructions: input.instructions,
      background: "opaque",
      size: input.size,
      quality: input.quality,
      format: "png",
      compression: input.compression,
      stream: input.stream,
      events: input.events,
    });
    sourceGeneration = {
      provider: input.providerName,
      request: result.requestBody,
      response: result.outcome.response,
      output: normalizeSavedOutput(result.files),
      retry: {
        count: result.outcome.retryCount,
        max_retries: 3,
      },
      auth: {
        source: result.outcome.refreshed ? "refreshed" : "auth.json",
        refreshed: result.outcome.refreshed,
      },
      events: { count: input.events.count() },
    };
  } else {
    if (!input.apiKey) {
      throw new CliError("auth_missing", "OpenAI API key is missing.");
    }
    const result = await requestGenerate(
      input.provider,
      input.apiKey,
      {
        prompt: sourcePrompt,
        out: sourcePath,
        size: input.size,
        sizeResolution: input.sizeResolution,
        quality: input.quality,
        format: "png",
        background: "opaque",
        compression: input.compression,
        moderation: input.moderation,
        stream: input.stream,
      },
      new AbortController().signal,
      input.events,
    );
    sourceGeneration = {
      provider: input.providerName,
      request: result.requestBody,
      response: result.payload,
      output: normalizeSavedOutput(result.files),
      retry: {
        count: 0,
        max_retries: 3,
      },
      events: { count: input.events.count() },
    };
  }
  const outPath = normalizePngOutputPath(input.out);
  try {
    const selectedMethod = normalizeSingleImageMethod(input.method);
    const extractionResult = runPreferredSingleImageExtraction({
      inputPath: sourcePath,
      outPath,
      profile: (input.profile || "generic") as TransparentProfile,
      method: selectedMethod,
      material: input.material,
      threshold: input.threshold,
      softness: input.softness,
      spillSuppression: input.spillSuppression,
      strict: true,
    });
    return {
      ok: true,
      command: "transparent generate",
      provider: input.providerName,
      provider_selection: { resolved: input.providerName },
      request: {
        prompt: input.prompt,
        source_prompt: sourcePrompt,
        method: selectedMethod,
        preferred_method:
          selectedMethod === "auto" ? "background-remove" : selectedMethod === "rembg" ? "background-remove" : selectedMethod,
        fallback_method: selectedMethod === "auto" ? "chroma" : null,
        profile: input.profile || "generic",
        requested_matte_color: requestedMatteColor,
        matte_color: extractionResult.extraction.matte_color,
        matte_color_source: extractionResult.extraction.matte_color_source,
        threshold: extractionResult.extraction.threshold,
        softness: extractionResult.extraction.softness,
        spill_suppression: extractionResult.extraction.spill_suppression,
        material: input.material ?? null,
        size: input.size ?? null,
        quality: input.quality ?? null,
        format: "png",
      },
      ...(input.sizeResolution?.changed ? { size_normalization: input.sizeResolution } : {}),
      source: {
        path: sourcePath,
        kept: Boolean(input.keepSources || input.sourceOut || input.reportDir),
        generation: sourceGeneration,
      },
      selected_strategy: extractionResult.selectedStrategy,
      attempts: summarizeAttempts(extractionResult.attempts),
      extraction: extractionResult.extraction,
      verification: extractionResult.verification,
      output: outputFileValue(outPath),
    };
  } finally {
    cleanupTempSource(input, sourcePath);
  }
}

function resolveExtractMethod(args: ExtractArgs) {
  if (args.method === "dual") {
    if (!args.darkImage || !args.lightImage) {
      throw new CliError("invalid_argument", "transparent extract --method dual requires --dark-image and --light-image.");
    }
    return "dual";
  }
  if (!args.input) {
    throw new CliError("invalid_argument", "transparent extract single-image modes require --input.");
  }
  return normalizeSingleImageMethod(args.method);
}

function normalizeSingleImageMethod(method?: string) {
  if (method === "rembg" || method === "chroma") return method;
  return "auto" as const;
}

function runPreferredSingleImageExtraction(input: {
  inputPath: string;
  outPath: string;
  profile: TransparentProfile;
  method: "auto" | "rembg" | "chroma";
  material?: string;
  matteColor?: string;
  threshold?: number;
  softness?: number;
  spillSuppression?: number;
  strict: boolean;
}) {
  const attempts: ExtractionAttempt[] = [];
  const attemptDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-image-2-extract-"));
  const backgroundRemoveOut = path.join(attemptDir, "background-remove.png");
  const chromaOut = path.join(attemptDir, "chroma.png");
  try {
    if (input.method === "rembg" || input.method === "auto") {
      const backgroundRemoveAttempt = createBackgroundRemoveAttempt(
        input.inputPath,
        backgroundRemoveOut,
        input.profile,
      );
      attempts.push(backgroundRemoveAttempt);
      if (input.method === "rembg") {
        backgroundRemoveAttempt.selected = true;
        return finalizeSelectedAttempt(backgroundRemoveAttempt, input.outPath, input.profile, input.strict, attempts);
      }
      if (backgroundRemoveAttempt.success && backgroundRemoveAttempt.verification?.passed) {
        backgroundRemoveAttempt.selected = true;
        return finalizeSelectedAttempt(backgroundRemoveAttempt, input.outPath, input.profile, input.strict, attempts);
      }
    }
    if (input.method === "chroma" || input.method === "auto") {
      const chromaAttempt = createChromaFallbackAttempt({
        inputPath: input.inputPath,
        outPath: chromaOut,
        profile: input.profile,
        material: input.material,
        matteColor: input.matteColor,
        threshold: input.threshold,
        softness: input.softness,
        spillSuppression: input.spillSuppression,
      });
      attempts.push(chromaAttempt);
    }
    const selectedAttempt = selectBestAttempt(attempts);
    if (!selectedAttempt) {
      throw new CliError("transparent_extraction_failed", "All transparent extraction attempts failed.", {
        attempts: summarizeAttempts(attempts),
      });
    }
    selectedAttempt.selected = true;
    return finalizeSelectedAttempt(selectedAttempt, input.outPath, input.profile, input.strict, attempts);
  } finally {
    fs.rmSync(attemptDir, { recursive: true, force: true });
  }
}

function runDualExtractionAttempt(input: {
  darkImage: string;
  lightImage: string;
  outPath: string;
  profile: TransparentProfile;
  strict: boolean;
}) {
  const attempts: ExtractionAttempt[] = [];
  try {
    const extraction = extractDualFile(input.darkImage, input.lightImage, input.outPath, input.profile);
    const verification = verifyTransparentFile(input.outPath, {
      profile: input.profile,
      expectedMatteColor: extraction.matte_color,
    });
    const attempt: ExtractionAttempt = {
      strategy: "dual",
      selected: true,
      success: true,
      output: outputFileValue(input.outPath),
      verification,
      extraction,
    };
    attempts.push(attempt);
    if (input.strict && !verification.passed) {
      throw new CliError("transparent_verification_failed", "Transparent verification failed.", {
        output: input.outPath,
        verification,
        attempts: summarizeAttempts(attempts),
      });
    }
    return {
      selectedStrategy: "dual" as const,
      attempts,
      extraction,
      verification,
    };
  } catch (error) {
    const normalized = asError(error);
    throw new CliError(normalized.code, normalized.message, {
      ...(typeof normalized.detail === "object" && normalized.detail !== null ? normalized.detail : {}),
      attempts: summarizeAttempts(attempts),
    });
  }
}

function createBackgroundRemoveAttempt(
  inputPath: string,
  outPath: string,
  profile: TransparentProfile,
): ExtractionAttempt {
  const result = runBackgroundRemove(inputPath, outPath, "rembg");
  const primary = result.results[0];
  if (!result.success || !primary?.file) {
    return {
      strategy: "background-remove",
      selected: false,
      success: false,
      error: {
        code: "background_remove_failed",
        message: primary?.error || result.error || "background_remove.py failed.",
        detail: {
          python: result.python,
          python_version: result.pythonVersion,
          script_path: result.scriptPath,
          exit_code: result.exitCode,
        },
      },
    };
  }
  const verification = verifyTransparentFile(primary.file, {
    profile,
  });
  const extraction = buildBackgroundRemoveExtractionReport(inputPath, primary.file, result, verification);
  return {
    strategy: "background-remove",
    selected: false,
    success: true,
    output: outputFileValue(primary.file),
    verification,
    extraction,
  };
}

function createChromaFallbackAttempt(input: {
  inputPath: string;
  outPath: string;
  profile: TransparentProfile;
  material?: string;
  matteColor?: string;
  threshold?: number;
  softness?: number;
  spillSuppression?: number;
}) {
  try {
    const extraction = extractChromaFile(
      input.inputPath,
      input.outPath,
      input.matteColor ? (parseMatteColorOrAuto(input.matteColor) ? input.matteColor : null) : null,
      resolveChromaSettings(input.material, input.threshold, input.softness, input.spillSuppression),
      input.profile,
    );
    const verification = verifyTransparentFile(input.outPath, {
      profile: input.profile,
      expectedMatteColor: extraction.matte_color,
    });
    return {
      strategy: "chroma" as const,
      selected: false,
      success: true,
      output: outputFileValue(input.outPath),
      verification,
      extraction,
    };
  } catch (error) {
    const normalized = asError(error);
    return {
      strategy: "chroma" as const,
      selected: false,
      success: false,
      error: {
        code: normalized.code,
        message: normalized.message,
        detail: normalized.detail,
      },
    };
  }
}

function finalizeSelectedAttempt(
  selectedAttempt: ExtractionAttempt,
  outPath: string,
  profile: TransparentProfile,
  strict: boolean,
  attempts: ExtractionAttempt[],
) {
  const extraction = selectedAttempt.extraction;
  if (!selectedAttempt.success || !selectedAttempt.output || !selectedAttempt.verification || !extraction) {
    throw new CliError("transparent_extraction_failed", "All transparent extraction attempts failed.", {
      attempts: summarizeAttempts(attempts),
    });
  }
  if (selectedAttempt.output.path !== outPath) {
    ensureParentDir(outPath);
    fs.copyFileSync(selectedAttempt.output.path, outPath);
  }
  const normalizedExtraction = withOutputPath(extraction, outPath);
  const finalVerification = verifyTransparentFile(outPath, {
    profile,
    expectedMatteColor: normalizedExtraction.matte_color,
  });
  if (strict && !finalVerification.passed) {
    throw new CliError("transparent_verification_failed", "Transparent verification failed.", {
      output: outPath,
      verification: finalVerification,
      attempts: summarizeAttempts(attempts),
    });
  }
  return {
    selectedStrategy: selectedAttempt.strategy,
    attempts,
    extraction: normalizedExtraction,
    verification: finalVerification,
  };
}

function selectBestAttempt(attempts: ExtractionAttempt[]) {
  const successful = attempts.filter((attempt) => attempt.success && attempt.verification && attempt.extraction);
  if (successful.length === 0) return null;
  const passed = successful.filter((attempt) => attempt.verification?.passed);
  if (passed.length > 0) return passed[0]!;
  return successful.reduce((best, current) =>
    (current.verification?.quality_score ?? 0) > (best.verification?.quality_score ?? 0) ? current : best,
  );
}

function buildBackgroundRemoveExtractionReport(
  inputPath: string,
  outputPath: string,
  result: ReturnType<typeof runBackgroundRemove>,
  verification: TransparentVerification,
): BackgroundRemoveExtractionReport {
  return {
    method: "background-remove",
    inputs: { input: inputPath },
    output: outputFileValue(outputPath),
    matte_color: null,
    matte_color_source: null,
    threshold: null,
    softness: null,
    spill_suppression: null,
    material: null,
    matte_decontamination_applied: false,
    rgb_scrubbed: verification.transparent_rgb_scrubbed,
    dual_alignment: null,
    background_remove: {
      requested_method: "rembg",
      resolved_method: result.results[0]?.method ?? null,
      fallback_from: result.results[0]?.fallbackFrom ?? null,
      python: result.python,
      script_path: result.scriptPath,
      exit_code: result.exitCode,
    },
  };
}

function withOutputPath<T extends SelectedExtractionReport>(extraction: T, outPath: string): T {
  return {
    ...extraction,
    output: outputFileValue(outPath),
  };
}

function summarizeAttempts(attempts: ExtractionAttempt[]) {
  return attempts.map((attempt) => ({
    strategy: attempt.strategy,
    selected: attempt.selected,
    success: attempt.success,
    passed: attempt.verification?.passed ?? null,
    quality_score: attempt.verification?.quality_score ?? null,
    error: attempt.error ?? null,
  }));
}

function outputFileValue(filePath: string) {
  const stats = fs.statSync(filePath);
  return {
    path: filePath,
    bytes: stats.size,
    files: [{ index: 0, path: filePath, bytes: stats.size }],
  };
}

function normalizeSavedOutput(files: { index: number; path: string; bytes: number }[]) {
  return {
    path: files[0]?.path ?? null,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    files,
  };
}

function sourceOutputPath(input: {
  out: string;
  sourceOut?: string;
  reportDir?: string;
}) {
  if (input.sourceOut) return normalizePngOutputPath(input.sourceOut);
  if (input.reportDir) {
    fs.mkdirSync(input.reportDir, { recursive: true });
    return path.join(input.reportDir, "source.png");
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-image-2-transparent-"));
  return path.join(tempDir, "source.png");
}

function cleanupTempSource(
  input: {
    sourceOut?: string;
    reportDir?: string;
    keepSources?: boolean;
  },
  sourcePath: string,
) {
  if (input.keepSources || input.sourceOut || input.reportDir) return;
  const parent = path.dirname(sourcePath);
  if (path.basename(parent).startsWith("gpt-image-2-transparent-")) {
    fs.rmSync(parent, { recursive: true, force: true });
  }
}
