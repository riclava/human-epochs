import { deepSeekBaseUrl, deepSeekOutputLimit, isDeepSeekEndpoint, modelBaseUrlSchema, modelConnectionTargetSchema, type ModelConnectionTarget } from "../contracts/agent-settings.js";
import { createChatCompletionsModel } from "./chat-completions.js";
import { isPublicModelHost, requestPublicModel } from "./public-model-request.js";

export function createModelProvider(env: NodeJS.ProcessEnv, publicRequest: typeof fetch = requestPublicModel, trustedRequest: typeof fetch = fetch) {
  const defaults = modelConnectionTargetSchema.parse({
    baseUrl: env.MODEL_BASE_URL?.trim() || deepSeekBaseUrl,
    modelId: env.MODEL_ID?.trim() || "deepseek-flash",
  });
  const defaultKey = env.MODEL_API_KEY?.trim();
  const privateEndpoints = new Set((env.MODEL_ALLOWED_PRIVATE_BASE_URLS ?? "").split(",").filter(value => value.trim()).map(value => modelBaseUrlSchema.parse(value)));
  const isTrusted = (baseUrl: string) => baseUrl === defaults.baseUrl && Boolean(defaultKey) || privateEndpoints.has(baseUrl);

  function allows(baseUrl: string) {
    const url = new URL(baseUrl);
    return isTrusted(baseUrl) || url.protocol === "https:" && isPublicModelHost(url.hostname);
  }

  function defaultOutputTokens(baseUrl: string) {
    if (isDeepSeekEndpoint(baseUrl)) return deepSeekOutputLimit;
    const declared = Number(env.MODEL_MAX_OUTPUT_TOKENS);
    return baseUrl === defaults.baseUrl && Number.isSafeInteger(declared) && declared >= 1 && declared <= deepSeekOutputLimit ? declared : 2_048;
  }

  function connect(target: ModelConnectionTarget, key: string | undefined) {
    if (!allows(target.baseUrl)) throw new Error("Model endpoint is not permitted");
    return createChatCompletionsModel({
      env: { MODEL_BASE_URL: target.baseUrl, MODEL_ID: target.modelId, MODEL_API_KEY: key },
      fetchImpl: isTrusted(target.baseUrl) ? trustedRequest : publicRequest,
      tokenParameter: new URL(target.baseUrl).hostname === "api.openai.com" ? "max_completion_tokens" : "max_tokens",
    });
  }

  return { defaults, defaultKey, allows, connect, defaultOutputTokens };
}
