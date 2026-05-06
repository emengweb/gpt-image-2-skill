export type ProviderKind = "openai" | "openai-compatible" | "codex";

export type CredentialSource = "file" | "env" | "keychain";

export interface CredentialRef {
  source: CredentialSource;
  value?: string;
  present?: boolean;
  env?: string;
  service?: string;
  account?: string;
}

export interface ProviderConfig {
  type: ProviderKind;
  api_base?: string;
  endpoint?: string;
  model?: string;
  supports_n?: boolean;
  edit_region_mode?: "native-mask" | "reference-hint" | "none";
  credentials: Record<string, CredentialRef>;
  builtin?: boolean;
  disabled?: boolean;
  disabled_reason?: string;
  allow_overwrite?: boolean;
}

export interface AppConfig {
  version: 1;
  default_provider?: string;
  user_agent?: string;
  providers: Record<string, ProviderConfig>;
}

export interface ProviderSelection {
  requested: string;
  resolved: string;
  reason:
    | "requested"
    | "requested_provider_missing_fallback_default"
    | "config_default_provider"
    | "openai_env_ready"
    | "codex_builtin";
}

export interface JsonError {
  code: string;
  message: string;
  detail?: unknown;
}

export interface OutputFile {
  index: number;
  path: string;
  bytes: number;
}

export interface JsonEvent {
  seq: number;
  kind: "local" | "progress" | "sse";
  type: string;
  data: Record<string, unknown>;
}
