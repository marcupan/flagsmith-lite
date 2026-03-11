import fastify from 'fastify';
import cors from '@fastify/cors';
import { randomUUID } from 'node:crypto';
import { API_VERSION, HealthResponse } from '@project/shared';

const isProd = process.env.NODE_ENV === 'production';

const server = fastify({
  // Built-in pino logger — structured JSON in prod, pretty-print in dev
  logger: isProd
    ? { level: 'info' }
    : {
        level: 'debug',
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss Z' },
        },
      },
  // Attach a UUID v4 request ID to every request; used in logs + response header
  genReqId: (req) =>
    (req.headers['x-request-id'] as string | undefined) ?? randomUUID(),
});

// Expose request ID as a response header so clients can correlate errors
server.addHook('onSend', async (request, reply) => {
  reply.header('x-request-id', request.id);
});

await server.register(cors, {
  // Read allowed origins from env; fall back to localhost for local dev
  origin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
});

server.setErrorHandler((error, request, reply) => {
  const statusCode = error.statusCode ?? 500;
  if (statusCode >= 500) {
    request.log.error({ err: error }, 'Unhandled server error');
  } else {
    request.log.warn({ err: error }, 'Client error');
  }
  reply.status(statusCode).send({
    code: 'INTERNAL_ERROR',
    message: statusCode >= 500 ? 'Internal server error' : error.message,
    requestId: request.id,
  });
});

server.get('/health', async (): Promise<HealthResponse> => {
  return {
    status: 'ok',
    version: API_VERSION,
    timestamp: new Date().toISOString(),
  };
});

const port = Number(process.env.PORT ?? 3000);
await server.listen({ port, host: '0.0.0.0' });
