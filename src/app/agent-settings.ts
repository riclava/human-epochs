import type { Pool } from "pg";
import { z } from "zod";
import {
  agentSettingLimits, agentSettingsSchema, deepSeekBaseUrl, defaultAgentSettings, modelConnectionTargetSchema, settingsAdviceSchema,
  type AgentSettingsView, type ModelConnectionTarget, type SaveAgentSettingsRequest, type SettingsAdviceRequest,
} from "../contracts/agent-settings.js";
import type { createModelProvider } from "../models/connections.js";
import type { ModelClient } from "../runtime/model.js";
import type { createModelCredentialCipher } from "../storage/model-credential.js";

const storedConnectionSchema = modelConnectionTargetSchema.extend({ sealedApiKey: z.string().optional() });
const storedSchema = z.strictObject({ settings: agentSettingsSchema, connection: storedConnectionSchema.optional() });
const defaultConnection = { baseUrl: deepSeekBaseUrl, modelId: "deepseek-flash" };
type Stored = z.infer<typeof storedSchema>;

export interface ModelOptions {
  provider: ReturnType<typeof createModelProvider>;
  cipher: ReturnType<typeof createModelCredentialCipher>;
}

export function createAgentSettingsService(pool: Pool, injectedModel: ModelClient | null, options?: ModelOptions) {
  const provider = options?.provider;
  const fallback: z.infer<typeof storedConnectionSchema> = provider?.defaults ?? defaultConnection;
  const defaultOutputTokens = (baseUrl: string) => provider?.defaultOutputTokens(baseUrl) ?? defaultAgentSettings.maxOutputTokens;
  const defaults = { ...defaultAgentSettings, maxOutputTokens: defaultOutputTokens(fallback.baseUrl) };

  async function read(): Promise<{ revision: number; stored: Stored }> {
    const { rows: [row] } = await pool.query<{ revision: number; settings: unknown; connection: unknown }>(
      "SELECT revision, settings, connection FROM agent_settings WHERE singleton",
    );
    return row ? { revision: row.revision, stored: storedSchema.parse({ settings: row.settings, connection: row.connection ?? undefined }) }
      : { revision: 0, stored: { settings: defaults } };
  }

  function deploymentKey(target: ModelConnectionTarget) {
    return target.baseUrl === fallback.baseUrl ? provider?.defaultKey : undefined;
  }

  function viewOf(revision: number, { connection = fallback, settings }: Stored): AgentSettingsView {
    const { baseUrl, modelId, sealedApiKey } = connection;
    const hasApiKey = Boolean(sealedApiKey || deploymentKey(connection));
    return { revision, settings, connection: { baseUrl, modelId, hasApiKey }, defaultOutputTokens: defaultOutputTokens(baseUrl),
      onlineModelAvailable: Boolean(injectedModel || hasApiKey) };
  }

  async function view() {
    const { revision, stored } = await read();
    return viewOf(revision, stored);
  }

  function resolveModel({ connection = fallback }: Stored) {
    if (injectedModel || !provider) return injectedModel;
    const { sealedApiKey, ...target } = connection;
    if (sealedApiKey) {
      const cipher = options?.cipher;
      if (!cipher) throw new Error("The model credential encryption key is unavailable");
      return provider.connect(target, cipher.open(sealedApiKey, target.baseUrl));
    }
    const key = deploymentKey(target);
    return key ? provider.connect(target, key) : null;
  }

  async function execution() {
    const { stored } = await read();
    return { model: resolveModel(stored), settings: stored.settings };
  }

  async function save({ expectedRevision, settings, connection }: SaveAgentSettingsRequest) {
    const current = await read();
    if (current.revision !== expectedRevision) return { kind: "conflict" } as const;

    let storedConnection = current.stored.connection;
    if (connection) {
      const { apiKey, ...next } = connection;
      const changedAddress = next.baseUrl !== (storedConnection ?? fallback).baseUrl;
      let sealedApiKey = storedConnection?.sealedApiKey;
      if (!provider?.allows(next.baseUrl)) return { kind: "invalid_endpoint" } as const;
      if (!apiKey && (changedAddress || !sealedApiKey && !deploymentKey(next))) return { kind: "key_required" } as const;
      if (apiKey) {
        const cipher = options?.cipher;
        if (!cipher) return { kind: "storage_unavailable" } as const;
        sealedApiKey = cipher.seal(apiKey, next.baseUrl);
      }
      storedConnection = { ...next, sealedApiKey };
    }

    const stored = { settings, connection: storedConnection };
    const values = [settings, storedConnection ?? null];
    const result = expectedRevision === 0
      ? await pool.query(`INSERT INTO agent_settings (revision, settings, connection) VALUES (1, $1, $2)
          ON CONFLICT DO NOTHING RETURNING revision`, values)
      : await pool.query(`UPDATE agent_settings SET revision = revision + 1, settings = $1, connection = $2
          WHERE singleton AND revision = $3 RETURNING revision`, [...values, expectedRevision]);
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
