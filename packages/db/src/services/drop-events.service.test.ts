import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const multi = { del: vi.fn(), sadd: vi.fn(), exec: vi.fn() };
  multi.del.mockReturnValue(multi);
  multi.sadd.mockReturnValue(multi);
  const tx = { $executeRaw: vi.fn(), eventMeta: { findMany: vi.fn() } };
  const db = { $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  return { multi, tx, db, redis: { multi: vi.fn(() => multi) } };
});

vi.mock('@openpanel/redis', () => ({ getRedisCache: () => mocks.redis }));
vi.mock('../prisma-client', () => ({ db: mocks.db }));

import { syncDroppedEventsToRedis } from './drop-events.service';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.multi.del.mockReturnValue(mocks.multi);
  mocks.multi.sadd.mockReturnValue(mocks.multi);
  mocks.multi.exec.mockResolvedValue([[null, 1], [null, 2]]);
});

describe('syncDroppedEventsToRedis', () => {
  it('takes the project lock exclusive, then replaces the set in one MULTI', async () => {
    mocks.tx.eventMeta.findMany.mockResolvedValue([{ name: 'A' }, { name: 'B' }]);
    await syncDroppedEventsToRedis('p1');
    expect(mocks.tx.$executeRaw.mock.calls[0]!.join('')).toContain('pg_advisory_xact_lock(');
    expect(mocks.tx.$executeRaw.mock.calls[0]).toContain('event-drop-project:p1');
    expect(mocks.tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.tx.eventMeta.findMany.mock.invocationCallOrder[0]!
    );
    expect(mocks.redis.multi).toHaveBeenCalledOnce();
    expect(mocks.multi.del).toHaveBeenCalledWith('op:dropped:p1');
    expect(mocks.multi.sadd).toHaveBeenCalledWith('op:dropped:p1', 'A', 'B');
    expect(mocks.multi.exec).toHaveBeenCalledOnce();
  });

  it('clears the set when nothing is dropped', async () => {
    mocks.tx.eventMeta.findMany.mockResolvedValue([]);
    mocks.multi.exec.mockResolvedValue([[null, 1]]);
    await syncDroppedEventsToRedis('p1');
    expect(mocks.multi.del).toHaveBeenCalledWith('op:dropped:p1');
    expect(mocks.multi.sadd).not.toHaveBeenCalled();
  });

  it('fails loudly when the Redis transaction fails', async () => {
    mocks.tx.eventMeta.findMany.mockResolvedValue([{ name: 'A' }]);
    mocks.multi.exec.mockResolvedValue([[new Error('OOM'), null]]);
    await expect(syncDroppedEventsToRedis('p1')).rejects.toThrow('OOM');
  });
});
