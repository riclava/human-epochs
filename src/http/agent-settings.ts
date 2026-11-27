import type { FastifyInstance } from "fastify";
import type { createAgentSettingsService } from "../app/agent-settings.js";
import { saveAgentSettingsRequestSchema, settingsAdviceRequestSchema } from "../contracts/agent-settings.js";

export function registerAgentSettings(api: FastifyInstance, settings: ReturnType<typeof createAgentSettingsService>) {
  api.register(async admin => {
    admin.addHook("onRequest", async (request, reply) => {
      if (!request.user?.canManageAgentSettings) {
        return reply.code(403).send({ message: "当前账号没有管理运行设置的权限。" });
      }
    });

    admin.get("/agent-settings", () => settings.view());

    admin.put("/agent-settings", async (request, reply) => {
      const parsed = saveAgentSettingsRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ message: "请检查模型连接和参数范围后重新保存。" });
      }

      const saved = await settings.save(parsed.data);
      switch (saved.kind) {
        case "saved": return saved.view;
        case "conflict": return reply.code(409).send({ message: "另一处已保存运行设置。请读取最新设置后再修改。" });
        case "invalid_endpoint": return reply.code(400).send({ field: "baseUrl", message: "请输入公网 HTTPS 地址，或使用部署允许的内部地址。" });
        case "key_required": return reply.code(400).send({ field: "apiKey", message: "首次配置或更换 Base URL 时需要填写该地址的 API Key。" });
        case "storage_unavailable": return reply.code(503).send({ field: "apiKey", message: "服务端尚未配置密钥加密。配置后再保存 API Key。" });
      }
    });

    admin.post("/agent-settings/assistant", async (request, reply) => {
      const parsed = settingsAdviceRequestSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ message: "请输入一条 1 至 2,000 字的设置问题。" });
      try {
        return await settings.advise(parsed.data) ?? reply.code(503).send({ message: "配置在线模型后可使用设置助手。" });
      } catch {
        return reply.code(502).send({ message: "暂时无法生成有效的设置建议。请重试或直接编辑表单。" });
      }
    });
  });
}
