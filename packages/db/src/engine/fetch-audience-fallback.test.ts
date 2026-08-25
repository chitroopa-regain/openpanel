import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression test for a shipped bug: the empty-result fallback in `fetch()` ran
 * UNFILTERED.
 *
 * `audiencePredicate` is a call-time argument, not part of `queryInput`, so the
 * fallback's `{...queryInput, breakdowns: []}` spread silently dropped it. A report
 * with an audience whose breakdown legitimately matched nothing therefore retried
 * without the audience and rendered a confident non-zero total — a wrong number with
 * no error anywhere.
 */

const mocks = vi.hoisted(() => ({
  chQuery: vi.fn(),
  getChartSql: vi.fn(),
  resolveAudience: vi.fn(),
  resolveCohortsForBreakdown: vi.fn(),
}));

vi.mock('../clickhouse/client', () => ({
  chQuery: mocks.chQuery,
  ch: {},
  TABLE_NAMES: { events: 'events', profiles: 'profiles' },
}));
vi.mock('../prisma-client', () => ({ db: {} }));
vi.mock('../services/chart.service', () => ({ getChartSql: mocks.getChartSql }));
vi.mock('../services/custom-cohort.service', () => ({
  resolveAudience: mocks.resolveAudience,
  resolveCohortsForBreakdown: mocks.resolveCohortsForBreakdown,
}));

const AUDIENCE_SQL = "profile_id IN (SELECT profile_id FROM cohort_42)";

function makePlan(): any {
  const definition = {
    id: 'A',
    type: 'event',
    name: 'FT: Overlay Shown',
    segment: 'event',
    filters: [],
  };
  return {
    timezone: 'UTC',
    membershipAsOf: '2026-08-01',
    definitions: [definition],
    concreteSeries: [{ definitionId: 'A', id: 'A', name: ['FT: Overlay Shown'] }],
    input: {
      projectId: 'p1',
      startDate: '2026-07-01',
      endDate: '2026-08-01',
      audience: { cohortIds: ['cohort-42'] },
      breakdowns: [{ name: 'country' }],
      interval: 'day',
    },
  };
}

describe('fetch() empty-result fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveAudience.mockResolvedValue({ render: () => AUDIENCE_SQL });
    mocks.resolveCohortsForBreakdown.mockResolvedValue([]);
    mocks.getChartSql.mockImplementation(() => 'SELECT 1');
    // First query (with breakdowns) returns nothing -> triggers the fallback.
    mocks.chQuery.mockResolvedValueOnce([]).mockResolvedValue([]);
  });

  it('carries audiencePredicate into the no-breakdown retry', async () => {
    const { fetch } = await import('./fetch');
    await fetch(makePlan());

    // Two getChartSql calls: the breakdown query, then the fallback.
    expect(mocks.getChartSql.mock.calls.length).toBeGreaterThanOrEqual(2);

    const primary = mocks.getChartSql.mock.calls[0]![0] as any;
    const fallback = mocks.getChartSql.mock.calls[1]![0] as any;

    // The fallback is identifiable by having dropped the breakdowns.
    expect(primary.breakdowns?.length ?? 0).toBeGreaterThan(0);
    expect(fallback.breakdowns).toEqual([]);

    // The bug: this was undefined, so the retry queried the whole population.
    expect(fallback.audiencePredicate).toBe(AUDIENCE_SQL);
    expect(fallback.audiencePredicate).toBe(primary.audiencePredicate);
  });
});
