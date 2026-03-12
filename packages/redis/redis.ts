import { getSuperJson, setSuperJson } from '@openpanel/json';
import type { RedisOptions } from 'ioredis';
import { Redis } from 'ioredis';

const options: RedisOptions = {
  connectTimeout: 10000,
};

export { Redis };

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const REDIS_SENTINELS = process.env.REDIS_SENTINELS;
const REDIS_MASTER_NAME = process.env.REDIS_MASTER_NAME;
const REDIS_PASSWORD = process.env.REDIS_PASSWORD;

export interface ExtendedRedis extends Redis {
  getJson: <T = any>(key: string) => Promise<T | null>;
  setJson: <T = any>(
    key: string,
    expireInSec: number,
    value: T,
  ) => Promise<void>;
}

const createRedisClient = (
  name: string,
  url: string,
  overrides: RedisOptions = {},
): ExtendedRedis => {
  let client: ExtendedRedis;
  if (REDIS_SENTINELS && !REDIS_MASTER_NAME) {
    throw new Error('REDIS_MASTER_NAME is required when REDIS_SENTINELS is set');
  }
  if (REDIS_MASTER_NAME && !REDIS_SENTINELS) {
    throw new Error('REDIS_SENTINELS is required when REDIS_MASTER_NAME is set');
  }
  if (REDIS_SENTINELS) {
    const sentinels = REDIS_SENTINELS.split(',').map((s) => {
      const [host, port] = s.trim().split(':');
      return { host, port: parseInt(port || '26379') };
    });
    client = new Redis({
      sentinels,
      name: REDIS_MASTER_NAME,
      password: REDIS_PASSWORD,
      ...options,
      ...overrides,
    }) as ExtendedRedis;
  } else {
    client = new Redis(url, {
      ...options,
      ...overrides,
    }) as ExtendedRedis;
  }

  client.on('error', (error) => {
    console.error(`[${name}] Redis Client Error:`, error);
  });

  client.getJson = async <T = any>(key: string): Promise<T | null> => {
    const value = await client.get(key);
    if (value) {
      const res = getSuperJson(value) as T;
      if (res && Array.isArray(res) && res.length === 0) {
        return null;
      }

      if (res && typeof res === 'object' && Object.keys(res).length === 0) {
        return null;
      }

      if (res) {
        return res;
      }
    }
    return null;
  };

  client.setJson = async <T = any>(
    key: string,
    expireInSec: number,
    value: T,
  ): Promise<void> => {
    await client.setex(key, expireInSec, setSuperJson(value));
  };

  return client;
};

let redisCache: ExtendedRedis;
export function getRedisCache() {
  if (!redisCache) {
    redisCache = createRedisClient('redis-cache', REDIS_URL, options);
  }

  return redisCache;
}

let redisSub: ExtendedRedis;
export function getRedisSub() {
  if (!redisSub) {
    redisSub = createRedisClient('redis-sub', REDIS_URL, {
      ...options,
      // Disable ready check for subscription client since it uses INFO command
      // which is not allowed once the client enters subscription mode
      enableReadyCheck: false,
    });
  }

  return redisSub;
}

let redisPub: ExtendedRedis;
export function getRedisPub() {
  if (!redisPub) {
    redisPub = createRedisClient('redis-pub', REDIS_URL, options);
  }

  return redisPub;
}

let redisQueue: ExtendedRedis;
export function getRedisQueue() {
  if (!redisQueue) {
    // Use different redis for queues (self-hosting will re-use the same redis instance)
    redisQueue = createRedisClient('redis-queue', REDIS_URL, {
      ...options,
      enableReadyCheck: false,
      maxRetriesPerRequest: null,
      enableOfflineQueue: true,
    });
  }

  return redisQueue;
}

let redisGroupQueue: ExtendedRedis;
export function getRedisGroupQueue() {
  if (!redisGroupQueue) {
    // Dedicated Redis connection for GroupWorker to avoid blocking BullMQ
    redisGroupQueue = createRedisClient('redis-group-queue', REDIS_URL, {
      ...options,
      enableReadyCheck: false,
      maxRetriesPerRequest: null,
      enableOfflineQueue: true,
    });
  }

  return redisGroupQueue;
}

export async function getLock(key: string, value: string, timeout: number) {
  const lock = await getRedisCache().set(key, value, 'PX', timeout, 'NX');
  return lock === 'OK';
}
