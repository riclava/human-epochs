import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { searchConversations } from "../app/conversation-search.js";
import { searchQuerySchema } from "../contracts/search.js";

export function registerConversationSearch(api: FastifyInstance, pool: Pool) {
  api.get("/conversation-search", async (request, reply) => {
    const query = searchQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ message: "请输入 1 到 100 个字的搜索内容。" });
    return searchConversations(pool, request.user!.id, query.data.q);
  });
}
