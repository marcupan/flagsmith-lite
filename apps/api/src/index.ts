import fastify from 'fastify';
import cors from '@fastify/cors';
import { API_VERSION, HealthResponse } from '@project/shared';

const server = fastify();

await server.register(cors, {
  origin: '*',
});

server.get('/health', async (): Promise<HealthResponse> => {
  return {
    status: 'ok',
    version: API_VERSION,
    timestamp: new Date().toISOString()
  };
});

server.listen({ port: 3000, host: '0.0.0.0' }, (err) => {
  if (err) throw err;
  console.log('Server running on http://localhost:3000');
});
