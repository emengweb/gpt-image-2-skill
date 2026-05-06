import fs from "node:fs";
import path from "node:path";
import { CliError } from "./errors.ts";
import { JsonEventWriter } from "./json-events.ts";
import type { AppConfig, ProviderConfig } from "./types.ts";
import {
  DEFAULT_CODEX_ENDPOINT,
  DEFAULT_CODEX_MODEL,
  DEFAULT_INSTRUCTIONS,
  DEFAULT_REFRESH_TIMEOUT_MS,
  DEFAULT_RETRY_COUNT,
  DEFAULT_RETRY_DELAY_SECONDS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  REFRESH_CLIENT_ID,
  REFRESH_ENDPOINT,
} from "./constants.ts";
import {
  authPath,
  configPath,
  readConfig,
  resolveProvider,
  resolveUserAgent,
  saveConfig,
} from "./config-store.ts";
import { resolveRefImages } from "./image-sources.ts";
import { writeImageOutputs } from "./fs-helpers.ts";
import { buildUserAgentHeaders } from "./request-headers.ts";

type CodexAuthState = {
  authFilePath: string;
  accessToken: string;
  refreshToken?: string;
  accountId: string;
  persistence: "auth.json" | "config";
  providerName?: string;
};

type CodexImageResult = {
  response: Record<string, unknown>;
  outputItems: Record<string, unknown>[];
  imageItems: Record<string, unknown>[];
  refreshed: boolean;
  retryCount: number;
};

export function inspectCodexAuth() {
  const target = authPath();
  return inspectCodexAuthFile(target);
}

export function inspectCodexAuthFile(target: string) {
  const result: Record<string, unknown> = {
    auth_file: target,
    auth_source: "config",
    exists: fs.existsSync(target),
    provider: "codex",
  };
  if (!fs.existsSync(target)) {
    result.ready = false;
    result.parse_ok = false;
    result.auth_source = "missing";
    result.message = "auth.json was not found.";
    return result;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(target, "utf8")) as Record<string, unknown>;
    const tokens = getTokenContainer(parsed);
    const accessToken = asNonEmptyString(tokens.access_token);
    const refreshToken = asNonEmptyString(tokens.refresh_token);
    result.ready = Boolean(accessToken);
    result.parse_ok = true;
    result.auth_mode = accessToken ? "chatgpt_token" : refreshToken ? "refresh_only" : null;
    result.access_token_present = Boolean(accessToken);
    result.refresh_token_present = Boolean(refreshToken);
    result.account_id = asNonEmptyString(tokens.account_id) ?? null;
    return result;
  } catch (error) {
    result.ready = false;
    result.parse_ok = false;
    result.message = error instanceof Error ? error.message : String(error);
    result.error = { code: "auth_parse_failed" };
    return result;
  }
}

export async function runCodexImageCommand(input: {
  providerName: string;
  provider: ProviderConfig;
  command: "generate" | "edit";
  prompt: string;
  out: string;
  instructions?: string;
  refImages?: string[];
  background?: string;
  size?: string;
  quality?: string;
  format?: string;
  compression?: number;
  events: JsonEventWriter;
}) {
  const authState = loadCodexAuthState(input.providerName);
  const userAgent = resolveUserAgent(readConfig());
  const body = buildCodexImageBody({
    prompt: input.prompt,
    model: input.provider.model || DEFAULT_CODEX_MODEL,
    instructions: input.instructions || DEFAULT_INSTRUCTIONS,
    refImages: resolveRefImages(input.refImages ?? []),
    background: input.background || "auto",
    size: input.size,
    quality: input.quality,
    outputFormat: input.format,
    outputCompression: input.compression,
    action: input.command,
  });
  const outcome = await requestCodexWithRetry(
    input.provider.endpoint || DEFAULT_CODEX_ENDPOINT,
    authState,
    body,
    input.events,
    userAgent,
  );
  const buffers = outcome.imageItems
    .map((item) => item.result)
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => Buffer.from(value, "base64"));
  if (!buffers.length) {
    throw new CliError("missing_image_result", "The response did not include an image_generation_call result.");
  }
  const files = writeImageOutputs(buffers, input.out);
  input.events.emit("progress", "output_saved", {
    phase: "output_saved",
    status: "completed",
    percent: 100,
    provider: "codex",
    file_count: files.length,
    message: "Generated image files saved.",
    output: {
      path: files[0]?.path,
      bytes: files.reduce((sum, file) => sum + file.bytes, 0),
      files,
    },
  });
  return {
    outcome,
    files,
    requestBody: body,
  };
}

export async function runCodexRequestCreate(input: {
  providerName: string;
  provider: ProviderConfig;
  body: Record<string, unknown>;
  outImage?: string;
  expectImage?: boolean;
  events: JsonEventWriter;
}) {
  const authState = loadCodexAuthState(input.providerName);
  const userAgent = resolveUserAgent(readConfig());
  const outcome = await requestCodexWithRetry(
    input.provider.endpoint || DEFAULT_CODEX_ENDPOINT,
    authState,
    input.body,
    input.events,
    userAgent,
  );
  let imageOutput: Record<string, unknown> | null = null;
  const buffers = outcome.imageItems
    .map((item) => item.result)
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => Buffer.from(value, "base64"));
  if (buffers.length && input.outImage) {
    const files = writeImageOutputs(buffers, input.outImage);
    imageOutput = {
      path: files[0]?.path ?? null,
      bytes: files.reduce((sum, file) => sum + file.bytes, 0),
      files,
    };
    input.events.emit("progress", "output_saved", {
      phase: "output_saved",
      status: "completed",
      percent: 100,
      provider: "codex",
      file_count: files.length,
      message: "Generated image files saved.",
      output: imageOutput,
    });
  } else if (buffers.length) {
    imageOutput = {
      available: true,
      count: buffers.length,
      suggested_extension: ".png",
    };
  }
  if (input.expectImage && !imageOutput) {
    throw new CliError("missing_image_result", "The response did not include a generated image.");
  }
  return {
    outcome,
    imageOutput,
  };
}

export function buildCodexImageBody(input: {
  prompt: string;
  model: string;
  instructions: string;
  refImages: string[];
  background: string;
  size?: string;
  quality?: string;
  outputFormat?: string;
  outputCompression?: number;
  action: string;
}) {
  const content = input.refImages.map((imageUrl) => ({
    type: "input_image",
    image_url: imageUrl,
  }));
  content.push({
    type: "input_text",
    text: input.prompt,
  });
  const tool: Record<string, unknown> = {
    type: "image_generation",
    background: input.background,
    action: input.action,
  };
  maybeAssign(tool, "size", input.size);
  maybeAssign(tool, "quality", input.quality);
  maybeAssign(tool, "output_format", input.outputFormat);
  maybeAssign(tool, "output_compression", input.outputCompression);
  return {
    model: input.model,
    instructions: input.instructions,
    store: false,
    stream: true,
    input: [
      {
        role: "user",
        content,
      },
    ],
    tools: [tool],
  };
}

function maybeAssign(target: Record<string, unknown>, key: string, value: unknown) {
  if (value === undefined || value === null || value === "") return;
  target[key] = value;
}

function loadCodexAuthState(providerName: string): CodexAuthState {
  const config = readConfig();
  if (providerName !== "codex" && config.providers[providerName]) {
    return loadCodexAuthStateFromConfig(providerName, config.providers[providerName]);
  }
  return loadCodexAuthStateFromAuthFile(authPath());
}

function loadCodexAuthStateFromConfig(providerName: string, provider: ProviderConfig): CodexAuthState {
  const accessToken = resolveProviderToken(provider, "access_token");
  const refreshToken = resolveProviderToken(provider, "refresh_token", false);
  const accountId = resolveProviderToken(provider, "account_id");
  return {
    authFilePath: configPath(),
    accessToken,
    refreshToken: refreshToken || undefined,
    accountId,
    persistence: "config",
    providerName,
  };
}

function resolveProviderToken(provider: ProviderConfig, key: string, required = true) {
  const credential = provider.credentials[key];
  const value =
    credential?.source === "file"
      ? credential.value
      : credential?.source === "env" && credential.env
        ? process.env[credential.env]
        : undefined;
  if (value?.trim()) return value.trim();
  if (required) {
    throw new CliError(`${key}_missing`, `Missing ${key} for Codex provider.`);
  }
  return "";
}

function loadCodexAuthStateFromAuthFile(target: string): CodexAuthState {
  if (!fs.existsSync(target)) {
    throw new CliError("access_token_missing", `Missing access_token in ${target}`);
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(fs.readFileSync(target, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new CliError("auth_parse_failed", "auth.json exists but could not be parsed.", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const tokens = getTokenContainer(parsed);
  const accessToken = asNonEmptyString(tokens.access_token);
  if (!accessToken) {
    throw new CliError("access_token_missing", `Missing access_token in ${target}`);
  }
  const accountId = asNonEmptyString(tokens.account_id);
  if (!accountId) {
    throw new CliError("account_id_missing", `Missing account_id in ${target}`);
  }
  return {
    authFilePath: target,
    accessToken,
    refreshToken: asNonEmptyString(tokens.refresh_token) || undefined,
    accountId,
    persistence: "auth.json",
  };
}

async function requestCodexWithRetry(
  endpoint: string,
  authState: CodexAuthState,
  body: Record<string, unknown>,
  events: JsonEventWriter,
  userAgent: string,
): Promise<CodexImageResult> {
  let refreshed = false;
  let retryCount = 0;
  while (true) {
    try {
      const outcome = await requestCodexOnce(endpoint, authState, body, events, userAgent);
      return {
        ...outcome,
        refreshed,
        retryCount,
      };
    } catch (error) {
      const cliError = error instanceof CliError ? error : new CliError("request_failed", String(error));
      if (cliError.detail && typeof cliError.detail === "object" && (cliError.detail as { status?: number }).status === 401 && !refreshed) {
        events.emit("progress", "auth_refresh_started", {
          phase: "auth_refresh_started",
          status: "running",
          percent: 2,
          endpoint: REFRESH_ENDPOINT,
          provider: "codex",
          message: "Refreshing Codex access token.",
        });
        await refreshAccessToken(authState, events, userAgent);
        refreshed = true;
        events.emit("progress", "auth_refresh_completed", {
          phase: "auth_refresh_completed",
          status: "running",
          percent: 4,
          provider: "codex",
          message: "Codex access token refreshed.",
        });
        continue;
      }
      if (retryCount >= DEFAULT_RETRY_COUNT || !shouldRetry(cliError)) {
        throw cliError;
      }
      retryCount += 1;
      const delaySeconds = DEFAULT_RETRY_DELAY_SECONDS * 2 ** (retryCount - 1);
      events.emit("progress", "retry_scheduled", {
        phase: "retry_scheduled",
        status: "running",
        provider: "codex",
        retry_number: retryCount,
        max_retries: DEFAULT_RETRY_COUNT,
        delay_seconds: delaySeconds,
        reason: cliError.message,
        message: "Retry scheduled after transient failure.",
      });
      await new Promise((resolve) => setTimeout(resolve, delaySeconds * 1000));
    }
  }
}

async function requestCodexOnce(
  endpoint: string,
  authState: CodexAuthState,
  body: Record<string, unknown>,
  events: JsonEventWriter,
  userAgent: string,
) {
  events.emit("local", "request.started", { provider: "codex", endpoint });
  events.emit("progress", "request_started", {
    phase: "request_started",
    status: "running",
    percent: 0,
    endpoint,
    provider: "codex",
    message: "Codex image request sent.",
  });
  const controller = AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${authState.accessToken}`,
      "ChatGPT-Account-ID": authState.accountId,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      originator: "codex_desktop",
      ...buildUserAgentHeaders(userAgent),
    },
    body: JSON.stringify(body),
    signal: controller,
  }).catch((error) => {
    throw new CliError("network_error", "Codex request failed.", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  if (!response.ok) {
    throw new CliError("http_error", `HTTP ${response.status}`, {
      status: response.status,
      detail: await response.text().catch(() => ""),
    });
  }
  const reader = response.body?.getReader();
  if (!reader) {
    throw new CliError("request_failed", "Unable to read Codex SSE response.");
  }
  const decoder = new TextDecoder();
  let buffered = "";
  let responseMeta: Record<string, unknown> = {};
  const outputItems: Record<string, unknown>[] = [];
  let responseError: Record<string, unknown> | null = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    const parts = buffered.split(/\r?\n\r?\n/);
    buffered = parts.pop() ?? "";
    for (const part of parts) {
      const payload = part
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("");
      if (!payload) continue;
      if (payload === "[DONE]") {
        events.emit("sse", "done", { raw: "[DONE]" });
        continue;
      }
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(payload) as Record<string, unknown>;
      } catch (error) {
        throw new CliError("request_failed", "Unable to parse Codex SSE event.", {
          payload,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      const eventType = typeof event.type === "string" ? event.type : "message";
      events.emit("sse", eventType, redactEventPayload(event));
      switch (eventType) {
        case "response.created":
          responseMeta = objectOrEmpty(event.response);
          events.emit("progress", "response_created", {
            phase: "response_created",
            status: "running",
            percent: 15,
            provider: "codex",
            response_id: responseMeta.id ?? null,
            model: responseMeta.model ?? null,
            message: "Codex accepted the image request.",
          });
          break;
        case "response.output_item.done": {
          const item = objectOrNull(event.item);
          if (item) {
            mergeOutputItem(outputItems, item);
            events.emit("progress", "output_item_done", {
              phase: "output_item_done",
              status: "running",
              percent: 85,
              provider: "codex",
              item_id: item.id ?? null,
              item_type: item.type ?? null,
              item_status: item.status ?? null,
              image_count: extractCodexImageItems(outputItems).length,
              message: "Codex finished one output item.",
            });
          }
          break;
        }
        case "error":
          responseError = objectOrNull(event.error) ?? { raw: event.error };
          events.emit("progress", "request_failed", {
            phase: "request_failed",
            status: "failed",
            provider: "codex",
            error: responseError,
            message: "Codex reported an image generation error.",
          });
          break;
        case "response.failed":
          responseMeta = objectOrEmpty(event.response);
          responseError =
            objectOrNull(responseMeta.error) ??
            objectOrNull(event.error) ??
            { raw: event.error ?? event.response };
          events.emit("progress", "request_failed", {
            phase: "request_failed",
            status: "failed",
            provider: "codex",
            response_id: responseMeta.id ?? null,
            error: responseError,
            message: "Codex marked the image request as failed.",
          });
          break;
        case "response.completed":
          responseMeta = objectOrEmpty(event.response);
          events.emit("progress", "response_completed", {
            phase: "response_completed",
            status: "running",
            percent: 95,
            provider: "codex",
            response_id: responseMeta.id ?? null,
            image_count: extractCodexImageItems(outputItems).length,
            message: "Codex completed the server-side image response.",
          });
          break;
        default:
          break;
      }
    }
  }
  const imageItems = extractCodexImageItems(outputItems);
  if (responseError && !imageItems.length) {
    throw new CliError("request_failed", formatResponseError(responseError));
  }
  events.emit("progress", "request_completed", {
    phase: "request_completed",
    status: "running",
    percent: 97,
    provider: "codex",
    response_id: responseMeta.id ?? null,
    image_count: imageItems.length,
    message: "Codex response payload received.",
  });
  return {
    response: responseMeta,
    outputItems,
    imageItems,
  };
}

async function refreshAccessToken(
  authState: CodexAuthState,
  events: JsonEventWriter,
  userAgent: string,
) {
  if (!authState.refreshToken) {
    throw new CliError("refresh_token_missing", "Missing refresh_token in auth.json");
  }
  const response = await fetch(REFRESH_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...buildUserAgentHeaders(userAgent),
    },
    body: JSON.stringify({
      client_id: REFRESH_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: authState.refreshToken,
    }),
    signal: AbortSignal.timeout(DEFAULT_REFRESH_TIMEOUT_MS),
  }).catch((error) => {
    throw new CliError("refresh_failed", "Refresh request failed.", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  const text = await response.text();
  if (!response.ok) {
    throw new CliError("refresh_failed", "Refresh request failed.", {
      status: response.status,
      detail: text,
    });
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch (error) {
    throw new CliError("refresh_failed", "Refresh response was not valid JSON.", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const accessToken = asNonEmptyString(payload.access_token);
  if (!accessToken) {
    throw new CliError("refresh_failed", "Refresh response did not contain access_token.");
  }
  authState.accessToken = accessToken;
  authState.refreshToken = asNonEmptyString(payload.refresh_token) || authState.refreshToken;
  if (asNonEmptyString(payload.account_id)) {
    authState.accountId = asNonEmptyString(payload.account_id)!;
  }
  saveCodexAuthState(authState);
  events.emit("local", "auth.refresh.completed", redactEventPayload(payload));
}

function saveCodexAuthState(authState: CodexAuthState) {
  if (authState.persistence === "auth.json") {
    const target = authState.authFilePath;
    const original = fs.existsSync(target)
      ? (JSON.parse(fs.readFileSync(target, "utf8")) as Record<string, unknown>)
      : {};
    const tokens = getTokenContainer(original);
    tokens.access_token = authState.accessToken;
    if (authState.refreshToken) tokens.refresh_token = authState.refreshToken;
    tokens.account_id = authState.accountId;
    if ("tokens" in original && typeof original.tokens === "object" && original.tokens) {
      (original as Record<string, unknown>).tokens = tokens;
    } else {
      Object.assign(original, tokens);
    }
    fs.writeFileSync(target, `${JSON.stringify(original, null, 2)}\n`);
    return;
  }
  if (authState.persistence === "config" && authState.providerName) {
    const config = readConfig();
    const provider = resolveProvider(config, authState.providerName);
    provider.credentials.access_token = { source: "file", value: authState.accessToken };
    provider.credentials.account_id = { source: "file", value: authState.accountId };
    if (authState.refreshToken) {
      provider.credentials.refresh_token = { source: "file", value: authState.refreshToken };
    }
    config.providers[authState.providerName] = provider;
    saveConfig(config);
  }
}

function shouldRetry(error: CliError) {
  return ["network_error", "http_error", "request_failed"].includes(error.code);
}

function objectOrEmpty(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function objectOrNull(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function mergeOutputItem(target: Record<string, unknown>[], item: Record<string, unknown>) {
  const itemId = typeof item.id === "string" ? item.id : null;
  if (itemId) {
    const index = target.findIndex((candidate) => candidate.id === itemId);
    if (index >= 0) {
      target[index] = item;
      return;
    }
  }
  target.push(item);
}

function extractCodexImageItems(outputItems: Record<string, unknown>[]) {
  return outputItems.filter(
    (item) => item.type === "image_generation_call" && typeof item.result === "string",
  );
}

function redactEventPayload(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => {
      const lowered = key.toLowerCase();
      if (["access_token", "refresh_token", "id_token", "authorization", "api_key"].includes(lowered)) {
        return [key, { _omitted: "secret" }];
      }
      return [key, redactEventPayload(child)];
    }),
  );
}

function getTokenContainer(source: Record<string, unknown>) {
  const nested = source.tokens;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    return nested as Record<string, unknown>;
  }
  return source;
}

function asNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function formatResponseError(error: Record<string, unknown>) {
  const message = asNonEmptyString(error.message) || "Image generation failed without structured error details.";
  const code = asNonEmptyString(error.code);
  return code ? `${code}: ${message}` : message;
}
