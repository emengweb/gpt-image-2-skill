import type { ProviderKind } from "./types.ts";
import {
  DEFAULT_CODEX_MODEL,
  DEFAULT_OPENAI_EDIT_MODEL,
  DEFAULT_OPENAI_MODEL,
} from "./constants.ts";

export type ModelTier = "speed" | "precision";

export type ModelRoutingOperation = "generate" | "edit";

export type ModelResolutionSource =
  | "explicit_model"
  | "explicit_tier"
  | "provider_pin"
  | "operation_default"
  | "codex_default";

export type ModelTierSource = "explicit" | "model_name" | "operation_default";

export type ModelResolution = {
  operation: ModelRoutingOperation;
  tier: ModelTier;
  tier_source: ModelTierSource;
  requested_model: string | null;
  provider_model: string | null;
  resolved_model: string;
  source: ModelResolutionSource;
  delegated_to_server: boolean;
  reason: string;
};

export type ModelRoutingInput = {
  providerType: ProviderKind;
  operation: ModelRoutingOperation;
  requestedModel?: string;
  requestedTier?: string;
  providerModel?: string;
};

const OPERATION_TIER: Record<ModelRoutingOperation, ModelTier> = {
  generate: "speed",
  edit: "precision",
};

const TIER_MODEL: Record<ModelTier, string> = {
  speed: DEFAULT_OPENAI_MODEL,
  precision: DEFAULT_OPENAI_EDIT_MODEL,
};

// 用 Map 而非对象字面量做查表，避免自定义模型名命中 Object 原型链上的键。
const MODEL_TIER = new Map<string, ModelTier>([
  [DEFAULT_OPENAI_MODEL, "speed"],
  [DEFAULT_OPENAI_EDIT_MODEL, "precision"],
]);

// 允许用档位短名代替完整模型名，未命中的名称按自定义模型原样透传。
const MODEL_ALIAS = new Map<string, string>([
  ["flare", DEFAULT_OPENAI_MODEL],
  ["sunburst", DEFAULT_OPENAI_EDIT_MODEL],
]);

const TIER_REASON: Record<ModelTier, string> = {
  speed: "speed-first model for high-frequency and low-cost generation",
  precision: "precision-first model for complex edits and final delivery",
};

export const MODEL_TIER_ORDER: ModelTier[] = ["speed", "precision"];

export function normalizeTier(value?: string): ModelTier | null {
  if (value === "speed" || value === "precision") return value;
  return null;
}

export function normalizeModelName(name: string) {
  return MODEL_ALIAS.get(name) ?? name;
}

export function resolveRequestModel(input: ModelRoutingInput): ModelResolution {
  const requestedModel = input.requestedModel?.trim() || null;
  const normalizedModel = requestedModel ? normalizeModelName(requestedModel) : null;
  const providerModel = input.providerModel?.trim() || null;
  const explicitTier = normalizeTier(input.requestedTier);
  const { tier, tier_source } = resolveTier(input.operation, explicitTier, normalizedModel);

  if (input.providerType === "codex") {
    return {
      operation: input.operation,
      tier,
      tier_source,
      requested_model: requestedModel,
      provider_model: providerModel,
      resolved_model: normalizedModel ?? providerModel ?? DEFAULT_CODEX_MODEL,
      source: normalizedModel ? "explicit_model" : providerModel ? "provider_pin" : "codex_default",
      delegated_to_server: true,
      reason:
        "Codex image_generation selects the image model server-side; the request model is the Codex orchestrator.",
    };
  }

  if (normalizedModel) {
    return {
      operation: input.operation,
      tier,
      tier_source,
      requested_model: requestedModel,
      provider_model: providerModel,
      resolved_model: normalizedModel,
      source: "explicit_model",
      delegated_to_server: false,
      reason: `Explicit --model override (${requestedModel}).`,
    };
  }

  if (explicitTier) {
    return {
      operation: input.operation,
      tier,
      tier_source,
      requested_model: null,
      provider_model: providerModel,
      resolved_model: TIER_MODEL[explicitTier],
      source: "explicit_tier",
      delegated_to_server: false,
      reason: `Explicit --tier ${explicitTier} selects the ${TIER_REASON[explicitTier]}.`,
    };
  }

  // provider 固定值由配置层决定是否保留（见 config-store 的版本化迁移），路由层原样尊重。
  if (providerModel) {
    const resolvedModel = normalizeModelName(providerModel);
    return {
      operation: input.operation,
      tier,
      tier_source,
      requested_model: null,
      provider_model: providerModel,
      resolved_model: resolvedModel,
      source: "provider_pin",
      delegated_to_server: false,
      reason: `Provider config pins model ${resolvedModel}.`,
    };
  }

  return {
    operation: input.operation,
    tier,
    tier_source,
    requested_model: null,
    provider_model: providerModel,
    resolved_model: TIER_MODEL[OPERATION_TIER[input.operation]],
    source: "operation_default",
    delegated_to_server: false,
    reason: `Default ${input.operation} model: ${TIER_REASON[OPERATION_TIER[input.operation]]}.`,
  };
}

function resolveTier(
  operation: ModelRoutingOperation,
  explicitTier: ModelTier | null,
  normalizedModel: string | null,
): { tier: ModelTier; tier_source: ModelTierSource } {
  const modelTier = normalizedModel ? MODEL_TIER.get(normalizedModel) : undefined;
  if (modelTier) return { tier: modelTier, tier_source: "model_name" };
  if (explicitTier) return { tier: explicitTier, tier_source: "explicit" };
  return { tier: OPERATION_TIER[operation], tier_source: "operation_default" };
}
