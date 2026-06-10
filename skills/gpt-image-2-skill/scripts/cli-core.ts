import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  installBackgroundRemoveDependencies,
  inspectBackgroundRemoveEnvironment,
  runBackgroundRemoveCommand,
} from "./background-remove-client.ts";
import { CliError, asError } from "./errors.ts";
import { JsonEventWriter } from "./json-events.ts";
import type { JsonError } from "./types.ts";
import {
  DEFAULT_CODEX_ENDPOINT,
  DEFAULT_CODEX_MODEL,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_RETRY_COUNT,
  OPENAI_API_KEY_ENV,
} from "./constants.ts";
import {
  authPath,
  checkEndpointReachability,
  configPath,
  readConfig,
  resolveApiKey,
  resolveProvider,
  resolveProviderName,
  sanitizeConfig,
  saveConfig,
  validateProviderName,
} from "./config-store.ts";
import { inspectCodexAuth, runCodexImageCommand, runCodexRequestCreate } from "./codex-client.ts";
import {
  requestCreateOpenAi,
  requestEdit,
  requestGenerate,
  summarizeSavedOutput,
} from "./openai-client.ts";
import type { ImageSizeResolution } from "./image-size.ts";
import { normalizeImageSizeInBody, resolveImageSize } from "./image-size.ts";
import type { ProviderKind } from "./types.ts";
import {
  runTransparentExtract,
  runTransparentGenerate,
  runTransparentVerify,
} from "./transparent-client.ts";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_JSON_PATH = path.join(SCRIPT_DIR, "package.json");

function readCliVersion() {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(PACKAGE_JSON_PATH, "utf8"),
    ) as { version?: string };
    return parsed.version?.trim() || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const CLI_VERSION = readCliVersion();

export async function runCli(argv: string[]) {
  const flags = parseGlobalFlags(argv);
  const events = new JsonEventWriter(flags.jsonEvents);
  try {
    const result = await dispatch(flags.rest, events, flags.provider);
    if (flags.json) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else if (typeof result === "string") {
      process.stdout.write(`${result}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
    return 0;
  } catch (error) {
    return emitError(flags.json, asError(error));
  }
}

async function dispatch(argv: string[], events: JsonEventWriter, globalProvider?: string) {
  const [group, command, ...rest] = argv;
  if (!group) throw new CliError("invalid_command", "Missing command.");
  if (group === "--version" || group === "version") return CLI_VERSION;
  if (group === "config") return handleConfig(command, rest);
  if (group === "auth") return handleAuth(command);
  if (group === "doctor") return handleDoctor(rest, globalProvider);
  if (group === "background" || group === "background-remove") return handleBackground(command, rest);
  if (group === "images") return handleImages(command, rest, events, globalProvider);
  if (group === "request") return handleRequest(command, rest, events, globalProvider);
  if (group === "transparent") return handleTransparent(command, rest, events, globalProvider);
  throw new CliError("invalid_command", `Unknown command: ${group}`);
}

function emitError(asJson: boolean, error: JsonError) {
  if (asJson) {
    process.stdout.write(
      `${JSON.stringify({
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          ...(error.detail === undefined ? {} : { detail: error.detail }),
        },
      })}\n`,
    );
  } else {
    process.stderr.write(`${error.message}\n`);
  }
  return 1;
}

function parseGlobalFlags(argv: string[]) {
  let json = false;
  let jsonEvents = false;
  let provider: string | undefined;
  const rest: string[] = [];
  let commandStarted = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--json-events") {
      jsonEvents = true;
      continue;
    }
    if (!commandStarted && arg === "--provider") {
      provider = argv[i + 1];
      i += 1;
      continue;
    }
    rest.push(arg);
    commandStarted = true;
  }
  return { json, jsonEvents, provider, rest };
}

async function handleConfig(command?: string, rest: string[] = []) {
  const config = readConfig();
  if (command === "inspect") {
    return {
      ok: true,
      command: "config inspect",
      config_file: configPath(),
      config: sanitizeConfig(config),
    };
  }
  if (command === "set-user-agent") {
    const args = parseConfigSetUserAgentArgs(rest);
    const userAgent = args.value.trim();
    if (!userAgent) {
      throw new CliError("invalid_argument", "User agent must not be empty.");
    }
    const next = readConfig();
    next.user_agent = userAgent;
    saveConfig(next);
    return {
      ok: true,
      command: "config set-user-agent",
      config_file: configPath(),
      config: sanitizeConfig(next),
    };
  }
  if (command === "clear-user-agent") {
    if (rest.length) {
      throw new CliError("invalid_command", `Unexpected config clear-user-agent args: ${rest.join(" ")}`);
    }
    const next = readConfig();
    delete next.user_agent;
    saveConfig(next);
    return {
      ok: true,
      command: "config clear-user-agent",
      config_file: configPath(),
      config: sanitizeConfig(next),
    };
  }
  if (command === "path") {
    return {
      ok: true,
      command: "config path",
      path: configPath(),
    };
  }
  if (command === "add-provider") {
    const args = parseConfigAddProviderArgs(rest);
    validateProviderName(args.name);
    if (args.supportsN && args.noSupportsN) {
      throw new CliError("invalid_provider_config", "Use either --supports-n or --no-supports-n, not both.");
    }
    const next = readConfig();
    const providerType = args.providerType as ProviderKind;
    next.providers[args.name] = {
      type: providerType,
      api_base: args.apiBase,
      endpoint: args.endpoint,
      model:
        args.model ||
        (providerType === "codex" ? DEFAULT_CODEX_MODEL : DEFAULT_OPENAI_MODEL),
      stream: args.stream,
      supports_n: args.supportsN ? true : args.noSupportsN ? false : undefined,
      edit_region_mode: args.editRegionMode as "native-mask" | "reference-hint" | "none" | undefined,
      credentials: {
        ...(args.apiKey ? { api_key: { source: "file", value: args.apiKey } } : {}),
        ...(args.apiKeyEnv ? { api_key: { source: "env", env: args.apiKeyEnv } } : {}),
        ...(args.accountId ? { account_id: { source: "file", value: args.accountId } } : {}),
        ...(args.accessToken ? { access_token: { source: "file", value: args.accessToken } } : {}),
        ...(args.refreshToken ? { refresh_token: { source: "file", value: args.refreshToken } } : {}),
      },
    };
    if (args.setDefault || !next.default_provider) {
      next.default_provider = args.name;
    }
    saveConfig(next);
    return {
      ok: true,
      command: "config add-provider",
      provider: args.name,
      config_file: configPath(),
      config: sanitizeConfig(next),
    };
  }
  if (command === "test-provider") {
    const args = parseConfigTestProviderArgs(rest);
    const provider = resolveProvider(config, args.name);
    const endpoint = await checkEndpointReachability(
      provider.type === "codex"
        ? provider.endpoint || DEFAULT_CODEX_ENDPOINT
        : provider.api_base || "https://api.openai.com/v1",
    );
    return {
      ok: endpoint.reachable,
      command: "config test-provider",
      provider_selection: { resolved: args.name },
      endpoint,
    };
  }
  throw new CliError("invalid_command", `Unknown config command: ${command ?? ""}`.trim());
}

function handleAuth(command?: string) {
  if (command !== "inspect") {
    throw new CliError("invalid_command", `Unknown auth command: ${command ?? ""}`.trim());
  }
  const openaiReady = Boolean(process.env[OPENAI_API_KEY_ENV]?.trim());
  return {
    ok: true,
    command: "auth inspect",
    providers: {
      openai: {
        provider: "openai",
        ready: openaiReady,
        auth_source: openaiReady ? "env" : null,
        api_key_present: openaiReady,
      },
      codex: inspectCodexAuth(),
    },
  };
}

function handleDoctor(rest: string[], globalProvider?: string) {
  if (rest.length) {
    throw new CliError("invalid_command", `Unexpected doctor args: ${rest.join(" ")}`);
  }
  const config = readConfig();
  const auth = handleAuth("inspect") as ReturnType<typeof handleAuth>;
  const background = inspectBackgroundRemoveEnvironment();
  return {
    ok: true,
    command: "doctor",
    provider_selection: resolveProviderName(config, auth.providers.openai.ready, globalProvider),
    retry_policy: {
      max_retries: DEFAULT_RETRY_COUNT,
      base_delay_seconds: 1,
    },
    config_file: configPath(),
    background_remove: {
      ready: background.ready,
      script_path: background.scriptPath,
      script_exists: background.scriptExists,
      python: background.python,
      methods: background.methods,
      install_hints: background.installHints,
    },
  };
}

function handleBackground(command?: string, rest: string[] = []) {
  if (command === "doctor") {
    const options = parseBackgroundEnvironmentArgs(rest, "doctor");
    const install = options.install ? installBackgroundRemoveDependencies({ includeOptional: true }) : null;
    const environment = install?.environmentAfter ?? inspectBackgroundRemoveEnvironment();
    return {
      ok: true,
      command: "background doctor",
      ready: environment.ready,
      environment: normalizeBackgroundEnvironment(environment),
      ...(install ? { install: normalizeBackgroundInstall(install) } : {}),
    };
  }
  if (command === "init") {
    const options = parseBackgroundEnvironmentArgs(rest, "init");
    const install = options.install ? installBackgroundRemoveDependencies({ includeOptional: true }) : null;
    const environment = install?.environmentAfter ?? inspectBackgroundRemoveEnvironment();
    return {
      ok: true,
      command: "background init",
      initialized: environment.ready,
      environment: normalizeBackgroundEnvironment(environment),
      ...(install ? { install: normalizeBackgroundInstall(install) } : {}),
      next_steps:
        environment.installHints.length > 0
          ? environment.installHints
          : [
              "Background removal runtime is ready.",
              "Use `background remove --input ...` for direct cutouts or `transparent generate` for integrated PNG workflows.",
            ],
    };
  }
  if (command === "remove") {
    const args = parseBackgroundRemoveArgs(rest);
    const result = runBackgroundRemoveCommand({
      inputs: args.inputs,
      output: args.output,
      method: args.method,
    });
    if (!result.success) {
      throw new CliError("background_remove_failed", result.error || "Background removal failed.", {
        requested_method: args.method,
        results: result.results,
        environment: {
          python: {
            resolved: result.python,
            version: result.pythonVersion,
          },
          script_path: result.scriptPath,
        },
      });
    }
    return {
      ok: true,
      command: "background remove",
      requested_method: args.method,
      environment: {
        python: {
          resolved: result.python,
          version: result.pythonVersion,
        },
        script_path: result.scriptPath,
      },
      summary: {
        total: result.results.length,
        success: result.results.filter((entry) => entry.success).length,
        failed: result.results.filter((entry) => !entry.success).length,
      },
      results: result.results,
      ...(result.results.length === 1 && result.results[0]?.file
        ? { output: summarizeLocalOutput(result.results[0].file) }
        : {}),
      ...(result.error ? { error_message: result.error } : {}),
    };
  }
  throw new CliError("invalid_command", `Unknown background command: ${command ?? ""}`.trim());
}

async function handleImages(
  command: string | undefined,
  rest: string[],
  events: JsonEventWriter,
  globalProvider?: string,
) {
  if (!command) throw new CliError("invalid_command", "Missing images subcommand.");
  if (command !== "generate" && command !== "edit") {
    throw new CliError("invalid_command", `Unknown images command: ${command}`);
  }
  const options = parseImageArgs(rest, command);
  const config = readConfig();
  const providerSelection = resolveProviderName(
    config,
    Boolean(process.env[OPENAI_API_KEY_ENV]?.trim()),
    options.provider ?? globalProvider,
  );
  const providerName = providerSelection.resolved;
  const provider = resolveProvider(config, providerName);

  if (provider.type === "codex") {
    const result = await runCodexImageCommand({
      providerName,
      provider,
      command,
      prompt: options.prompt,
      out: options.out,
      instructions: options.instructions,
      refImages: options.refImages,
      background: options.background,
      size: options.size,
      quality: options.quality,
      format: options.format,
      compression: options.compression,
      stream: options.stream,
      events,
    });
    return {
      ok: true,
      command: `images ${command}`,
      provider_selection: providerSelection,
      request: {
        operation: command,
        ...result.requestBody,
      },
      retry: {
        count: result.outcome.retryCount,
        max_retries: DEFAULT_RETRY_COUNT,
      },
      output: summarizeSavedOutput(result.files),
      ...(options.sizeResolution?.changed ? { size_normalization: options.sizeResolution } : {}),
      data: {
        response: result.outcome.response,
        output_items: result.outcome.outputItems,
        image_items: result.outcome.imageItems,
      },
      auth: {
        refreshed: result.outcome.refreshed,
      },
      events: { count: events.count() },
    };
  }

  const apiKey = resolveApiKey(provider, options.apiKey);
  const controller = new AbortController();
  if (command === "generate") {
    const result = await requestGenerate(
      provider,
      apiKey,
      {
        prompt: options.prompt,
        out: options.out,
        previewOut: options.previewOut,
        size: options.size,
        sizeResolution: options.sizeResolution,
        quality: options.quality,
        format: options.format,
        background: options.background,
        compression: options.compression,
        moderation: options.moderation,
        n: options.n,
        stream: options.stream,
      },
      controller.signal,
      events,
    );
    return {
      ok: true,
      command: "images generate",
      provider_selection: providerSelection,
      request: {
        operation: "generate",
        ...result.requestBody,
      },
      retry: { count: 0, max_retries: DEFAULT_RETRY_COUNT },
      output: summarizeSavedOutput(result.files),
      ...(options.sizeResolution?.changed ? { size_normalization: options.sizeResolution } : {}),
      ...(result.previewFiles?.length
        ? { preview_output: summarizeSavedOutput(result.previewFiles) }
        : {}),
      data: result.payload,
      events: { count: events.count() },
    };
  }
  const result = await requestEdit(
    provider,
    apiKey,
    {
      prompt: options.prompt,
      out: options.out,
      previewOut: options.previewOut,
      size: options.size,
      sizeResolution: options.sizeResolution,
      quality: options.quality,
      format: options.format,
      background: options.background,
      compression: options.compression,
      moderation: options.moderation,
      n: options.n,
      refImages: options.refImages,
      mask: options.mask,
      stream: options.stream,
    },
    controller.signal,
    events,
  );
  return {
    ok: true,
    command: "images edit",
    provider_selection: providerSelection,
    request: {
      operation: "edit",
      ...result.requestBody,
    },
    retry: { count: 0, max_retries: DEFAULT_RETRY_COUNT },
    output: summarizeSavedOutput(result.files),
    ...(options.sizeResolution?.changed ? { size_normalization: options.sizeResolution } : {}),
    ...(result.previewFiles?.length
      ? { preview_output: summarizeSavedOutput(result.previewFiles) }
      : {}),
    data: result.payload,
    events: { count: events.count() },
  };
}

async function handleRequest(
  command: string | undefined,
  rest: string[],
  events: JsonEventWriter,
  globalProvider?: string,
) {
  if (command !== "create") {
    throw new CliError("invalid_command", `Unknown request command: ${command ?? ""}`.trim());
  }
  const args = parseRequestCreateArgs(rest);
  const config = readConfig();
  const providerSelection = resolveProviderName(
    config,
    Boolean(process.env[OPENAI_API_KEY_ENV]?.trim()),
    args.provider ?? globalProvider,
  );
  const providerName = providerSelection.resolved;
  const provider = resolveProvider(config, providerName);
  const body = readBodyJson(args.bodyFile);
  const normalizedBody = normalizeImageSizeInBody({
    ...body,
    ...(args.stream !== undefined ? { stream: args.stream } : {}),
    ...(args.outImage ? { out_image: args.outImage } : {}),
  });

  if (provider.type === "codex") {
    if (args.requestOperation !== "responses") {
      throw new CliError("unsupported_option", "Codex request create uses --request-operation responses.");
    }
    const result = await runCodexRequestCreate({
      providerName,
      provider,
      body: normalizedBody.body,
      outImage: args.outImage,
      expectImage: args.expectImage,
      events,
    });
    return {
      ok: true,
      command: "request create",
      provider: providerName,
      provider_selection: providerSelection,
      request: {
        operation: "responses",
        body_file: args.bodyFile,
      },
      ...(normalizedBody.sizeResolution?.changed
        ? { size_normalization: normalizedBody.sizeResolution }
        : {}),
      response: result.outcome.response,
      output_items: result.outcome.outputItems,
      image_output: result.imageOutput,
      retry: {
        count: result.outcome.retryCount,
        max_retries: DEFAULT_RETRY_COUNT,
      },
      auth: {
        refreshed: result.outcome.refreshed,
      },
      events: { count: events.count() },
    };
  }

  if (args.requestOperation !== "generate" && args.requestOperation !== "edit") {
    throw new CliError("unsupported_option", "OpenAI request create uses --request-operation generate or edit.");
  }
  const apiKey = resolveApiKey(provider, args.apiKey);
  const result = await requestCreateOpenAi({
    provider,
    apiKey,
    operation: args.requestOperation,
    body: normalizedBody.body,
    sizeResolution: normalizedBody.sizeResolution,
    outImage: args.outImage,
    previewOutImage: args.previewOutImage,
    expectImage: args.expectImage,
    events,
  });
  return {
    ok: true,
    command: "request create",
    provider: providerName,
    provider_selection: providerSelection,
    request: {
      operation: args.requestOperation,
      body_file: args.bodyFile,
      model: body.model ?? null,
    },
    ...(normalizedBody.sizeResolution?.changed
      ? { size_normalization: normalizedBody.sizeResolution }
      : {}),
    response: result.payload,
    image_output: result.imageOutput,
    ...(result.previewImageOutput ? { preview_output: result.previewImageOutput } : {}),
    retry: {
      count: 0,
      max_retries: DEFAULT_RETRY_COUNT,
    },
    events: { count: events.count() },
  };
}

async function handleTransparent(
  command: string | undefined,
  rest: string[],
  events: JsonEventWriter,
  globalProvider?: string,
) {
  if (command === "verify") {
    return runTransparentVerify(parseTransparentVerifyArgs(rest));
  }
  if (command === "extract") {
    return runTransparentExtract(parseTransparentExtractArgs(rest) as Parameters<typeof runTransparentExtract>[0]);
  }
  if (command === "generate") {
    const args = parseTransparentGenerateArgs(rest);
    const config = readConfig();
    const providerSelection = resolveProviderName(
      config,
      Boolean(process.env[OPENAI_API_KEY_ENV]?.trim()),
      args.provider ?? globalProvider,
    );
    const providerName = providerSelection.resolved;
    const provider = resolveProvider(config, providerName);
    return runTransparentGenerate({
      providerName,
      provider,
      prompt: args.prompt,
      out: args.out,
      instructions: args.instructions,
      size: args.size,
      sizeResolution: args.sizeResolution,
      quality: args.quality,
      compression: args.compression,
      moderation: args.moderation,
      method: args.method,
      profile: args.profile,
      material: args.material,
      matteColor: args.matteColor,
      sourcePrompt: args.sourcePrompt,
      sourceOut: args.sourceOut,
      reportDir: args.reportDir,
      keepSources: args.keepSources,
      threshold: args.threshold,
      softness: args.softness,
      spillSuppression: args.spillSuppression,
      stream: args.stream,
      apiKey: provider.type === "codex" ? undefined : resolveApiKey(provider, args.apiKey),
      events,
    });
  }
  throw new CliError("invalid_command", `Unknown transparent command: ${command ?? ""}`.trim());
}

function parseImageArgs(rest: string[], command: "generate" | "edit") {
  const state = {
    provider: undefined as string | undefined,
    apiKey: undefined as string | undefined,
    instructions: undefined as string | undefined,
    prompt: "",
    out: "",
    previewOut: undefined as string | undefined,
    size: undefined as string | undefined,
    sizeResolution: null as ImageSizeResolution | null,
    quality: undefined as string | undefined,
    format: undefined as string | undefined,
    background: undefined as string | undefined,
    compression: undefined as number | undefined,
    moderation: undefined as string | undefined,
    n: undefined as number | undefined,
    stream: undefined as boolean | undefined,
    refImages: [] as string[],
    mask: undefined as string | undefined,
  };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    const value = rest[i + 1];
    switch (arg) {
      case "--provider":
        state.provider = value;
        i += 1;
        break;
      case "--api-key":
        state.apiKey = value;
        i += 1;
        break;
      case "--instructions":
        state.instructions = value;
        i += 1;
        break;
      case "--prompt":
        state.prompt = value;
        i += 1;
        break;
      case "--out":
        state.out = value;
        i += 1;
        break;
      case "--preview-out":
        state.previewOut = value;
        i += 1;
        break;
      case "--size":
        state.sizeResolution = resolveImageSize(value);
        state.size = state.sizeResolution.resolved;
        i += 1;
        break;
      case "--quality":
        state.quality = value;
        i += 1;
        break;
      case "--format":
        state.format = value;
        i += 1;
        break;
      case "--background":
        state.background = value;
        i += 1;
        break;
      case "--compression":
        state.compression = Number(value);
        i += 1;
        break;
      case "--moderation":
        state.moderation = value;
        i += 1;
        break;
      case "--n":
        state.n = Number(value);
        i += 1;
        break;
      case "--stream":
        state.stream = true;
        break;
      case "--ref-image":
        state.refImages.push(value);
        i += 1;
        break;
      case "--mask":
        state.mask = value;
        i += 1;
        break;
      default:
        throw new CliError("invalid_command", `Unknown argument: ${arg}`);
    }
  }
  if (!state.prompt) throw new CliError("invalid_command", "Missing required --prompt.");
  if (!state.out) throw new CliError("invalid_command", "Missing required --out.");
  if (command === "edit" && state.refImages.length === 0) {
    throw new CliError("invalid_command", "images edit requires at least one --ref-image.");
  }
  return state;
}

function parseTransparentVerifyArgs(rest: string[]) {
  const state = {
    input: "",
    profile: "generic",
    expectedMatteColor: undefined as string | undefined,
    strict: false,
  };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    const value = rest[i + 1];
    switch (arg) {
      case "--input":
        state.input = value;
        i += 1;
        break;
      case "--profile":
        state.profile = value;
        i += 1;
        break;
      case "--expected-matte-color":
        state.expectedMatteColor = value;
        i += 1;
        break;
      case "--strict":
        state.strict = true;
        break;
      default:
        throw new CliError("invalid_command", `Unknown argument: ${arg}`);
    }
  }
  if (!state.input) throw new CliError("invalid_command", "Missing required --input.");
  return state;
}

function parseTransparentExtractArgs(rest: string[]) {
  const state = {
    method: "auto" as "auto" | "rembg" | "chroma" | "dual",
    input: undefined as string | undefined,
    darkImage: undefined as string | undefined,
    lightImage: undefined as string | undefined,
    out: "",
    profile: "generic",
    material: undefined as string | undefined,
    matteColor: undefined as string | undefined,
    threshold: undefined as number | undefined,
    softness: undefined as number | undefined,
    spillSuppression: undefined as number | undefined,
    strict: false,
  };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    const value = rest[i + 1];
    switch (arg) {
      case "--method":
        if (value === "auto" || value === "rembg" || value === "chroma" || value === "dual") {
          state.method = value;
        } else {
          throw new CliError("invalid_argument", "transparent extract --method must be auto, rembg, chroma, or dual.");
        }
        i += 1;
        break;
      case "--input":
        state.input = value;
        i += 1;
        break;
      case "--dark-image":
        state.darkImage = value;
        i += 1;
        break;
      case "--light-image":
        state.lightImage = value;
        i += 1;
        break;
      case "--out":
        state.out = value;
        i += 1;
        break;
      case "--profile":
        state.profile = value;
        i += 1;
        break;
      case "--material":
        state.material = value;
        i += 1;
        break;
      case "--matte-color":
        state.matteColor = value;
        i += 1;
        break;
      case "--threshold":
        state.threshold = Number(value);
        i += 1;
        break;
      case "--softness":
        state.softness = Number(value);
        i += 1;
        break;
      case "--spill-suppression":
        state.spillSuppression = Number(value);
        i += 1;
        break;
      case "--strict":
        state.strict = true;
        break;
      default:
        throw new CliError("invalid_command", `Unknown argument: ${arg}`);
    }
  }
  if (!state.out) throw new CliError("invalid_command", "Missing required --out.");
  return state;
}

function parseTransparentGenerateArgs(rest: string[]) {
  const state = {
    provider: undefined as string | undefined,
    apiKey: undefined as string | undefined,
    prompt: "",
    out: "",
    instructions: undefined as string | undefined,
    size: undefined as string | undefined,
    sizeResolution: null as ImageSizeResolution | null,
    quality: undefined as string | undefined,
    compression: undefined as number | undefined,
    moderation: undefined as string | undefined,
    stream: undefined as boolean | undefined,
    method: "auto" as "auto" | "rembg" | "chroma" | "dual",
    profile: "generic",
    material: undefined as string | undefined,
    matteColor: undefined as string | undefined,
    sourcePrompt: undefined as string | undefined,
    sourceOut: undefined as string | undefined,
    reportDir: undefined as string | undefined,
    keepSources: false,
    threshold: undefined as number | undefined,
    softness: undefined as number | undefined,
    spillSuppression: undefined as number | undefined,
  };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    const value = rest[i + 1];
    switch (arg) {
      case "--provider":
        state.provider = value;
        i += 1;
        break;
      case "--api-key":
        state.apiKey = value;
        i += 1;
        break;
      case "--prompt":
        state.prompt = value;
        i += 1;
        break;
      case "--out":
        state.out = value;
        i += 1;
        break;
      case "--instructions":
        state.instructions = value;
        i += 1;
        break;
      case "--size":
        state.sizeResolution = resolveImageSize(value);
        state.size = state.sizeResolution.resolved;
        i += 1;
        break;
      case "--quality":
        state.quality = value;
        i += 1;
        break;
      case "--compression":
        state.compression = Number(value);
        i += 1;
        break;
      case "--moderation":
        state.moderation = value;
        i += 1;
        break;
      case "--stream":
        state.stream = true;
        break;
      case "--method":
        if (value === "auto" || value === "rembg" || value === "chroma" || value === "dual") {
          state.method = value;
        } else {
          throw new CliError("invalid_argument", "transparent generate --method must be auto, rembg, chroma, or dual.");
        }
        i += 1;
        break;
      case "--profile":
        state.profile = value;
        i += 1;
        break;
      case "--material":
        state.material = value;
        i += 1;
        break;
      case "--matte-color":
        state.matteColor = value;
        i += 1;
        break;
      case "--source-prompt":
        state.sourcePrompt = value;
        i += 1;
        break;
      case "--source-out":
        state.sourceOut = value;
        i += 1;
        break;
      case "--report-dir":
        state.reportDir = value;
        i += 1;
        break;
      case "--keep-sources":
        state.keepSources = true;
        break;
      case "--threshold":
        state.threshold = Number(value);
        i += 1;
        break;
      case "--softness":
        state.softness = Number(value);
        i += 1;
        break;
      case "--spill-suppression":
        state.spillSuppression = Number(value);
        i += 1;
        break;
      default:
        throw new CliError("invalid_command", `Unknown argument: ${arg}`);
    }
  }
  if (!state.prompt) throw new CliError("invalid_command", "Missing required --prompt.");
  if (!state.out) throw new CliError("invalid_command", "Missing required --out.");
  return state;
}

function parseBackgroundRemoveArgs(rest: string[]) {
  const state = {
    inputs: [] as string[],
    output: undefined as string | undefined,
    method: "rembg",
  };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    const value = rest[i + 1];
    switch (arg) {
      case "--input":
      case "-i":
        while (rest[i + 1] && !rest[i + 1]!.startsWith("-")) {
          state.inputs.push(rest[i + 1]!);
          i += 1;
        }
        break;
      case "--output":
      case "-o":
        state.output = value;
        i += 1;
        break;
      case "--method":
      case "-m":
        state.method = value;
        i += 1;
        break;
      default:
        throw new CliError("invalid_command", `Unknown argument: ${arg}`);
    }
  }
  if (state.inputs.length === 0) {
    throw new CliError("invalid_command", "background remove requires at least one --input.");
  }
  if (state.method !== "rembg" && state.method !== "builtin") {
    throw new CliError("invalid_argument", "background remove --method must be rembg or builtin.");
  }
  return state;
}

function parseBackgroundEnvironmentArgs(rest: string[], command: "doctor" | "init") {
  const state = {
    install: false,
  };
  for (const arg of rest) {
    if (arg === "--install" || arg === "--fix") {
      state.install = true;
      continue;
    }
    throw new CliError("invalid_command", `Unexpected background ${command} args: ${rest.join(" ")}`);
  }
  return state;
}

function parseRequestCreateArgs(rest: string[]) {
  const state = {
    provider: undefined as string | undefined,
    apiKey: undefined as string | undefined,
    requestOperation: "generate",
    bodyFile: "",
    outImage: undefined as string | undefined,
    previewOutImage: undefined as string | undefined,
    expectImage: false,
    stream: undefined as boolean | undefined,
  };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    const value = rest[i + 1];
    switch (arg) {
      case "--provider":
        state.provider = value;
        i += 1;
        break;
      case "--api-key":
        state.apiKey = value;
        i += 1;
        break;
      case "--request-operation":
        state.requestOperation = value;
        i += 1;
        break;
      case "--body-file":
        state.bodyFile = value;
        i += 1;
        break;
      case "--out-image":
        state.outImage = value;
        i += 1;
        break;
      case "--preview-out":
        state.previewOutImage = value;
        i += 1;
        break;
      case "--expect-image":
        state.expectImage = true;
        break;
      case "--stream":
        state.stream = true;
        break;
      default:
        throw new CliError("invalid_command", `Unknown argument: ${arg}`);
    }
  }
  if (!state.bodyFile) throw new CliError("invalid_command", "Missing required --body-file.");
  return state;
}

function parseConfigAddProviderArgs(rest: string[]) {
  const state = {
    name: "",
    providerType: "openai-compatible",
    apiBase: undefined as string | undefined,
    endpoint: undefined as string | undefined,
    model: undefined as string | undefined,
    apiKey: undefined as string | undefined,
    apiKeyEnv: undefined as string | undefined,
    accountId: undefined as string | undefined,
    accessToken: undefined as string | undefined,
    refreshToken: undefined as string | undefined,
    stream: undefined as boolean | undefined,
    supportsN: false,
    noSupportsN: false,
    editRegionMode: undefined as string | undefined,
    setDefault: false,
  };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    const value = rest[i + 1];
    switch (arg) {
      case "--name":
        state.name = value;
        i += 1;
        break;
      case "--type":
        state.providerType = value;
        i += 1;
        break;
      case "--api-base":
        state.apiBase = value;
        i += 1;
        break;
      case "--endpoint":
        state.endpoint = value;
        i += 1;
        break;
      case "--model":
        state.model = value;
        i += 1;
        break;
      case "--api-key":
        state.apiKey = value;
        i += 1;
        break;
      case "--api-key-env":
        state.apiKeyEnv = value;
        i += 1;
        break;
      case "--account-id":
        state.accountId = value;
        i += 1;
        break;
      case "--access-token":
        state.accessToken = value;
        i += 1;
        break;
      case "--refresh-token":
        state.refreshToken = value;
        i += 1;
        break;
      case "--stream":
        state.stream = true;
        break;
      case "--supports-n":
        state.supportsN = true;
        break;
      case "--no-supports-n":
        state.noSupportsN = true;
        break;
      case "--edit-region-mode":
        state.editRegionMode = value;
        i += 1;
        break;
      case "--set-default":
        state.setDefault = true;
        break;
      default:
        throw new CliError("invalid_command", `Unknown argument: ${arg}`);
    }
  }
  if (!state.name) throw new CliError("invalid_command", "Missing required --name.");
  return state;
}

function parseConfigTestProviderArgs(rest: string[]) {
  const state = { name: "" };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    const value = rest[i + 1];
    switch (arg) {
      case "--name":
        state.name = value;
        i += 1;
        break;
      default:
        throw new CliError("invalid_command", `Unknown argument: ${arg}`);
    }
  }
  if (!state.name) throw new CliError("invalid_command", "Missing required --name.");
  return state;
}

function parseConfigSetUserAgentArgs(rest: string[]) {
  const state = { value: "" };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    const value = rest[i + 1];
    switch (arg) {
      case "--value":
        state.value = value;
        i += 1;
        break;
      default:
        throw new CliError("invalid_command", `Unknown argument: ${arg}`);
    }
  }
  if (!state.value) {
    throw new CliError("invalid_command", "Missing required --value.");
  }
  return state;
}

function readBodyJson(filePath: string) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new CliError("invalid_body_json", "request create body file was not valid JSON.", {
      body_file: filePath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function normalizeBackgroundEnvironment(environment: ReturnType<typeof inspectBackgroundRemoveEnvironment>) {
  return {
    ready: environment.ready,
    script: {
      path: environment.scriptPath,
      exists: environment.scriptExists,
    },
    python: environment.python,
    dependencies: environment.dependencies,
    methods: environment.methods,
    install_hints: environment.installHints,
  };
}

function normalizeBackgroundInstall(install: ReturnType<typeof installBackgroundRemoveDependencies>) {
  return {
    attempted: install.attempted,
    ok: install.ok,
    python: {
      resolved: install.python,
      version: install.pythonVersion,
    },
    used_user_site: install.usedUserSite,
    requested_dependencies: install.requestedDependencies,
    requested_packages: install.requestedPackages,
    already_satisfied: install.alreadySatisfied,
    command: install.command,
    exit_code: install.exitCode,
    stdout: install.stdout,
    stderr: install.stderr,
    error: install.error,
  };
}

function summarizeLocalOutput(filePath: string) {
  const stats = fs.statSync(filePath);
  return {
    path: filePath,
    bytes: stats.size,
    files: [{ index: 0, path: filePath, bytes: stats.size }],
  };
}
