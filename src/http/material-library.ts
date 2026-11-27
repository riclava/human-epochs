import type { FastifyInstance } from "fastify";
import type { createMaterialLibrary } from "../app/material-library.js";
import { materialCommandSchema } from "../contracts/material.js";

export function registerMaterialLibrary(api: FastifyInstance, library: ReturnType<typeof createMaterialLibrary>) {
  api.get("/materials", request => library.read(request.user!.id));
  api.post("/materials/commands", async (request, reply) => {
    const command = materialCommandSchema.safeParse(request.body);
    if (!command.success) return reply.code(400).send({ message: "请刷新材料列表后再试。" });
    const updated = await library.delete(request.user!.id, command.data.materialId);
    return updated ?? reply.code(404).send({ message: "找不到这份材料。请刷新材料列表。" });
  });
}
