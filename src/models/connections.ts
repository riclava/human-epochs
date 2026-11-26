import { deepSeekBaseUrl, deepSeekOutputLimit, isDeepSeekEndpoint, modelBaseUrlSchema, modelEndpointSchema, type ModelEndpoint } from "../contracts/agent-settings.js";
import { createChatCompletionsModel } from "./chat-completions.js";
import { isPublicModelHost, requestPublicModel } from "./public-model-request.js";

export function createModelProvider(env: NodeJS.ProcessEnv, publicRequest: typeof fetch = requestPublicModel, trustedRequest: typeof fetch = fetch) {
  const defaults = modelEndpointSchema.parse({
    baseUrl: env.STUDY_AGENT_BASE_URL?.trim() || deepSeekBaseUrl,
    modelId: env.STUDY_AGENT_MODEL?.trim() || "deepseek-flash",
  });
  const defaultKey = env.STUDY_AGENT_API_KEY?.trim();
  const privateEndpoints = new Set((env.STUDY_AGENT_ALLOWED_PRIVATE_BASE_URLS ?? "").split(",").filter(value => value.trim()).map(value => modelBaseUrlSchema.parse(value)));
  const isTrusted = (baseUrl: string) => baseUrl === defaults.baseUrl && Boolean(defaultKey) || privateEndpoints.has(baseUrl);

  function allows(baseUrl: string) {
    const url = new URL(baseUrl);
    return isTrusted(baseUrl) || url.protocol === "https:" && isPublicModelHost(url.hostname);
  }

  function defaultOutputTokens(baseUrl: string) {
    if (isDeepSeekEndpoint(baseUrl)) return deepSeekOutputLimit;
    const declared = Number(env.STUDY_AGENT_MAX_OUTPUT_TOKENS);
    return baseUrl === defaults.baseUrl && Number.isSafeInteger(declared) && declared >= 1 && declared <= deepSeekOutputLimit ? declared : 2_048;
  }

  function connect(endpoint: ModelEndpoint, key: string | undefined) {
    if (!allows(endpoint.baseUrl)) throw new Error("Model endpoint is not permitted");
    return createChatCompletionsModel({
      env: { STUDY_AGENT_BASE_URL: endpoint.baseUrl, STUDY_AGENT_MODEL: endpoint.modelId, STUDY_AGENT_API_KEY: key },
      fetchImpl: isTrusted(endpoint.baseUrl) ? trustedRequest : publicRequest,
      tokenParameter: new URL(endpoint.baseUrl).hostname === "api.openai.com" ? "max_completion_tokens" : "max_tokens",
    });
  }

  return { defaults, defaultKey, allows, connect, defaultOutputTokens };
}
