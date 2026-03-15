import { Redis } from "ioredis";

export type Cache = Redis;

// Create a Redis client. Use lazyConnect so the process doesn't crash on
// startup if Redis is unreachable — callers handle errors per-request.
//
// IMPORTANT: The 'error' listener is mandatory. Without it, any Redis error
// becomes an uncaught Node.js exception and crashes the process.
// 'reconnecting' is informational — helps correlate Redis gaps in logs.
export function createCache(url: string): Cache {
  const redis = new Redis(url, { lazyConnect: true, enableOfflineQueue: false });

  redis.on("error", (err: Error) => {
    // Log only — route handlers catch and handle Redis errors individually.
    // Do NOT throw here: this event fires outside any request context.
    console.error({ err }, "Redis error");
  });

  redis.on("reconnecting", (delay: number) => {
    console.warn({ delay }, "Redis reconnecting");
  });

  return redis;
}
