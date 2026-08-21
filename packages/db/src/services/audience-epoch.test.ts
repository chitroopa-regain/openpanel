import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ queryRaw: vi.fn() }));

vi.mock('../prisma-client', () => ({ db: { $queryRaw: mocks.queryRaw } }));

import {
  __resetAudienceEpochMemo,
  getAudienceEpoch,
  invalidateAudienceEpoch,
} from './audience-epoch.service';


const digest = (d: string) => mocks.queryRaw.mockResolvedValue([{ digest: d }]);

describe('getAudienceEpoch', () => {
  beforeEach(() => {
    __resetAudienceEpochMemo();
    mocks.queryRaw.mockReset();
  });

  it('changes when the underlying definitions change', async () => {
    digest('aaa');
    const before = await getAudienceEpoch();
    invalidateAudienceEpoch();
    digest('bbb');
    expect(await getAudienceEpoch()).not.toBe(before);
  });

  it('is stable while nothing changes', async () => {
    digest('aaa');
    const a = await getAudienceEpoch();
    invalidateAudienceEpoch();
    expect(await getAudienceEpoch()).toBe(a);
  });

  it('memoises so it does not query per request', async () => {
    digest('aaa');
    await getAudienceEpoch();
    await getAudienceEpoch();
    await getAudienceEpoch();
    expect(mocks.queryRaw).toHaveBeenCalledTimes(1);
  });

  it('handles an empty project with no cohorts or custom events', async () => {
    digest('d41d8cd98f00b204e9800998ecf8427e');
    expect(await getAudienceEpoch()).toBe('d41d8cd98f00b204e9800998ecf8427e');
  });

  it('digests CONTENT, so no timestamp granularity can hide an edit', async () => {
    // Two prior forms collided: max(updatedAt)+counts (two rows edited in the
    // same millisecond) and per-row (id, updatedAt) (the SAME row edited twice
    // within one tick — custom_events has no version column to break the tie).
    // Hashing the definitions themselves removes the whole class.
    mocks.queryRaw.mockImplementation((strings: TemplateStringsArray) => {
      const sql = String(strings.raw ? strings.raw.join('') : strings);
      expect(sql).toContain('string_agg');
      expect(sql).toContain('custom_cohorts');
      expect(sql).toContain('custom_events');
      expect(sql).toContain('definition');
      expect(sql).toContain('components');
      expect(sql).not.toContain('max(');
      expect(sql).not.toContain('updatedAt');
      return Promise.resolve([{ digest: 'x' }]);
    });
    await getAudienceEpoch();
    expect(mocks.queryRaw).toHaveBeenCalled();
  });
});
