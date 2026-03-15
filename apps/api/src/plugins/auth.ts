import fp from "fastify-plugin";
import { timingSafeEqual } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";

export interface AuthPluginOptions {
  apiKey: string;
}

// Validates X-Api-Key header on all routes in the encapsulated scope.
// Wrapped with fastify-plugin, so the preHandler hook escapes encapsulation
// and applies to sibling plugins registered in the same parent scope.
const authPluginFn: FastifyPluginAsync<AuthPluginOptions> = async (fastify, opts) => {
  const expected = Buffer.from(opts.apiKey);

  fastify.addHook("preHandler", async (request, reply) => {
    const provided = request.headers["x-api-key"];

    // Reject missing or multi-value headers before constant-time compare
    const valid =
      typeof provided === "string" &&
      (() => {
        const buf = Buffer.from(provided);
        return buf.length === expected.length && timingSafeEqual(buf, expected);
      })();

    if (!valid) {
      return reply.status(401).send({
        code: "UNAUTHORIZED",
        message: "Invalid or missing X-Api-Key header",
        requestId: request.id,
      });
    }
  });
};

export const authPlugin = fp(authPluginFn, { name: "auth" });
