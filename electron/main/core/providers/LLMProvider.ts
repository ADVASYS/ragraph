import type { LanguageModel } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ModelInfo, ProviderConfig } from "../../../../shared/types";

export interface LLMProviderHandle {
  chatModel: LanguageModel;
  visionModel: LanguageModel;
  config: ProviderConfig;
}

/**
 * Builds a language model instance from a user-provided OpenAI-compatible provider
 * using the Vercel AI SDK.
 */
export function buildLLM(config: ProviderConfig): LLMProviderHandle {
  const provider = createOpenAICompatible({
    name: "user-provider",
    apiKey: config.apiKey,
    baseURL: config.baseUrl.replace(/\/$/, ""),
  });
  const chatModel = provider.chatModel(config.chatModel);
  const visionModel = provider.chatModel(config.visionModel || config.chatModel);
  return { chatModel, visionModel, config };
}

/**
 * Test credentials against the provider and return basic info.
 */
export async function testProvider(config: Pick<ProviderConfig, "baseUrl" | "apiKey">): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch(config.baseUrl.replace(/\/$/, "") + "/models", {
      headers: { authorization: `Bearer ${config.apiKey}` },
    });
    if (!res.ok) return { ok: false, message: `HTTP ${res.status}: ${await res.text()}` };
    const json = (await res.json()) as { data?: unknown[] };
    const count = Array.isArray(json.data) ? json.data.length : 0;
    return { ok: true, message: `Connected. ${count} models available.` };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

export async function fetchModels(config: Pick<ProviderConfig, "baseUrl" | "apiKey">): Promise<ModelInfo[]> {
  const res = await fetch(config.baseUrl.replace(/\/$/, "") + "/models", {
    headers: { authorization: `Bearer ${config.apiKey}` },
  });
  if (!res.ok) throw new Error(`Failed to fetch models: ${res.status}`);
  const json = (await res.json()) as { data: { id: string; created?: number; owned_by?: string }[] };
  return (json.data ?? []).map((m) => ({ id: m.id, created: m.created, ownedBy: m.owned_by }));
}
