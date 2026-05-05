import type { ProviderConfig, ServerConfig } from "./types";

export function providerSupportsMultipleOutputs(_config: ServerConfig | undefined, _provider: string) {
  return true;
}

export function effectiveOutputCount(_config: ServerConfig | undefined, _provider: string, requested: number) {
  return requested;
}

export function requestOutputCount(_config: ServerConfig | undefined, _provider: string, requested: number) {
  return requested;
}

export function providerEditRegionMode(config: ServerConfig | undefined, provider: string): NonNullable<ProviderConfig["edit_region_mode"]> {
  if (provider === "openai") return "native-mask";
  if (provider === "codex") return "reference-hint";
  const cfg = provider ? config?.providers[provider] : undefined;
  if (cfg?.edit_region_mode) return cfg.edit_region_mode;
  if (cfg?.type === "openai") return "native-mask";
  if (cfg?.type === "codex") return "reference-hint";
  return "reference-hint";
}
