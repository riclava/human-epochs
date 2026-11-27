import { PassThrough } from "node:stream";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { createActivityService } from "../app/activities/service.js";
import type { createConversationService } from "../app/conversation/service.js";
import {
  conversationCommandSchema, conversationTextLimit, conversationTitleLimit, reviewInvitationCommandSchema, sendConversationCommandSchema,
  type ConversationStreamEvent,
} from "../contracts/conversation.js";

const deletedMessage = { message: "这个对话已删除。请打开其他对话或新建对话。" };

export function registerConversation(
  api: FastifyInstance,
  conversation: ReturnType<typeof createConversationService>,
  activities: Pick<ReturnType<typeof createActivityService>, "startDiscussionActivity">,
) {
  api.get("/conversations", request => conversation.listConversations(request.user!.id));
  api.get<{ Params: { conversationId: string } }>("/conversations/:conversationId", async (request, reply) => {
    const id = z.uuid().toLowerCase().safeParse(request.params.conversationId);
    if (!id.success) return reply.code(404).send({ message: "找不到这个对话。" });
    const snapshot = await conversation.readSnapshot(request.user!.id, id.data);
    return snapshot ?? reply.code(410).send(deletedMessage);
  });
  api.post<{ Params: { conversationId: string } }>("/conversations/:conversationId/commands", async (request, reply) => {
    const id = z.uuid().toLowerCase().safeParse(request.params.conversationId);
    const command = conversationCommandSchema.safeParse(request.body);
    if (!id.success) return reply.code(404).send({ message: "找不到这个对话。" });
    if (!command.success) return reply.code(400).send({ message: `请输入 1 至 ${conversationTitleLimit} 个字的标题。` });
    const result = await conversation.runConversationCommand(request.user!.id, id.data, command.data);
    if (result.kind === "missing") return reply.code(404).send({ message: "找不到这个对话。请刷新对话列表。" });
    if (result.kind === "conflict") return reply.code(409).send({ message: "这个操作已用于其他内容。请重新操作。" });
    return result.list;
  });
  api.get("/conversation/materials", () => conversation.listMaterials());

  api.post("/conversation/review-invitations", async (request, reply) => {
    const command = reviewInvitationCommandSchema.safeParse(request.body);
    if (!command.success) return reply.code(400).send({ message: "请重新打开对话后再试。" });
    const userId = request.user!.id;
    const result = await conversation.applyReviewInvitationCommand(userId, command.data);
    if (result === "missing") return reply.code(404).send({ message: "这条复习邀请已不可用。" });
    if (result === "conflict") return reply.code(409).send({ message: "对话已更新，请查看最新消息。" });
    return await conversation.readSnapshot(userId, command.data.conversationId) ?? reply.code(410).send(deletedMessage);
  });

  api.post<{ Params: { requestId: string } }>("/conversation/:requestId/stop", async (request, reply) => {
    const id = z.uuid().toLowerCase().safeParse(request.params.requestId);
    const missing = { message: "找不到这条消息。" };
    if (!id.success) return reply.code(404).send(missing);
    const turn = await conversation.stopTurn(request.user!.id, id.data,
      event => request.log.info({ ...event, requestId: id.data }, "Conversation turn"));
    return turn ? { turn } : reply.code(404).send(missing);
  });

  // A message may carry a newly attached source of up to 500,000 characters.
  api.post("/conversation", { bodyLimit: 4 * 1024 * 1024 }, async (request, reply) => {
    const parsed = sendConversationCommandSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: `请输入 1 至 ${conversationTextLimit} 个字符，并重新发送。` });
    const requestId = parsed.data.requestId;
    const result = await conversation.prepareTurn(request.user!.id, parsed.data,
      event => request.log.info({ ...event, requestId }, "Conversation turn"));
    if (result.kind === "invalid_material") return reply.code(400).send({ message: "请重新选择可访问的材料。每段讨论最多保留 16 个来源，原文合计最多 32,000 个字符。" });
    if (result.kind === "invalid_review") return reply.code(409).send({ message: "这道复习题已不可用。请查看最新消息。" });
    if (result.kind === "conflict") return reply.code(409).send({ message: result.message });
    if (result.kind === "deleted") return reply.code(410).send(deletedMessage);

    reply.type("text/event-stream; charset=utf-8").header("X-Accel-Buffering", "no");
    const frame = (event: ConversationStreamEvent) => `data: ${JSON.stringify(event)}\n\n`;
    if (result.kind === "existing") {
      return reply.send(frame({ kind: "turn", turn: result.turn }));
    }

    const stream = new PassThrough();
    const send = (event: ConversationStreamEvent) => {
      if (!stream.destroyed) stream.write(frame(event));
    };
    const heartbeat = setInterval(() => {
      if (!stream.destroyed) stream.write(": keep-alive\n\n");
    }, 15_000);
    // A disconnected reader can recover the published turn from the snapshot.
    reply.raw.once("close", () => {
      clearInterval(heartbeat);
      stream.destroy();
    });
    reply.send(stream);
    send({ kind: "received", requestId });
    void result.run(text => send({ kind: "delta", text }), progress => send({ kind: "progress", progress })).then(turn => {
      send({ kind: "turn", turn });
    }).catch(() => {
      // The service recorded the failed write. Reconnect through the snapshot.
    }).finally(() => {
      clearInterval(heartbeat);
      stream.end();
    });
    return reply;
  });

  api.post<{ Params: { requestId: string } }>("/conversation/:requestId/activity", async (request, reply) => {
    const id = z.uuid().safeParse(request.params.requestId);
    const unavailable = { message: "无法从这段讨论开始活动。" };
    if (!id.success) return reply.code(404).send(unavailable);
    const activity = await activities.startDiscussionActivity(request.user!.id, id.data);
    return activity ?? reply.code(404).send(unavailable);
  });
}
