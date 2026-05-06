import { CliError } from "./errors.ts";
import { writeImageOutputs } from "./fs-helpers.ts";
import type { OutputFile, ProviderConfig } from "./types.ts";
import type { JsonEventWriter } from "./json-events.ts";
import { loadImageSourceBytes } from "./image-sources.ts";
import type { ImageSizeResolution } from "./image-size.ts";
import { normalizeAndValidateImageSize, normalizeImageSizeInBody } from "./image-size.ts";
import { readConfig, resolveUserAgent } from "./config-store.ts";
import { buildUserAgentHeaders } from "./request-headers.ts";
import {
  DEFAULT_OPENAI_API_BASE,
  DEFAULT_REQUEST_TIMEOUT_MS,
  OPENAI_EDITS_PATH,
  OPENAI_GENERATIONS_PATH,
} from "./constants.ts";

export interface GenerateOptions {
  prompt: string;
  out: string;
  previewOut?: string;
  size?: string;
  sizeResolution?: ImageSizeResolution | null;
  quality?: string;
  format?: string;
  background?: string;
  compression?: number;
  moderation?: string;
  n?: number;
  responseFormat?: string;
  stream?: boolean;
}

export interface EditOptions extends GenerateOptions {
  refImages: string[];
  mask?: string;
}

type OpenAiImageItem = {
  b64_json?: string | null;
  url?: string | null;
  revised_prompt?: string | null;
};

type OpenAiPayload = {
  created?: number;
  data?: OpenAiImageItem[];
  preview_data?: OpenAiImageItem[];
  error?: { message?: string };
  usage?: unknown;
  background?: unknown;
  output_format?: unknown;
  quality?: unknown;
  size?: unknown;
};

type VendorTopLevelImageEvent = OpenAiPayload & {
  type?: string;
  created_at?: number;
  partial_image_index?: number;
  b64_json?: string | null;
  url?: string | null;
  model?: unknown;
};

export function buildGenerateBody(provider: ProviderConfig, options: GenerateOptions) {
  const body: Record<string, unknown> = {
    model: provider.model || "gpt-image-2",
    prompt: options.prompt,
    response_format: options.responseFormat ?? "b64_json",
    stream: options.stream ?? true,
  };
  addField(body, "size", options.size ? normalizeAndValidateImageSize(options.size) : undefined);
  addField(body, "quality", options.quality);
  addField(body, "background", options.background);
  addField(body, "output_format", options.format);
  addField(body, "output_compression", options.compression);
  addField(body, "moderation", options.moderation);
  addField(body, "n", options.n);
  return body;
}

export async function requestGenerate(
  provider: ProviderConfig,
  apiKey: string,
  options: GenerateOptions,
  _signal: AbortSignal,
  events: JsonEventWriter,
) {
  const endpoint = buildOpenAiOperationEndpoint(provider, "generate");
  const body = buildGenerateBody(provider, options);
  const result = await executeOpenAi({
    endpoint,
    apiKey,
    operation: "generate",
    body,
    providerName: provider.type === "openai-compatible" ? "openai-compatible" : "openai",
    events,
    outPath: options.out,
    previewOutPath: options.previewOut,
    sizeResolution: options.sizeResolution,
  });
  return {
    payload: result.payload,
    files: result.files,
    previewFiles: result.previewFiles,
    requestBody: body,
  };
}

export async function requestEdit(
  provider: ProviderConfig,
  apiKey: string,
  options: EditOptions,
  _signal: AbortSignal,
  events: JsonEventWriter,
) {
  const endpoint = buildOpenAiOperationEndpoint(provider, "edit");
  const body: Record<string, unknown> = {
    model: provider.model || "gpt-image-2",
    prompt: options.prompt,
    response_format: options.responseFormat ?? "b64_json",
    stream: options.stream ?? true,
    images: options.refImages,
  };
  addField(body, "size", options.size ? normalizeAndValidateImageSize(options.size) : undefined);
  addField(body, "quality", options.quality);
  addField(body, "background", options.background);
  addField(body, "output_format", options.format);
  addField(body, "output_compression", options.compression);
  addField(body, "moderation", options.moderation);
  addField(body, "n", options.n);
  if (options.mask) body.mask = options.mask;
  const result = await executeOpenAi({
    endpoint,
    apiKey,
    operation: "edit",
    body,
    providerName: provider.type === "openai-compatible" ? "openai-compatible" : "openai",
    events,
    outPath: options.out,
    previewOutPath: options.previewOut,
    sizeResolution: options.sizeResolution,
  });
  return {
    payload: result.payload,
    files: result.files,
    previewFiles: result.previewFiles,
    requestBody: {
      model: provider.model || "gpt-image-2",
      prompt: options.prompt,
      response_format: options.responseFormat ?? "b64_json",
      stream: options.stream ?? true,
      ref_image_count: options.refImages.length,
      mask_present: Boolean(options.mask),
      output_format: options.format,
    },
  };
}

export async function requestCreateOpenAi(input: {
  provider: ProviderConfig;
  apiKey: string;
  operation: "generate" | "edit";
  body: Record<string, unknown>;
  sizeResolution?: ImageSizeResolution | null;
  outImage?: string;
  previewOutImage?: string;
  expectImage?: boolean;
  events: JsonEventWriter;
}) {
  const normalizedBody = normalizeImageSizeInBody(input.body);
  const result = await executeOpenAi({
    endpoint: buildOpenAiOperationEndpoint(input.provider, input.operation),
    apiKey: input.apiKey,
    operation: input.operation,
    body: normalizedBody.body,
    providerName:
      input.provider.type === "openai-compatible" ? "openai-compatible" : "openai",
    events: input.events,
    outPath: input.outImage,
    previewOutPath: input.previewOutImage,
    sizeResolution: input.sizeResolution ?? normalizedBody.sizeResolution,
  });
  const imageOutput =
    result.files.length === 0
      ? null
      : input.outImage
        ? summarizeSavedOutput(result.files)
        : {
            available: true,
            count: result.files.length,
            suggested_extension: ".png",
          };
  if (input.expectImage && !imageOutput) {
    throw new CliError("missing_image_result", "The response did not include a generated image.");
  }
  return {
    payload: result.payload,
    imageOutput,
    previewImageOutput:
      result.previewFiles.length === 0
        ? null
        : input.previewOutImage
          ? summarizeSavedOutput(result.previewFiles)
          : {
              available: true,
              count: result.previewFiles.length,
              suggested_extension: ".png",
            },
  };
}

async function executeOpenAi(input: {
  endpoint: string;
  apiKey: string;
  operation: "generate" | "edit";
  body: Record<string, unknown>;
  providerName: string;
  events: JsonEventWriter;
  outPath?: string;
  previewOutPath?: string;
  sizeResolution?: ImageSizeResolution | null;
}) {
  const userAgent = resolveUserAgent(readConfig());
  if (input.sizeResolution?.changed) {
    input.events.emit("local", "size.normalized", {
      provider: input.providerName,
      requested: input.sizeResolution.requested,
      normalized_input: input.sizeResolution.normalized_input,
      resolved: input.sizeResolution.resolved,
      oversize_adjusted: input.sizeResolution.oversize_adjusted,
      message:
        input.sizeResolution.message ||
        `Requested size ${input.sizeResolution.requested} resolved to ${input.sizeResolution.resolved}.`,
    });
    input.events.emit("progress", "size_normalized", {
      phase: "size_normalized",
      status: "running",
      percent: 0,
      provider: input.providerName,
      requested: input.sizeResolution.requested,
      normalized_input: input.sizeResolution.normalized_input,
      resolved: input.sizeResolution.resolved,
      oversize_adjusted: input.sizeResolution.oversize_adjusted,
      message:
        input.sizeResolution.message ||
        `Requested size ${input.sizeResolution.requested} resolved to ${input.sizeResolution.resolved}.`,
    });
  }
  input.events.emit("local", "request.started", {
    endpoint: input.endpoint,
    provider: input.providerName,
    ...(input.operation === "edit" ? { transport: "multipart" } : {}),
  });
  input.events.emit("progress", "request_started", {
    phase: "request_started",
    status: "running",
    percent: 0,
    message:
      input.operation === "edit"
        ? "OpenAI multipart image edit request started."
        : "OpenAI image request sent.",
    endpoint: input.endpoint,
    provider: input.providerName,
    ...(input.operation === "edit" ? { transport: "multipart" } : {}),
  });

  let response: Response;
  if (input.operation === "edit") {
    const form = await buildOpenAiEditForm(input.body);
    input.events.emit("progress", "multipart_prepared", {
      phase: "multipart_prepared",
      status: "running",
      percent: 10,
      transport: "multipart",
      provider: input.providerName,
      message: "OpenAI multipart image payload prepared.",
    });
    response = await fetch(input.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        Accept: "application/json, text/event-stream",
        ...buildUserAgentHeaders(userAgent),
      },
      body: form,
      signal: AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS),
    }).catch((error) => {
      throw new CliError("network_error", "OpenAI multipart request failed.", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  } else {
    response = await fetch(input.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...buildUserAgentHeaders(userAgent),
      },
      body: JSON.stringify(input.body),
      signal: AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS),
    }).catch((error) => {
      throw new CliError("network_error", "OpenAI request failed.", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (!response.ok) {
    const responseText = await readResponseText(response);
    throw new CliError(
      "http_error",
      `${response.status} ${parseErrorMessage(responseText) || response.statusText}`,
    );
  }

  const transport = isSseContentType(contentType) ? "sse" : "json";
  const payload =
    transport === "sse"
      ? await readOpenAiSsePayload(
          response,
          input.events,
          input.providerName,
          input.previewOutPath,
        )
      : await readOpenAiJsonPayload(response);

  const items = payload.data ?? [];
  input.events.emit("progress", "request_completed", {
    phase: "request_completed",
    status: "running",
    percent: 95,
    created: payload.created ?? null,
    image_count: items.length,
    message: "OpenAI image response received.",
    provider: input.providerName,
    transport,
  });

  const buffers = await decodeImages(items, undefined, userAgent);
  const files =
    input.outPath && buffers.length ? writeImageOutputs(buffers, input.outPath) : [];
  const previewFiles = payload.preview_data?.length && input.previewOutPath
    ? writeImageOutputs(
        payload.preview_data.map((item) => decodeSingleImage(item)),
        input.previewOutPath,
      )
    : [];
  if (previewFiles.length) {
    input.events.emit("progress", "preview_saved", {
      phase: "preview_saved",
      status: "running",
      percent: 75,
      provider: input.providerName,
      file_count: previewFiles.length,
      message: "Preview image files saved.",
      output: summarizeSavedOutput(previewFiles),
    });
  }
  if (files.length) {
    input.events.emit("progress", "output_saved", {
      phase: "output_saved",
      status: "completed",
      percent: 100,
      provider: input.providerName,
      file_count: files.length,
      message: "Generated image files saved.",
      output: summarizeSavedOutput(files),
    });
  }

  return {
    payload,
    files,
    previewFiles,
  };
}

function isSseContentType(contentType: string) {
  return contentType.includes("text/event-stream");
}

async function readOpenAiJsonPayload(response: Response) {
  const responseText = await readResponseText(response);
  try {
    return JSON.parse(responseText) as OpenAiPayload;
  } catch {
    throw new CliError("invalid_json_response", "OpenAI Images API returned invalid JSON.");
  }
}

async function readOpenAiSsePayload(
  response: Response,
  events: JsonEventWriter,
  providerName: string,
  previewOutPath?: string,
) {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new CliError("request_failed", "Unable to read OpenAI-compatible SSE response.");
  }
  const decoder = new TextDecoder();
  let buffered = "";
  const payload: OpenAiPayload = {};
  let responseError: Record<string, unknown> | null = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    const parts = buffered.split(/\r?\n\r?\n/);
    buffered = parts.pop() ?? "";
    for (const part of parts) {
      responseError = processOpenAiSsePart(
        part,
        payload,
        responseError,
        events,
        providerName,
        previewOutPath,
      );
    }
  }
  buffered += decoder.decode();
  if (buffered.trim()) {
    responseError = processOpenAiSsePart(
      buffered,
      payload,
      responseError,
      events,
      providerName,
      previewOutPath,
    );
  }
  if (responseError && !(payload.data?.length)) {
    throw new CliError("request_failed", formatOpenAiEventError(responseError));
  }
  return payload;
}

function processOpenAiSsePart(
  part: string,
  payload: OpenAiPayload,
  currentError: Record<string, unknown> | null,
  events: JsonEventWriter,
  providerName: string,
  previewOutPath?: string,
) {
  let eventType = "message";
  const dataLines: string[] = [];
  const comments: string[] = [];
  for (const line of part.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith(":")) {
      comments.push(line.slice(1).trimStart());
      continue;
    }
    if (line.startsWith("event:")) {
      eventType = line.slice("event:".length).trimStart() || "message";
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }
  if (!dataLines.length) {
    if (comments.length) {
      events.emit("sse", "keepalive", { comment: comments.join("\n") || null });
    }
    return currentError;
  }
  const raw = dataLines.join("\n");
  if (!raw) return currentError;
  if (raw === "[DONE]") {
    events.emit("sse", "done", { raw: "[DONE]" });
    return currentError;
  }
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    throw new CliError("invalid_json_response", "OpenAI-compatible SSE returned invalid JSON.", {
      payload: raw,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  events.emit("sse", eventType, redactEventPayload(event) as Record<string, unknown>);
  emitOpenAiProgressEvent(eventType, event, payload, events, providerName);
  mergeOpenAiPayload(payload, event, eventType, previewOutPath !== undefined);
  const responseError = extractOpenAiEventError(event);
  return responseError ?? currentError;
}

function emitOpenAiProgressEvent(
  eventType: string,
  event: Record<string, unknown>,
  payload: OpenAiPayload,
  events: JsonEventWriter,
  providerName: string,
) {
  switch (eventType) {
    case "response.created":
      events.emit("progress", "response_created", {
        phase: "response_created",
        status: "running",
        percent: 15,
        provider: providerName,
        created: asNumberOrNull((event as OpenAiPayload).created),
        message: "OpenAI-compatible stream accepted the image request.",
      });
      break;
    case "response.output_item.done":
      events.emit("progress", "output_item_done", {
        phase: "output_item_done",
        status: "running",
        percent: 85,
        provider: providerName,
        image_count: countOpenAiImagesForEvent(event, payload),
        message: "OpenAI-compatible stream finished one image output item.",
      });
      break;
    case "image_generation.partial_image":
      events.emit("progress", "response_in_progress", {
        phase: "response_in_progress",
        status: "running",
        percent: 60,
        provider: providerName,
        partial_image_index: asNumberOrNull((event as VendorTopLevelImageEvent).partial_image_index),
        message: "OpenAI-compatible stream emitted a partial image preview.",
      });
      break;
    case "image_generation.completed":
      events.emit("progress", "output_item_done", {
        phase: "output_item_done",
        status: "running",
        percent: 85,
        provider: providerName,
        image_count: countOpenAiImagesForEvent(event, payload),
        message: "OpenAI-compatible stream finished one image output item.",
      });
      events.emit("progress", "response_completed", {
        phase: "response_completed",
        status: "running",
        percent: 95,
        provider: providerName,
        image_count: countOpenAiImagesForEvent(event, payload),
        message: "OpenAI-compatible stream completed the server-side image response.",
      });
      break;
    case "response.completed":
      events.emit("progress", "response_completed", {
        phase: "response_completed",
        status: "running",
        percent: 95,
        provider: providerName,
        image_count: countOpenAiImagesForEvent(event, payload),
        message: "OpenAI-compatible stream completed the server-side image response.",
      });
      break;
    case "response.failed":
    case "error": {
      const error = extractOpenAiEventError(event);
      events.emit("progress", "request_failed", {
        phase: "request_failed",
        status: "failed",
        provider: providerName,
        error,
        message: "OpenAI-compatible stream reported an image generation error.",
      });
      break;
    }
    default:
      break;
  }
}

function mergeOpenAiPayload(
  target: OpenAiPayload,
  event: Record<string, unknown>,
  eventType?: string,
  collectPreviews = false,
) {
  const candidate = selectOpenAiPayloadCandidate(event);
  if (!candidate) return;
  if (candidate.created !== undefined) target.created = candidate.created;
  if (candidate.data !== undefined) target.data = candidate.data;
  const topLevelImage = extractTopLevelImageItem(candidate);
  if (topLevelImage) {
    if (collectPreviews && eventType === "image_generation.partial_image") {
      target.preview_data = [...(target.preview_data ?? []), topLevelImage];
    }
    target.data = [topLevelImage];
  }
  if (candidate.error !== undefined) target.error = candidate.error;
  if (candidate.usage !== undefined) target.usage = candidate.usage;
  if (candidate.background !== undefined) target.background = candidate.background;
  if (candidate.output_format !== undefined) target.output_format = candidate.output_format;
  if (candidate.quality !== undefined) target.quality = candidate.quality;
  if (candidate.size !== undefined) target.size = candidate.size;
}

function selectOpenAiPayloadCandidate(event: Record<string, unknown>) {
  if (looksLikeOpenAiPayload(event)) return event as OpenAiPayload;
  const response = asRecord(event.response);
  if (response && looksLikeOpenAiPayload(response)) return response as OpenAiPayload;
  return null;
}

function looksLikeOpenAiPayload(value: Record<string, unknown>) {
  return (
    Array.isArray(value.data) ||
    typeof value.b64_json === "string" ||
    value.b64_json === null ||
    typeof value.url === "string" ||
    "created" in value ||
    "created_at" in value ||
    "error" in value ||
    "usage" in value ||
    "background" in value ||
    "output_format" in value ||
    "quality" in value ||
    "size" in value
  );
}

function extractTopLevelImageItem(value: OpenAiPayload) {
  const topLevel = value as VendorTopLevelImageEvent;
  if (typeof topLevel.b64_json === "string" || topLevel.b64_json === null || typeof topLevel.url === "string") {
    return {
      b64_json: topLevel.b64_json,
      url: topLevel.url,
    } satisfies OpenAiImageItem;
  }
  return null;
}

function countOpenAiImagesForEvent(event: Record<string, unknown>, payload: OpenAiPayload) {
  const candidate = selectOpenAiPayloadCandidate(event);
  if (candidate?.data) return candidate.data.length;
  if (extractTopLevelImageItem((candidate ?? event) as OpenAiPayload)) return 1;
  return payload.data?.length ?? 0;
}

function decodeSingleImage(item: OpenAiImageItem) {
  if (typeof item.b64_json === "string") {
    if (!item.b64_json.trim()) {
      throw new CliError("invalid_image_payload", "图片返回包含空的 b64_json，已阻止生成 0 字节文件。");
    }
    return Buffer.from(item.b64_json, "base64");
  }
  throw new CliError("invalid_image_payload", "预览图片接口没有返回可用的 b64_json。");
}

function extractOpenAiEventError(event: Record<string, unknown>) {
  const direct = asRecord(event.error);
  if (direct) return direct;
  const response = asRecord(event.response);
  const nested = response ? asRecord(response.error) : null;
  return nested;
}

async function readResponseText(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) {
    return response.text();
  }
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
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

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNumberOrNull(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatOpenAiEventError(error: Record<string, unknown>) {
  const message =
    typeof error.message === "string" && error.message.trim()
      ? error.message.trim()
      : "Image generation failed without structured error details.";
  const code =
    typeof error.code === "string" && error.code.trim() ? error.code.trim() : null;
  return code ? `${code}: ${message}` : message;
}

async function decodeImages(items: OpenAiImageItem[], signal?: AbortSignal, userAgent?: string) {
  if (!items.length) {
    throw new CliError("invalid_response", "接口响应里没有生成图片。");
  }
  const buffers: Buffer[] = [];
  for (const [index, item] of items.entries()) {
    if (typeof item.b64_json === "string") {
      if (!item.b64_json.trim()) {
        throw new CliError(
          "invalid_image_payload",
          "图片返回包含空的 b64_json，已阻止生成 0 字节文件。",
          { index },
        );
      }
      buffers.push(Buffer.from(item.b64_json, "base64"));
      continue;
    }
    if (item.b64_json === null || item.b64_json === undefined) {
      if (!item.url) {
        throw new CliError(
          "invalid_image_payload",
          "图片接口没有返回可用的 b64_json 或 url。",
          { index },
        );
      }
      const response = await fetch(item.url, {
        signal,
        headers: buildUserAgentHeaders(userAgent ?? resolveUserAgent(readConfig())),
      });
      if (!response.ok) {
        throw new CliError("http_error", `${response.status} ${response.statusText}`);
      }
      buffers.push(Buffer.from(await response.arrayBuffer()));
      continue;
    }
    throw new CliError("invalid_image_payload", "图片响应中的 b64_json 字段类型无效。", {
      index,
    });
  }
  return buffers;
}

function buildOpenAiOperationEndpoint(provider: ProviderConfig, operation: "generate" | "edit") {
  const base = (provider.api_base || DEFAULT_OPENAI_API_BASE).replace(/\/+$/, "");
  return `${base}${operation === "edit" ? OPENAI_EDITS_PATH : OPENAI_GENERATIONS_PATH}`;
}

function addField(target: Record<string, unknown>, key: string, value: unknown) {
  if (value === undefined || value === null || value === "") return;
  target[key] = value;
}

async function buildOpenAiEditForm(body: Record<string, unknown>) {
  const form = new FormData();
  for (const key of [
    "model",
    "prompt",
    "size",
    "quality",
    "background",
    "output_format",
    "output_compression",
    "n",
    "moderation",
    "input_fidelity",
    "response_format",
    "stream",
  ]) {
    const value = body[key];
    if (value === undefined || value === null || value === "") continue;
    form.append(key, String(value));
  }
  const imageSources = extractOpenAiEditImageSources(body);
  if (!imageSources.length) {
    throw new CliError("missing_image_result", "OpenAI edit requests require at least one input image.");
  }
  for (const [index, source] of imageSources.entries()) {
    const loaded = await loadImageSourceBytes(source, `image-${index + 1}`);
    form.append(
      "image[]",
      new File([loaded.bytes], loaded.fileName, { type: loaded.mimeType }),
      loaded.fileName,
    );
  }
  const maskSource = extractOpenAiMaskSource(body);
  if (maskSource) {
    const loaded = await loadImageSourceBytes(maskSource, "mask");
    form.append(
      "mask",
      new File([loaded.bytes], loaded.fileName, { type: loaded.mimeType }),
      loaded.fileName,
    );
  }
  return form;
}

function extractOpenAiEditImageSources(body: Record<string, unknown>) {
  const images = body.images;
  if (Array.isArray(images)) {
    return images
      .map((entry) => {
        if (typeof entry === "string") return entry;
        if (
          entry &&
          typeof entry === "object" &&
          typeof (entry as { image_url?: unknown }).image_url === "string"
        ) {
          return (entry as { image_url: string }).image_url;
        }
        return null;
      })
      .filter((value): value is string => Boolean(value));
  }
  if (typeof body.image === "string") return [body.image];
  return [];
}

function extractOpenAiMaskSource(body: Record<string, unknown>) {
  const mask = body.mask;
  if (typeof mask === "string") return mask;
  if (
    mask &&
    typeof mask === "object" &&
    typeof (mask as { image_url?: unknown }).image_url === "string"
  ) {
    return (mask as { image_url: string }).image_url;
  }
  return null;
}

function parseErrorMessage(text: string) {
  try {
    const json = JSON.parse(text) as OpenAiPayload;
    return json.error?.message || text;
  } catch {
    return text;
  }
}

export function summarizeSavedOutput(files: OutputFile[]) {
  return {
    path: files[0]?.path ?? null,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    files,
  };
}
