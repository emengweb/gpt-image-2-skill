export type CredentialSource = "file" | "env" | "keychain";

export type ProviderKind = "openai-compatible" | "openai" | "codex";

export interface AppScreen {
  id: "providers" | "generate" | "edit" | "history";
  title: string;
}

export interface CredentialRef {
  source: CredentialSource;
  value?: string;
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
}

export interface AppConfig {
  version: 1;
  default_provider?: string;
  providers: Record<string, ProviderConfig>;
}

export interface RuntimeEvent {
  seq: number;
  kind: "local" | "progress" | "sse";
  type: string;
  data: Record<string, unknown>;
}

export interface ImageJob {
  id: string;
  command: "images generate" | "images edit" | "request create";
  provider: string;
  status: "queued" | "running" | "completed" | "failed";
  output_path?: string;
  created_at: string;
  metadata: Record<string, unknown>;
}
