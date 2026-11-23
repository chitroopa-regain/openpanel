import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const redis = {
    del: vi.fn(),
    sadd: vi.fn(),
    expire: vi.fn(),
    persist: vi.fn(),
    rename: vi.fn(),
  };
  const tx = { $executeRaw: vi.fn(), eventMeta: { findMany: vi.fn() } };
  const db = {
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    project: { findMany: vi.fn() },
  };
  return { redis, tx, db };
});

vi.mock('@openpanel/redis', () => ({ getRedisCache: () => mocks.redis }));
vi.mock('../prisma-client', () => ({ db: mocks.db }));

import { syncAllDroppedEventsToRedis, syncDroppedEventsToRedis } from './drop-events.service';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.redis.persist.mockResolvedValue(1);
  mocks.redis.rename.mockResolvedValue('OK');
  mocks.redis.del.mockResolvedValue(1);
  mocks.redis.sadd.mockResolvedValue(2);
  mocks.redis.expire.mockResolvedValue(1);
});

describe('syncDroppedEventsToRedis', () => {
  it('takes the project lock exclusive, builds a temp set and swaps it in with RENAME', async () => {
    mocks.tx.eventMeta.findMany.mockResolvedValue([{ name: 'A' }, { name: 'B' }]);
    await syncDroppedEventsToRedis('p1');
    expect(mocks.tx.$executeRaw.mock.calls[0]!.join('')).toContain('pg_advisory_xact_lock(');
    expect(mocks.tx.$executeRaw.mock.calls[0]).toContain('event-drop-project:p1');
    expect(mocks.tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.tx.eventMeta.findMany.mock.invocationCallOrder[0]!
    );
    const tmp = mocks.redis.sadd.mock.calls[0]![0] as string;
    expect(tmp).toMatch(/^op:dropped:p1:resync:/);
    expect(mocks.redis.sadd).toHaveBeenCalledWith(tmp, 'A', 'B');
    expect(mocks.redis.persist).toHaveBeenCalledWith(tmp);
    expect(mocks.redis.rename).toHaveBeenCalledWith(tmp, 'op:dropped:p1');
    // The live set is never deleted on the way.
    expect(mocks.redis.del).not.toHaveBeenCalled();
  });

  it('clears the set when nothing is dropped', async () => {
    mocks.tx.eventMeta.findMany.mockResolvedValue([]);
    await syncDroppedEventsToRedis('p1');
    expect(mocks.redis.del).toHaveBeenCalledWith('op:dropped:p1');
    expect(mocks.redis.sadd).not.toHaveBeenCalled();
    expect(mocks.redis.rename).not.toHaveBeenCalled();
  });

  it('leaves the live set untouched when building the new one fails', async () => {
    mocks.tx.eventMeta.findMany.mockResolvedValue([{ name: 'A' }]);
    mocks.redis.sadd.mockRejectedValue(new Error('OOM command not allowed'));
    await expect(syncDroppedEventsToRedis('p1')).rejects.toThrow('OOM');
    expect(mocks.redis.rename).not.toHaveBeenCalled();
    expect(mocks.redis.del).not.toHaveBeenCalled();
  });

  it('never swaps in a set that still has the temp TTL', async () => {
    mocks.tx.eventMeta.findMany.mockResolvedValue([{ name: 'A' }]);
    mocks.redis.persist.mockRejectedValueOnce(new Error('READONLY'));
    await expect(syncDroppedEventsToRedis('p1')).rejects.toThrow('READONLY');
    mocks.redis.persist.mockResolvedValueOnce(0);
    await expect(syncDroppedEventsToRedis('p1')).rejects.toThrow('could not clear the TTL');
    expect(mocks.redis.rename).not.toHaveBeenCalled();
  });

  it('swaps only after the TTL is cleared', async () => {
    mocks.tx.eventMeta.findMany.mockResolvedValue([{ name: 'A' }]);
    await syncDroppedEventsToRedis('p1');
    expect(mocks.redis.persist.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.redis.rename.mock.invocationCallOrder[0]!
    );
  });
});

describe('syncAllDroppedEventsToRedis (startup, reconnect and the 60 s safety resync)', () => {
  it('resyncs every project from Postgres', async () => {
    mocks.db.project.findMany.mockResolvedValue([{ id: 'p1' }, { id: 'p2' }]);
    mocks.tx.eventMeta.findMany.mockResolvedValue([{ name: 'A' }]);
    await expect(syncAllDroppedEventsToRedis()).resolves.toBe(2);
    expect(mocks.redis.rename.mock.calls.map((c) => c[1]).sort()).toEqual(['op:dropped:p1', 'op:dropped:p2']);
  });
});
