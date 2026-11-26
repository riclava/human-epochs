import type { Pool } from "pg";
import { z } from "zod";
import {
  agentSettingLimits, agentSettingsSchema, deepSeekBaseUrl, defaultAgentSettings, modelEndpointSchema, settingsAdviceSchema,
  type AgentSettingsView, type ModelEndpoint, type SaveAgentSettingsRequest, type SettingsAdviceRequest,
} from "../contracts/agent-settings.js";
import type { createModelProvider } from "../models/connections.js";
import type { StudyModel } from "../runtime/model.js";
import type { createModelCredentialCipher } from "../storage/model-credential.js";

const storedSchema = z.object({ ...agentSettingsSchema.shape, endpoint: modelEndpointSchema.optional(), sealedApiKey: z.string().optional() });
const defaultEndpoint = { baseUrl: deepSeekBaseUrl, modelId: "deepseek-flash" };
type Stored = z.infer<typeof storedSchema>;

export interface ModelOptions {
  provider: ReturnType<typeof createModelProvider>;
  cipher: ReturnType<typeof createModelCredentialCipher>;
}

export function createAgentSettingsService(pool: Pool, injectedModel: StudyModel | null, options?: ModelOptions) {
  const provider = options?.provider;
  const fallback = provider?.defaults ?? defaultEndpoint;
  const defaultOutputTokens = (baseUrl: string) => provider?.defaultOutputTokens(baseUrl) ?? defaultAgentSettings.maxOutputTokens;
  const defaults = { ...defaultAgentSettings, maxOutputTokens: defaultOutputTokens(fallback.baseUrl) };

  async function read(): Promise<{ revision: number; stored: Stored }> {
    const { rows: [row] } = await pool.query<{ revision: number; settings: unknown }>("SELECT revision, settings FROM agent_settings WHERE singleton");
    return row ? { revision: row.revision, stored: storedSchema.parse(row.settings) } : { revision: 0, stored: defaults };
  }

  function deploymentKey(endpoint: ModelEndpoint) {
    return endpoint.baseUrl === fallback.baseUrl ? provider?.defaultKey : undefined;
  }

  function viewOf(revision: number, { endpoint = fallback, sealedApiKey, ...settings }: Stored): AgentSettingsView {
    const hasApiKey = Boolean(sealedApiKey || deploymentKey(endpoint));
    return { revision, settings, connection: { ...endpoint, hasApiKey }, defaultOutputTokens: defaultOutputTokens(endpoint.baseUrl),
      assistantAvailable: Boolean(injectedModel || hasApiKey) };
  }

  async function view() {
    const { revision, stored } = await read();
    return viewOf(revision, stored);
  }

  function resolveModel({ endpoint = fallback, sealedApiKey }: Stored) {
    if (injectedModel || !provider) return injectedModel;
    if (sealedApiKey) {
      const cipher = options?.cipher;
      if (!cipher) throw new Error("The model credential encryption key is unavailable");
      return provider.connect(endpoint, cipher.open(sealedApiKey, endpoint.baseUrl));
    }
    const key = deploymentKey(endpoint);
    return key ? provider.connect(endpoint, key) : null;
  }

  async function execution() {
    const { revision, stored } = await read();
    return { model: resolveModel(stored), settings: viewOf(revision, stored).settings };
  }

  async function save({ revision, settings, connection }: SaveAgentSettingsRequest) {
    const current = await read();
    if (current.revision !== revision) return { kind: "conflict" } as const;

    let { endpoint, sealedApiKey } = current.stored;
    if (connection) {
      const { apiKey, ...next } = connection;
      const changedAddress = next.baseUrl !== (endpoint ?? fallback).baseUrl;
      if (!provider?.allows(next.baseUrl)) return { kind: "invalid_endpoint" } as const;
      if (!apiKey && (changedAddress || !sealedApiKey && !deploymentKey(next))) return { kind: "key_required" } as const;
      endpoint = next;
      if (apiKey) {
        const cipher = options?.cipher;
        if (!cipher) return { kind: "storage_unavailable" } as const;
        sealedApiKey = cipher.seal(apiKey, next.baseUrl);
      }
    }

    const stored = { ...settings, endpoint, sealedApiKey };
    const result = revision === 0
      ? await pool.query(`INSERT INTO agent_settings (revision, settings) VALUES (1, $1)
          ON CONFLICT DO NOTHING RETURNING revision`, [stored])
      : await pool.query(`UPDATE agent_settings SET revision = revision + 1, settings = $1
          WHERE singleton AND revision = $2 RETURNING revision`, [stored, revision]);
    if (!result.rowCount) return { kind: "conflict" } as const;
    return { kind: "saved", view: viewOf(result.rows[0].revision, stored) } as const;
  }

  async function advise({ history, draft }: SettingsAdviceRequest) {
    const { revision, stored } = await read();
    const model = resolveModel(stored);
    if (!model) return null;
    const { settings, connection, defaultOutputTokens } = viewOf(revision, stored);
    const system = [
      "你是 Human Epochs 的运行设置助手，请用管理员使用的语言解释参数并提出可审查的草案。",
      '只返回 JSON 对象 {"reply":"解释或澄清问题","changes":{}}。未要求改动时 changes 保持为空对象。',
      "changes 只写要替换的数值参数或 modelId。Base URL 和 API Key 由管理员在表单内填写；不要请对方把密钥发到对话。",
      "历史预算以 UTF-8 字节计量。你只能提出草案，管理员填入表单并保存后才生效。",
      JSON.stringify({ current: draft ?? settings, modelId: connection.modelId,
        defaults: { ...defaultAgentSettings, maxOutputTokens: defaultOutputTokens }, limits: agentSettingLimits }),
    ].join("\n");
    const result = await model({ system, messages: history, format: "json", signal: AbortSignal.timeout(25_000), maxOutputTokens: 2_048 });
    if (result.kind !== "text") throw new Error("Expected a settings proposal");
    return settingsAdviceSchema.parse(JSON.parse(result.text));
  }

  return { view, execution, save, advise };
}
