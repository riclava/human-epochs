import { z } from "zod";

export const deepSeekOutputLimit = 393_216;
export const deepSeekContextTokens = 1_000_000;

export const agentSettingLimits = {
  maxOutputTokens: { min: 1, max: deepSeekOutputLimit },
  historyBytes: { min: 25_000, max: 64_000 },
  inlineSourceChars: { min: 500, max: 8_000 },
  modelTimeoutSeconds: { min: 5, max: 60 },
  maxModelCalls: { min: 2, max: 5 },
  maxToolCalls: { min: 1, max: 8 },
};

const bounded = ({ min, max }: { min: number; max: number }) => z.int().min(min).max(max);

export const modelIdSchema = z.string().trim().min(1).max(160).regex(/^[\w.\-:/]+$/);
export const modelBaseUrlSchema = z.string().trim().min(1).max(512).pipe(z.url({ protocol: /^https?$/ })).refine(value => {
  const url = new URL(value);
  return !url.username && !url.password && !url.search && !url.hash;
}).transform(value => new URL(value).toString().replace(/\/+$/, ""));
export const modelEndpointSchema = z.strictObject({ baseUrl: modelBaseUrlSchema, modelId: modelIdSchema });
export type ModelEndpoint = z.infer<typeof modelEndpointSchema>;
const modelConnectionInputSchema = modelEndpointSchema.extend({
  apiKey: z.string().trim().min(1).max(4_096).regex(/^[\x21-\x7e]+$/).optional(),
});

export const agentSettingsSchema = z.strictObject({
  maxOutputTokens: bounded(agentSettingLimits.maxOutputTokens),
  historyBytes: bounded(agentSettingLimits.historyBytes),
  inlineSourceChars: bounded(agentSettingLimits.inlineSourceChars),
  modelTimeoutSeconds: bounded(agentSettingLimits.modelTimeoutSeconds),
  maxModelCalls: bounded(agentSettingLimits.maxModelCalls),
  maxToolCalls: bounded(agentSettingLimits.maxToolCalls),
});

export type AgentSettings = z.infer<typeof agentSettingsSchema>;

export const defaultAgentSettings: Readonly<AgentSettings> = {
  maxOutputTokens: deepSeekOutputLimit,
  historyBytes: 32_000,
  inlineSourceChars: 4_000,
  modelTimeoutSeconds: 45,
  maxModelCalls: 3,
  maxToolCalls: 4,
};

export const saveAgentSettingsSchema = z.strictObject({ revision: z.int().min(0), settings: agentSettingsSchema });
export type AgentSettingsSnapshot = z.infer<typeof saveAgentSettingsSchema>;
export const saveAgentSettingsRequestSchema = saveAgentSettingsSchema.extend({ connection: modelConnectionInputSchema.optional() });
export type SaveAgentSettingsRequest = z.infer<typeof saveAgentSettingsRequestSchema>;
export const deepSeekBaseUrl = "https://api.deepseek.com";
export function isDeepSeekEndpoint(baseUrl: string) {
  const parsed = URL.parse(baseUrl);
  return parsed?.origin === deepSeekBaseUrl;
}

export const agentSettingsViewSchema = saveAgentSettingsSchema.extend({
  connection: modelEndpointSchema.extend({ hasApiKey: z.boolean() }),
  defaultOutputTokens: bounded(agentSettingLimits.maxOutputTokens),
  assistantAvailable: z.boolean(),
});
export type AgentSettingsView = z.infer<typeof agentSettingsViewSchema>;

export const settingsAssistantHistoryLimit = 11;
const assistantMessage = z.discriminatedUnion("role", [
  z.strictObject({ role: z.literal("user"), content: z.string().trim().min(1).max(2_000) }),
  z.strictObject({ role: z.literal("assistant"), content: z.string().trim().min(1).max(4_000) }),
]);
export const settingsAdviceRequestSchema = z.strictObject({
  history: z.array(assistantMessage).min(1).max(settingsAssistantHistoryLimit).refine(history => history.at(-1)?.role === "user"),
  draft: agentSettingsSchema.optional(),
});
export type SettingsAdviceRequest = z.infer<typeof settingsAdviceRequestSchema>;
export const settingsAdviceSchema = z.strictObject({
  reply: z.string().trim().min(1).max(2_000), changes: agentSettingsSchema.partial().extend({ modelId: modelIdSchema.optional() }),
});
export type SettingsAdvice = z.infer<typeof settingsAdviceSchema>;
