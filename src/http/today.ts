import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { readToday } from "../app/today.js";

export function registerToday(api: FastifyInstance, pool: Pool, now: () => Date) {
  api.get("/today", request => readToday(pool, request.user!.id, now()));
}
