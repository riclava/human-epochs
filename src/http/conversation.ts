import { PassThrough } from "node:stream";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { createActivityService } from "../app/activities/service.js";
import type { createConversationService } from "../app/conversation/service.js";
import { conversationTextLimit, reviewInvitationCommandSchema, sendConversationCommandSchema, type ConversationStreamEvent } from "../contracts/conversation.js";

export function registerConversation(
  api: FastifyInstance,
  conversation: ReturnType<typeof createConversationService>,
  activities: Pick<ReturnType<typeof createActivityService>, "startDiscussionActivity">,
) {
  api.get("/conversations", request => conversation.listConversations(request.user!.id));
  api.get<{ Params: { conversationId: string } }>("/conversations/:conversationId", async (request, reply) => {
    const id = z.uuid().toLowerCase().safeParse(request.params.conversationId);
    if (!id.success) return reply.code(404).send({ message: "找不到这个对话。" });
    return conversation.readSnapshot(request.user!.id, id.data);
  });
  api.get("/conversation/materials", () => conversation.listMaterials());

  api.post("/conversation/review-invitations", async (request, reply) => {
    const command = reviewInvitationCommandSchema.safeParse(request.body);
    if (!command.success) return reply.code(400).send({ message: "请重新打开对话后再试。" });
    const userId = request.user!.id;
    const result = await conversation.applyReviewInvitationCommand(userId, command.data);
    if (result === "missing") return reply.code(404).send({ message: "这条复习邀请已不可用。" });
    if (result === "conflict") return reply.code(409).send({ message: "对话已更新，请查看最新消息。" });
    return conversation.readSnapshot(userId, command.data.conversationId);
  });

  api.post<{ Params: { requestId: string } }>("/conversation/:requestId/stop", async (request, reply) => {
    const id = z.uuid().toLowerCase().safeParse(request.params.requestId);
    const missing = { message: "找不到这条消息。" };
    if (!id.success) return reply.code(404).send(missing);
    const turn = await conversation.stopTurn(request.user!.id, id.data,
      event => request.log.info({ ...event, requestId: id.data }, "Conversation turn"));
    return turn ? { turn } : reply.code(404).send(missing);
  });

  api.post("/conversation", async (request, reply) => {
    const parsed = sendConversationCommandSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: `请输入 1 至 ${conversationTextLimit} 个字符，并重新发送。` });
    const requestId = parsed.data.requestId;
    const result = await conversation.prepareTurn(request.user!.id, parsed.data,
      event => request.log.info({ ...event, requestId }, "Conversation turn"));
    if (result.kind === "invalid_material") return reply.code(400).send({ message: "请重新选择可访问的材料。每段讨论最多保留 16 个来源，原文合计最多 32,000 个字符。" });
    if (result.kind === "invalid_review") return reply.code(409).send({ message: "这道复习题已不可用。请查看最新消息。" });
    if (result.kind === "conflict") return reply.code(409).send({ message: result.message });

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
