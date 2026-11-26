import { PassThrough } from "node:stream";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { createActivityService } from "../app/activities/service.js";
import type { createChatService } from "../app/chat/service.js";
import { chatTextLimit, type ChatStreamEvent } from "../contracts/chat.js";

const clean = (max: number) => z.string().trim().min(1).max(max).refine(value => !/[\u0000\uD800-\uDFFF]/u.test(value));
const materialInput = z.strictObject({
  version: clean(160).optional(), parentRequestId: z.uuid().toLowerCase().optional(),
  sourceIds: z.array(clean(160)).max(16).optional(),
  excerpt: z.strictObject({ label: clean(120), text: clean(4000) }).optional(),
});
const chatRequest = z.strictObject({
  requestId: z.uuid().toLowerCase(),
  text: clean(chatTextLimit),
  material: materialInput.optional(),
});

export function registerChat(
  api: FastifyInstance,
  chat: ReturnType<typeof createChatService>,
  activities: Pick<ReturnType<typeof createActivityService>, "startPractice">,
) {
  api.get("/chat", request => chat.readSnapshot(request.learner!.id));
  api.get("/chat/materials", () => chat.listMaterials());

  api.post<{ Params: { id: string } }>("/chat/:id/stop", async (request, reply) => {
    const id = z.uuid().toLowerCase().safeParse(request.params.id);
    const missing = { message: "找不到这条消息。" };
    if (!id.success) return reply.code(404).send(missing);
    const turn = await chat.stopTurn(request.learner!.id, id.data,
      event => request.log.info({ ...event, requestId: id.data }, "Chat turn"));
    return turn ? { turn } : reply.code(404).send(missing);
  });

  api.post("/chat", async (request, reply) => {
    const parsed = chatRequest.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: `请输入 1 至 ${chatTextLimit} 个字符，并重新发送。` });
    const requestId = parsed.data.requestId;
    const result = await chat.prepareTurn(request.learner!.id, parsed.data,
      event => request.log.info({ ...event, requestId }, "Chat turn"));
    if (result.kind === "invalid_material") return reply.code(400).send({ message: "请重新选择可读的材料。每段讨论最多保留 16 段原文，共 32000 个字符。" });
    if (result.kind === "conflict") return reply.code(409).send({ message: result.message });

    reply.type("text/event-stream; charset=utf-8").header("X-Accel-Buffering", "no");
    const frame = (event: ChatStreamEvent) => `data: ${JSON.stringify(event)}\n\n`;
    if (result.kind === "existing") {
      return reply.send(frame({ kind: "turn", turn: result.turn }));
    }

    const stream = new PassThrough();
    const send = (event: ChatStreamEvent) => {
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

  api.post<{ Params: { id: string } }>("/chat/:id/practice", async (request, reply) => {
    const id = z.uuid().safeParse(request.params.id);
    const unavailable = { message: "这段讨论没有可接续的已发布练习。" };
    if (!id.success) return reply.code(404).send(unavailable);
    const activity = await activities.startPractice(request.learner!.id, id.data);
    return activity ?? reply.code(404).send(unavailable);
  });
}
