import { describe, expect, it, vi } from 'vitest';

vi.mock('@openpanel/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
}));

describe('ClickHouse query semaphore', () => {
  it('never runs more than the configured number of queries at once', async () => {
    process.env.OP_CH_MAX_CONCURRENT_QUERIES = '2';
    vi.resetModules();
    const { querySemaphore } = await import('./client');
    let active = 0;
    let peak = 0;
    const job = () =>
      querySemaphore.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
        return 'ok';
      });
    const results = await Promise.all([job(), job(), job(), job(), job()]);
    expect(results).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
    expect(peak).toBe(2);
    expect(querySemaphore.pending).toBe(0);
  });

  it('releases the slot when the query throws', async () => {
    process.env.OP_CH_MAX_CONCURRENT_QUERIES = '1';
    vi.resetModules();
    const { querySemaphore } = await import('./client');
    await expect(
      querySemaphore.run(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(querySemaphore.run(async () => 1)).resolves.toBe(1);
  });

  it('is a pass-through when unset', async () => {
    delete process.env.OP_CH_MAX_CONCURRENT_QUERIES;
    vi.resetModules();
    const { querySemaphore } = await import('./client');
    let active = 0;
    let peak = 0;
    const job = () =>
      querySemaphore.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
      });
    await Promise.all([job(), job(), job()]);
    expect(peak).toBe(3);
  });
});
