import { getRedisCache } from '@openpanel/redis';

const DROPPED_SET_KEY = (projectId: string) => `op:dropped:${projectId}`;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label}: Redis timeout after ${ms}ms`)), ms),
    ),
  ]);
}

export async function addDroppedEvent(projectId: string, eventName: string) {
  const redis = getRedisCache();
  await withTimeout(
    redis.sadd(DROPPED_SET_KEY(projectId), eventName),
    5000,
    'addDroppedEvent',
  );
  const isMember = await withTimeout(
    redis.sismember(DROPPED_SET_KEY(projectId), eventName),
    5000,
    'addDroppedEvent verify',
  );
  if (!isMember) {
    throw new Error(
      `Redis write verification failed: '${eventName}' not in op:dropped:${projectId} after SADD`,
    );
  }
}

export async function removeDroppedEvent(
  projectId: string,
  eventName: string,
) {
  const redis = getRedisCache();
  await withTimeout(
    redis.srem(DROPPED_SET_KEY(projectId), eventName),
    5000,
    'removeDroppedEvent',
  );
  const isMember = await withTimeout(
    redis.sismember(DROPPED_SET_KEY(projectId), eventName),
    5000,
    'removeDroppedEvent verify',
  );
  if (isMember) {
    throw new Error(
      `Redis write verification failed: '${eventName}' still in op:dropped:${projectId} after SREM`,
    );
  }
}

export async function getDroppedEvents(projectId: string): Promise<string[]> {
  return getRedisCache().smembers(DROPPED_SET_KEY(projectId));
}

export async function syncDroppedEventsToRedis(projectId: string) {
  const { db } = await import('../prisma-client');
  const dropped = await db.eventMeta.findMany({
    where: { projectId, droppedAt: { not: null } },
    select: { name: true },
  });
  const key = DROPPED_SET_KEY(projectId);
  const redis = getRedisCache();
  await redis.del(key);
  if (dropped.length > 0) {
    await redis.sadd(key, ...dropped.map((d) => d.name));
  }
}
