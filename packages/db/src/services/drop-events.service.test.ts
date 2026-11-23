import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const multi = { persist: vi.fn(), rename: vi.fn(), exec: vi.fn() };
  const redis = {
    del: vi.fn(),
    sadd: vi.fn(),
    expire: vi.fn(),
    multi: vi.fn(() => multi),
  };
  const tx = { $executeRaw: vi.fn(), eventMeta: { findMany: vi.fn() } };
  const db = {
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    project: { findMany: vi.fn() },
  };
  return { multi, redis, tx, db };
});

vi.mock('@openpanel/redis', () => ({ getRedisCache: () => mocks.redis }));
vi.mock('../prisma-client', () => ({ db: mocks.db }));

import { syncAllDroppedEventsToRedis, syncDroppedEventsToRedis } from './drop-events.service';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.multi.persist.mockReturnValue(mocks.multi);
  mocks.multi.rename.mockReturnValue(mocks.multi);
  mocks.multi.exec.mockResolvedValue([[null, 1], [null, 'OK']]);
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
    expect(mocks.multi.persist).toHaveBeenCalledWith(tmp);
    expect(mocks.multi.rename).toHaveBeenCalledWith(tmp, 'op:dropped:p1');
    // The live set is never deleted on the way.
    expect(mocks.redis.del).not.toHaveBeenCalled();
  });

  it('clears the set when nothing is dropped', async () => {
    mocks.tx.eventMeta.findMany.mockResolvedValue([]);
    await syncDroppedEventsToRedis('p1');
    expect(mocks.redis.del).toHaveBeenCalledWith('op:dropped:p1');
    expect(mocks.redis.sadd).not.toHaveBeenCalled();
    expect(mocks.multi.rename).not.toHaveBeenCalled();
  });

  it('leaves the live set untouched when building the new one fails', async () => {
    mocks.tx.eventMeta.findMany.mockResolvedValue([{ name: 'A' }]);
    mocks.redis.sadd.mockRejectedValue(new Error('OOM command not allowed'));
    await expect(syncDroppedEventsToRedis('p1')).rejects.toThrow('OOM');
    expect(mocks.multi.rename).not.toHaveBeenCalled();
    expect(mocks.redis.del).not.toHaveBeenCalled();
  });

  it('fails loudly when the swap fails', async () => {
    mocks.tx.eventMeta.findMany.mockResolvedValue([{ name: 'A' }]);
    mocks.multi.exec.mockResolvedValue([[null, 1], [new Error('ERR no such key'), null]]);
    await expect(syncDroppedEventsToRedis('p1')).rejects.toThrow('no such key');
  });
});

describe('syncAllDroppedEventsToRedis (startup, reconnect and the 60 s safety resync)', () => {
  it('resyncs every project from Postgres', async () => {
    mocks.db.project.findMany.mockResolvedValue([{ id: 'p1' }, { id: 'p2' }]);
    mocks.tx.eventMeta.findMany.mockResolvedValue([{ name: 'A' }]);
    await expect(syncAllDroppedEventsToRedis()).resolves.toBe(2);
    expect(mocks.multi.rename.mock.calls.map((c) => c[1]).sort()).toEqual(['op:dropped:p1', 'op:dropped:p2']);
  });
});
