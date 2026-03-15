import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";

export interface AuthPluginOptions {
  apiKey: string;
}

// Validates X-Api-Key header on all routes in the encapsulated scope.
// Wrapped with fastify-plugin, so the preHandler hook escapes encapsulation
// and applies to sibling plugins registered in the same parent scope.
const authPluginFn: FastifyPluginAsync<AuthPluginOptions> = async (fastify, opts) => {
  fastify.addHook("preHandler", async (request, reply) => {
    const provided = request.headers["x-api-key"];

    if (!provided || provided !== opts.apiKey) {
      return reply.status(401).send({
        code: "UNAUTHORIZED",
        message: "Invalid or missing X-Api-Key header",
        requestId: request.id,
      });
    }
  });
};

export const authPlugin = fp(authPluginFn, { name: "auth" });
