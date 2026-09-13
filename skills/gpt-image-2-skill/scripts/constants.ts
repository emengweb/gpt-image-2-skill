export const DEFAULT_CODEX_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
export const DEFAULT_OPENAI_API_BASE = "https://api.openai.com/v1";
export const OPENAI_GENERATIONS_PATH = "/images/generations";
export const OPENAI_EDITS_PATH = "/images/edits";
export const DEFAULT_CODEX_MODEL = "gpt-5.4";
// 速度优先模型：默认生图档位，用于日常出图、SNS、网页素材与批量生成。
export const DEFAULT_OPENAI_MODEL = "gpt-image-2.5-flare";
// 精度优先模型：默认编辑档位，用于基于已有图的调整、多轮精修与最终交付。
export const DEFAULT_OPENAI_EDIT_MODEL = "gpt-image-2.5-sunburst";
// 上一代默认模型，仅用于识别历史配置里的固定值并在读取时迁移到路由默认。
export const LEGACY_OPENAI_MODEL = "gpt-image-2";
export const DEFAULT_INSTRUCTIONS = "You are a concise assistant.";
export const DEFAULT_USER_AGENT = "OpenAI/JS 4.96.0";
export const DEFAULT_RETRY_COUNT = 3;
export const DEFAULT_RETRY_DELAY_SECONDS = 1;
export const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;
export const DEFAULT_REFRESH_TIMEOUT_MS = 60_000;
export const REFRESH_ENDPOINT = "https://auth.openai.com/oauth/token";
export const REFRESH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const OPENAI_API_KEY_ENV = "OPENAI_API_KEY";
export const IMAGE_SIZE_MAX_EDGE = 3840;
export const IMAGE_SIZE_MAX_TOTAL_PIXELS = 8_294_400;
