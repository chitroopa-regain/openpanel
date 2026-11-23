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

/**
 * Advisory lock key shared by every drop/undrop of a project (taken shared)
 * and the full resync below (taken exclusive), so a resync never reads
 * Postgres before an action commits and then overwrites its Redis write.
 */
export function projectDropLockKey(projectId: string) {
  return `event-drop-project:${projectId}`;
}

const SYNC_TX_TIMEOUT_MS = 30 * 1000;

/** Rebuilds op:dropped:<projectId> from event_meta, atomically. */
export async function syncDroppedEventsToRedis(projectId: string) {
  const { db } = await import('../prisma-client');
  await db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${projectDropLockKey(projectId)}))`;
      const dropped = await tx.eventMeta.findMany({
        where: { projectId, droppedAt: { not: null } },
        select: { name: true },
      });
      const key = DROPPED_SET_KEY(projectId);
      // One MULTI: ingest never sees the set empty in between.
      const multi = getRedisCache().multi().del(key);
      if (dropped.length > 0) {
        multi.sadd(key, ...dropped.map((d) => d.name));
      }
      const results = await withTimeout(multi.exec(), 5000, 'syncDroppedEventsToRedis');
      const failed = results?.find(([error]) => error);
      if (!results || failed) {
        throw new Error(
          `syncDroppedEventsToRedis: Redis transaction failed for ${projectId}: ${failed?.[0]?.message ?? 'aborted'}`,
        );
      }
    },
    { timeout: SYNC_TX_TIMEOUT_MS, maxWait: SYNC_TX_TIMEOUT_MS },
  );
}

/**
 * Redis writes cannot be cancelled: one that timed out (Redis slow or
 * reconnecting) may still land after a newer action and leave the set out of
 * step with Postgres. A periodic full resync bounds that to this interval.
 */
export const DROPPED_SET_RESYNC_MS = 60 * 1000;

/** Resyncs every project's set; returns how many projects were synced. */
export async function syncAllDroppedEventsToRedis(): Promise<number> {
  const { db } = await import('../prisma-client');
  const projects = await db.project.findMany({ select: { id: true } });
  await Promise.all(projects.map((p) => syncDroppedEventsToRedis(p.id)));
  return projects.length;
}
