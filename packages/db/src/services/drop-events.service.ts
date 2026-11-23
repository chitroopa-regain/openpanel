import { randomUUID } from 'node:crypto';
import { getRedisCache } from '@openpanel/redis';
import { db } from '../prisma-client';

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

const RESYNC_TMP_TTL_SECONDS = 60;

/**
 * Rebuilds op:dropped:<projectId> from event_meta. The new set is built under
 * a temporary key and swapped in with one RENAME, so a failure part-way
 * leaves the old set untouched and ingest never sees it empty.
 */
export async function syncDroppedEventsToRedis(projectId: string) {
  await db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${projectDropLockKey(projectId)}))`;
      const dropped = await tx.eventMeta.findMany({
        where: { projectId, droppedAt: { not: null } },
        select: { name: true },
      });
      const key = DROPPED_SET_KEY(projectId);
      const redis = getRedisCache();
      if (dropped.length === 0) {
        await withTimeout(redis.del(key), 5000, 'syncDroppedEventsToRedis');
        return;
      }
      const tmp = `${key}:resync:${randomUUID()}`;
      await withTimeout(
        redis.sadd(tmp, ...dropped.map((d) => d.name)),
        5000,
        'syncDroppedEventsToRedis build',
      );
      // Cleans up after a crash between SADD and RENAME.
      await withTimeout(redis.expire(tmp, RESYNC_TMP_TTL_SECONDS), 5000, 'syncDroppedEventsToRedis expire');
      // RENAME carries the TTL over, so clear it first and swap only once
      // that worked: the live set must never expire.
      const persisted = await withTimeout(redis.persist(tmp), 5000, 'syncDroppedEventsToRedis persist');
      if (persisted !== 1) {
        throw new Error(`syncDroppedEventsToRedis: could not clear the TTL of ${tmp}`);
      }
      await withTimeout(redis.rename(tmp, key), 5000, 'syncDroppedEventsToRedis swap');
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
  const projects = await db.project.findMany({ select: { id: true } });
  await Promise.all(projects.map((p) => syncDroppedEventsToRedis(p.id)));
  return projects.length;
}
