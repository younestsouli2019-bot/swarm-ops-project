/**
 * Free model registry — populated from awesome-free-models catalog.
 *
 * Each entry is a free-tier endpoint the swarm can use for inference instead
 * of paid APIs. Users must set the corresponding API key in .env to activate.
 *
 * USAGE POLICY (enforced by every agent's system prompt):
 *   These models power legitimate swarm work: HIT marketplace tasks, content
 *   creation, data analysis, document processing, accessibility audits.
 *   They MUST NOT be used for: coordinated inauthentic behavior, account
 *   creation on third-party platforms, behavioral scraping, influence
 *   operations, or any activity prohibited by the platform's ToS.
 */

export type ModelProvider =
  | "deepseek"
  | "openrouter"
  | "mistral"
  | "qwen"
  | "ollama"
  | "zai";

export interface FreeModelConfig {
  id: string;
  display_name: string;
  provider: ModelProvider;
  endpoint: string;
  model_id: string;
  context_window: number;
  capabilities: string[];
  api_key_env: string; // env var name; if unset, model is unavailable
  free_tier_limit: string; // human-readable limit description
  docs_url: string;
}

export const FREE_MODELS: FreeModelConfig[] = [
  {
    id: "deepseek-chat",
    display_name: "DeepSeek V3 (Chat)",
    provider: "deepseek",
    endpoint: "https://api.deepseek.com/v1/chat/completions",
    model_id: "deepseek-chat",
    context_window: 64000,
    capabilities: ["chat", "code", "reasoning", "json_mode"],
    api_key_env: "DEEPSEEK_API_KEY",
    free_tier_limit: "Free tier during off-peak; paid tier at other times",
    docs_url: "https://api-docs.deepseek.com/",
  },
  {
    id: "deepseek-reasoner",
    display_name: "DeepSeek R1 (Reasoner)",
    provider: "deepseek",
    endpoint: "https://api.deepseek.com/v1/chat/completions",
    model_id: "deepseek-reasoner",
    context_window: 64000,
    capabilities: ["chat", "reasoning", "chain_of_thought"],
    api_key_env: "DEEPSEEK_API_KEY",
    free_tier_limit: "Free tier during off-peak; paid tier at other times",
    docs_url: "https://api-docs.deepseek.com/",
  },
  {
    id: "llama-3.3-70b",
    display_name: "Llama 3.3 70B Instruct (OpenRouter free)",
    provider: "openrouter",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    model_id: "meta-llama/llama-3.3-70b-instruct:free",
    context_window: 131072,
    capabilities: ["chat", "code", "reasoning"],
    api_key_env: "OPENROUTER_API_KEY",
    free_tier_limit: "Free tier: 20 req/min, 50 req/day on :free models",
    docs_url: "https://openrouter.ai/docs",
  },
  {
    id: "mistral-small",
    display_name: "Mistral Small (La Plateforme free tier)",
    provider: "mistral",
    endpoint: "https://api.mistral.ai/v1/chat/completions",
    model_id: "mistral-small-latest",
    context_window: 32000,
    capabilities: ["chat", "code", "json_mode"],
    api_key_env: "MISTRAL_API_KEY",
    free_tier_limit: "Free tier: 1 req/sec, 500k req/month",
    docs_url: "https://docs.mistral.ai/",
  },
  {
    id: "qwen-plus",
    display_name: "Qwen Plus (DashScope free tier)",
    provider: "qwen",
    endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    model_id: "qwen-plus",
    context_window: 131072,
    capabilities: ["chat", "code", "reasoning", "multilingual"],
    api_key_env: "DASHSCOPE_API_KEY",
    free_tier_limit: "Free tier: 100k tokens/min for qualified users",
    docs_url: "https://help.aliyun.com/zh/dashscope/",
  },
  {
    id: "gemma-2-9b",
    display_name: "Gemma 2 9B (OpenRouter free)",
    provider: "openrouter",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    model_id: "google/gemma-2-9b-it:free",
    context_window: 8192,
    capabilities: ["chat", "code"],
    api_key_env: "OPENROUTER_API_KEY",
    free_tier_limit: "Free tier: 20 req/min, 50 req/day on :free models",
    docs_url: "https://openrouter.ai/docs",
  },
  {
    id: "ollama-local",
    display_name: "Ollama (local runtime, any model)",
    provider: "ollama",
    endpoint: "http://localhost:11434/api/chat",
    model_id: "llama3.2", // user can override
    context_window: 8192,
    capabilities: ["chat", "code"],
    api_key_env: "OLLAMA_HOST", // not really a key — just a host config
    free_tier_limit: "Unlimited (runs locally)",
    docs_url: "https://ollama.com/",
  },
  {
    id: "zai-glm-4.6",
    display_name: "GLM-4.6 (Z.ai)",
    provider: "zai",
    endpoint: "https://api.z.ai/api/paas/v4/chat/completions",
    model_id: "glm-4.6",
    context_window: 131072,
    capabilities: ["chat", "code", "reasoning", "json_mode", "tools"],
    api_key_env: "ZAI_API_KEY",
    free_tier_limit: "Per Z.ai plan",
    docs_url: "https://docs.z.ai/",
  },
];

/**
 * Returns the list of models that are actually available given the current
 * environment (i.e., the required API key env var is set).
 */
export function getAvailableModels(): FreeModelConfig[] {
  return FREE_MODELS.filter((m) => {
    if (m.provider === "ollama") {
      // Ollama is "available" if the host is reachable OR OLLAMA_HOST is set
      return !!process.env.OLLAMA_HOST || process.env.NODE_ENV !== "production";
    }
    return !!process.env[m.api_key_env];
  });
}

/**
 * Returns the default model — the first available free model, falling back to
 * ZAI (which is always available in this sandbox).
 */
export function getDefaultModel(): FreeModelConfig {
  const available = getAvailableModels();
  // Prefer Z.ai first (always available in sandbox), then free tiers.
  const zai = available.find((m) => m.provider === "zai");
  return zai ?? available[0] ?? FREE_MODELS[0];
}
