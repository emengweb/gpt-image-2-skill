import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliError } from "./errors.ts";
import { requestGenerate } from "./openai-client.ts";
import { runCodexImageCommand } from "./codex-client.ts";
import { JsonEventWriter } from "./json-events.ts";
import type { ProviderConfig } from "./types.ts";
import {
  controlledMattePrompt,
  extractChromaFile,
  extractDualFile,
  normalizePngOutputPath,
  parseMatteColorOrAuto,
  resolveChromaSettings,
  verifyTransparentFile,
} from "./transparent-core.ts";

type VerifyArgs = {
  input: string;
  profile: string;
  strict: boolean;
  expectedMatteColor?: string;
};

type ExtractArgs = {
  method: "chroma" | "dual";
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
  const outPath = normalizePngOutputPath(args.out);
  const extraction =
    method === "chroma"
      ? extractChromaFile(
          args.input!,
          outPath,
          args.matteColor ? (parseMatteColorOrAuto(args.matteColor) ? args.matteColor : null) : null,
          resolveChromaSettings(args.material, args.threshold, args.softness, args.spillSuppression),
        )
      : extractDualFile(args.darkImage!, args.lightImage!, outPath);
  const verification = verifyTransparentFile(outPath, {
    profile: args.profile as any,
    expectedMatteColor: extraction.matte_color,
  });
  if (args.strict && !verification.passed) {
    throw new CliError("transparent_verification_failed", "Transparent verification failed.", {
      output: outPath,
      verification,
    });
  }
  return {
    ok: true,
    command: "transparent extract",
    method,
    profile: args.profile,
    material: args.material ?? null,
    extraction,
    verification,
    output: outputFileValue(outPath),
  };
}

export async function runTransparentGenerate(input: {
  providerName: string;
  provider: ProviderConfig;
  prompt: string;
  out: string;
  instructions?: string;
  size?: string;
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
  events: JsonEventWriter;
}) {
  if ((input.method ?? "chroma") === "dual") {
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
        quality: input.quality,
        format: "png",
        background: "opaque",
        compression: input.compression,
        moderation: input.moderation,
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
  const extraction = extractChromaFile(
    sourcePath,
    outPath,
    null,
    resolveChromaSettings(input.material, input.threshold, input.softness, input.spillSuppression),
  );
  const verification = verifyTransparentFile(outPath, {
    profile: (input.profile || "generic") as any,
    expectedMatteColor: extraction.matte_color,
  });
  if (!verification.passed) {
    throw new CliError("transparent_verification_failed", "Transparent verification failed.", {
      source: sourcePath,
      output: outPath,
      verification,
    });
  }
  cleanupTempSource(input, sourcePath);
  return {
    ok: true,
    command: "transparent generate",
    provider: input.providerName,
    provider_selection: { resolved: input.providerName },
    request: {
      prompt: input.prompt,
      source_prompt: sourcePrompt,
      method: "chroma",
      profile: input.profile || "generic",
      requested_matte_color: requestedMatteColor,
      matte_color: extraction.matte_color,
      matte_color_source: extraction.matte_color_source,
      threshold: extraction.threshold,
      softness: extraction.softness,
      spill_suppression: extraction.spill_suppression,
      material: input.material ?? null,
      size: input.size ?? null,
      quality: input.quality ?? null,
      format: "png",
    },
    source: {
      path: sourcePath,
      kept: Boolean(input.keepSources || input.sourceOut || input.reportDir),
      generation: sourceGeneration,
    },
    extraction,
    verification,
    output: outputFileValue(outPath),
  };
}

function resolveExtractMethod(args: ExtractArgs) {
  if (args.method === "dual") {
    if (!args.darkImage || !args.lightImage) {
      throw new CliError("invalid_argument", "transparent extract --method dual requires --dark-image and --light-image.");
    }
    return "dual";
  }
  if (!args.input) {
    throw new CliError("invalid_argument", "transparent extract --method chroma requires --input.");
  }
  return "chroma";
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
