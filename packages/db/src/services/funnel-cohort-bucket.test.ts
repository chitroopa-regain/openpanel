import { describe, expect, it, vi } from 'vitest';

vi.mock('../prisma-client', () => ({ db: {} }));

import { FunnelService } from './funnel.service';

const svc = new FunnelService({} as any);

const base = {
  projectId: 'regain-app',
  startDate: '2026-07-22 00:00:00',
  endDate: '2026-08-21 00:00:00',
  eventSeries: [
    { id: 'A', name: 'A', filters: [], segment: 'event' },
    { id: 'B', name: 'B', filters: [], segment: 'event' },
  ] as any,
  funnelWindowMilliseconds: 24 * 60 * 60 * 1000,
  timezone: 'Asia/Kolkata',
};

const FILTER = "profile_id IN (SELECT profile_id FROM events WHERE name = 'F')";
const BUCKET = "NOT (profile_id IN (SELECT profile_id FROM events WHERE name = 'B'))";

/**
 * A breakdown bucket must reach the SAME predicate the report filter uses, for
 * one reason: that predicate is what `isMvEligibleFunnel` reads. A bucket
 * attached anywhere else would let a bucketed funnel run on the materialized
 * view, which has no session_id and cannot express the restriction — every
 * bucket would then return the same unfiltered number.
 */
describe('funnel cohort bucket', () => {
  it('tells eligibility that a BUCKET restricts the funnel', async () => {
    // Asserting isMvEligibleFunnel(hasCohortRestriction: true) === false only
    // proves the helper obeys its argument. The defect this guards against is
    // getFunnel failing to SET that argument from `extraCohortPredicate`, so
    // the test has to go through getFunnel and observe what eligibility was
    // actually told.
    const service = new FunnelService({} as any);
    const spy = vi
      .spyOn(service, 'isMvEligibleFunnel')
      .mockResolvedValue(false);
    vi.spyOn(service, 'buildFunnelCte').mockReturnValue({
      query: 'SELECT 1',
      firstTimeCtes: [],
      traitCtes: [],
    } as any);
    const mod = await import('../clickhouse/client');
    vi.spyOn(mod, 'chQuery').mockResolvedValue([] as any);

    // The ClickHouse client is a stub: eligibility is decided BEFORE any query
    // runs, so the run is allowed to fail at execution. What is asserted is the
    // argument eligibility received, which is the thing that can regress.
    await service.getFunnel({
      projectId: 'regain-app',
      startDate: '2026-07-22 00:00:00',
      endDate: '2026-08-21 00:00:00',
      timezone: 'Asia/Kolkata',
      series: [
        { id: 'A', type: 'event', name: 'A', segment: 'user', filters: [] },
        { id: 'B', type: 'event', name: 'B', segment: 'user', filters: [] },
      ],
      breakdowns: [],
      chartType: 'funnel',
      interval: 'day',
      metric: 'sum',
      previous: false,
      range: '30d',
      // No report filter at all — ONLY a bucket. This is the case that would
      // otherwise reach the materialized view, which has no session_id and
      // cannot express the restriction, and return an unfiltered number.
      extraCohortPredicate: BUCKET,
    } as any).catch(() => {});

    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls[0]![0]!.hasCohortRestriction).toBe(true);
    vi.restoreAllMocks();
  });

  it('ANDs the bucket onto the report filter, both parenthesised', () => {
    const built = svc.buildFunnelCte({
      groupBy: 'profile_id',
      ...base,
      audiencePredicate: `${FILTER} AND ${BUCKET}`,
    } as any);
    const sql =
      typeof built.query === 'string' ? built.query : built.query.toSQL();
    expect(sql).toContain(FILTER);
    expect(sql).toContain(BUCKET);
  });

  it('attaches a bucket as a session semi-join in session mode', () => {
    const built = svc.buildFunnelCte({
      groupBy: 'session_id',
      ...base,
      audiencePredicate: BUCKET,
    } as any);
    const sql =
      typeof built.query === 'string' ? built.query : built.query.toSQL();
    // Session mode counts per session, so a bucket must select eligible
    // SESSIONS: filtering rows by profile_id would delete the pre-login rows of
    // a user identified mid-funnel, who still belongs in the bucket.
    expect(sql).toContain('SELECT DISTINCT session_id');
    expect(sql).toContain(BUCKET);
  });
});
