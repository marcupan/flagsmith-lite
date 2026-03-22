import type { FastifyPluginAsync } from "fastify";
import { API_VERSION, Timestamp, type HealthResponse } from "@project/shared";

export const healthRoute: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Reply: HealthResponse }>("/health", async () => ({
    status: "ok",
    version: API_VERSION,
    timestamp: Timestamp(),
  }));
};
