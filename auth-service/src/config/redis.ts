import { Redis } from 'ioredis';

const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';

export const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    if (times > 3) {
      return null; // Halt reconnection cycles to avoid resource exhaustion
    }
    return Math.min(times * 100, 2000);
  }
});

redis.on('error', (err) => {
  console.error('Redis cluster client connection failure:', err);
});
