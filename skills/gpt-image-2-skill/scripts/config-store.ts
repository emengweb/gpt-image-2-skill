import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { CliError } from "./errors.ts";
import {
  DEFAULT_CODEX_ENDPOINT,
  DEFAULT_CODEX_MODEL,
  DEFAULT_OPENAI_API_BASE,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_USER_AGENT,
  OPENAI_API_KEY_ENV,
} from "./constants.ts";
import type { AppConfig, ProviderConfig, ProviderSelection } from "./types.ts";

const DEFAULT_CONFIG_VERSION = 1;

export function codexHome() {
  return process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(os.homedir(), ".codex");
}

export function configPath() {
  return path.join(codexHome(), "gpt-image-2-skill", "config.json");
}

export function authPath() {
  return path.join(codexHome(), "auth.json");
}

export function readConfig(): AppConfig {
  const target = configPath();
  if (!fs.existsSync(target)) {
    return defaultConfig();
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(target, "utf8")) as AppConfig;
    return normalizeConfig(parsed);
  } catch (error) {
    throw new CliError("invalid_body_json", "配置文件不是有效 JSON。", {
      path: target,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

export function saveConfig(config: AppConfig) {
  const target = configPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`);
}

export function normalizeConfig(config: Partial<AppConfig> | undefined): AppConfig {
  return {
    version: DEFAULT_CONFIG_VERSION,
    default_provider: config?.default_provider,
    user_agent:
      typeof config?.user_agent === "string" && config.user_agent.trim()
        ? config.user_agent.trim()
        : undefined,
    providers: config?.providers ?? {},
  };
}

export function defaultConfig(): AppConfig {
  const providers: Record<string, ProviderConfig> = {};
  if (process.env[OPENAI_API_KEY_ENV]?.trim()) {
    providers.openai = {
      type: "openai",
      api_base: process.env.OPENAI_API_BASE?.trim() || DEFAULT_OPENAI_API_BASE,
      model: DEFAULT_OPENAI_MODEL,
      stream: false,
      supports_n: true,
      edit_region_mode: "native-mask",
      credentials: {
        api_key: {
          source: "env",
          env: OPENAI_API_KEY_ENV,
          present: true,
        },
      },
      builtin: true,
    };
  }
  providers.codex = {
    type: "codex",
    endpoint: DEFAULT_CODEX_ENDPOINT,
    model: DEFAULT_CODEX_MODEL,
    stream: false,
    edit_region_mode: "reference-hint",
    credentials: {},
    builtin: true,
  };
  return {
    version: DEFAULT_CONFIG_VERSION,
    default_provider: providers.openai ? "openai" : undefined,
    providers,
  };
}

export function sanitizeConfig(config: AppConfig): AppConfig {
  return {
    version: config.version,
    default_provider: config.default_provider,
    user_agent: config.user_agent,
    providers: Object.fromEntries(
      Object.entries(config.providers).map(([name, provider]) => [
        name,
        {
          ...provider,
          stream: provider.stream,
          credentials: Object.fromEntries(
            Object.entries(provider.credentials).map(([key, credential]) => [
              key,
              credential.source === "file"
                ? {
                    ...credential,
                    value: undefined,
                    present: Boolean(credential.value?.trim()),
                  }
                : credential,
            ]),
          ),
        },
      ]),
    ),
  };
}

export function resolveUserAgent(config?: Pick<AppConfig, "user_agent">) {
  const value = config?.user_agent?.trim();
  return value || DEFAULT_USER_AGENT;
}

export function resolveProviderName(
  config: AppConfig,
  openaiReady: boolean,
  requested?: string,
) : ProviderSelection {
  if (requested && requested !== "auto") {
    if (requested === "openai" || requested === "codex" || config.providers[requested]) {
      return {
        requested,
        resolved: requested,
        reason: "requested",
      };
    }
    if (config.default_provider && config.providers[config.default_provider]) {
      return {
        requested,
        resolved: config.default_provider,
        reason: "requested_provider_missing_fallback_default",
      };
    }
  }
  if (config.default_provider && config.providers[config.default_provider]) {
    return {
      requested: requested ?? "auto",
      resolved: config.default_provider,
      reason: "config_default_provider",
    };
  }
  if (openaiReady) {
    return {
      requested: requested ?? "auto",
      resolved: "openai",
      reason: "openai_env_ready",
    };
  }
  return {
    requested: requested ?? "auto",
    resolved: "codex",
    reason: "codex_builtin",
  };
}

export function resolveProvider(config: AppConfig, providerName: string): ProviderConfig {
  if (providerName === "openai") {
    return (
      config.providers.openai ?? {
        type: "openai",
        api_base: process.env.OPENAI_API_BASE?.trim() || DEFAULT_OPENAI_API_BASE,
        model: DEFAULT_OPENAI_MODEL,
        stream: false,
        supports_n: true,
        edit_region_mode: "native-mask",
        credentials: {
          api_key: {
            source: "env",
            env: OPENAI_API_KEY_ENV,
            present: Boolean(process.env[OPENAI_API_KEY_ENV]?.trim()),
          },
        },
        builtin: true,
      }
    );
  }
  if (providerName === "codex") {
    return (
      config.providers.codex ?? {
        type: "codex",
        endpoint: DEFAULT_CODEX_ENDPOINT,
        model: DEFAULT_CODEX_MODEL,
        stream: false,
        edit_region_mode: "reference-hint",
        credentials: {},
        builtin: true,
      }
    );
  }
  const provider = config.providers[providerName];
  if (!provider) {
    throw new CliError("invalid_argument", `Unknown provider: ${providerName}`);
  }
  return provider;
}

export function resolveApiKey(provider: ProviderConfig, explicitApiKey?: string) {
  if (explicitApiKey?.trim()) return explicitApiKey.trim();
  const credential = provider.credentials.api_key;
  if (!credential) {
    throw new CliError("auth_missing", "Provider API key is missing.");
  }
  if (credential.source === "file" && credential.value?.trim()) {
    return credential.value.trim();
  }
  if (credential.source === "env" && credential.env) {
    const value = process.env[credential.env]?.trim();
    if (value) return value;
  }
  if (process.env[OPENAI_API_KEY_ENV]?.trim()) {
    return process.env[OPENAI_API_KEY_ENV]!.trim();
  }
  throw new CliError("auth_missing", "OpenAI API key is missing.");
}

export async function checkEndpointReachability(endpoint: string) {
  let target: URL;
  try {
    target = new URL(endpoint);
  } catch (error) {
    throw new CliError("invalid_argument", `Invalid endpoint: ${endpoint}`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const port = Number(target.port || (target.protocol === "https:" ? 443 : 80));
  const host = target.hostname;
  const started = Date.now();
  const reachable = await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host, port, timeout: 5000 });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => {
      resolve(false);
    });
  });
  return {
    url: endpoint,
    host,
    port,
    reachable,
    latency_ms: Date.now() - started,
  };
}

export function validateProviderName(name: string) {
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    throw new CliError("invalid_provider_config", "Provider name contains invalid characters.");
  }
  if (["auto"].includes(name)) {
    throw new CliError("invalid_provider_config", `Reserved provider name: ${name}`);
  }
}
