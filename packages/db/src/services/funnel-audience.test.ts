import { describe, expect, it, vi } from 'vitest';

// funnel.service imports the prisma client at module scope, which needs env.
// Mock it the same way funnel.service.test.ts mocks the ClickHouse client.
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

const AUDIENCE = "profile_id IN (SELECT profile_id FROM events WHERE name = 'X')";

const sqlFor = (over: any = {}) => {
  // default to session mode; profile mode is asserted separately
  const built = svc.buildFunnelCte({ groupBy: 'session_id', ...base, ...over } as any);
  return typeof built.query === 'string' ? built.query : built.query.toSQL();
};

describe('funnel audience attachment', () => {
  it('attaches as a session semi-join, never as a row filter on profile_id', () => {
    const sql = sqlFor({ audiencePredicate: AUDIENCE });
    expect(sql).toContain('session_id IN (');
    expect(sql).toContain('SELECT DISTINCT session_id');
    // The base rows must NOT be filtered by profile membership directly — that
    // would delete anonymous pre-login steps of an otherwise eligible session.
    const outsideSubquery = sql.slice(0, sql.indexOf('SELECT DISTINCT session_id'));
    expect(outsideSubquery).not.toContain('profile_id IN (SELECT profile_id FROM events');
  });

  it('extends eligibility to endDate + funnelWindow, not endDate', () => {
    // Step 1 is anchored to [start, end] but later steps may land inside the
    // funnel window after end. A user who identifies in that tail must stay
    // eligible, so the eligibility bound has to match the scan bound.
    const sql = sqlFor({ audiencePredicate: AUDIENCE });
    const sub = sql.slice(sql.indexOf('SELECT DISTINCT session_id'));
    expect(sub).toContain('addSeconds(toDateTime(');
    expect(sub).toContain('86400');
  });

  it('excludes empty session ids from eligibility', () => {
    const sql = sqlFor({ audiencePredicate: AUDIENCE });
    expect(sql).toContain("session_id != ''");
  });

  it('emits the eligibility subquery exactly once regardless of step count', () => {
    const sql = sqlFor({
      audiencePredicate: AUDIENCE,
      eventSeries: [
        { id: 'A', name: 'A', filters: [], segment: 'event' },
        { id: 'B', name: 'B', filters: [], segment: 'event' },
        { id: 'C', name: 'C', filters: [], segment: 'event' },
        { id: 'D', name: 'D', filters: [], segment: 'event' },
      ] as any,
    });
    expect(sql.split('SELECT DISTINCT session_id').length - 1).toBe(1);
  });

  it('uses a PROFILE filter in profile mode, not a session semi-join', () => {
    // Profile mode computes windowFunnel per profile_id directly and already
    // excludes anonymous rows. A session semi-join there would admit every row
    // of an eligible session, so another profile sharing that session would get
    // its own funnel group and be counted despite not being a cohort member.
    const sql = sqlFor({ audiencePredicate: AUDIENCE, groupBy: 'profile_id' });
    expect(sql).not.toContain('SELECT DISTINCT session_id');
    expect(sql).toContain('profile_id IN (');
  });

  it('uses a SESSION semi-join in session mode', () => {
    const sql = sqlFor({ audiencePredicate: AUDIENCE, groupBy: 'session_id' });
    expect(sql).toContain('SELECT DISTINCT session_id');
  });

  it('adds no eligibility clause when there is no audience', () => {
    const sql = sqlFor({ audiencePredicate: null });
    expect(sql).not.toContain('SELECT DISTINCT session_id');
  });
});

describe('isMvEligibleFunnel', () => {
  const params = {
    eventSeries: [{ id: 'A', name: 'A', filters: [], segment: 'event' }] as any,
    breakdowns: [],
    groupBy: 'profile_id' as const,
    anyFilterOnProfile: false,
    anyBreakdownOnProfile: false,
    projectId: 'regain-app',
    traitDescriptors: new Map(),
    startDate: '2026-07-22 00:00:00',
  };

  it('refuses the MV fast path when an audience is present', async () => {
    // event_profile_firsts_local has no session_id, so session eligibility
    // cannot be expressed against it at all.
    await expect(
      svc.isMvEligibleFunnel({ ...params, hasCohortRestriction: true }),
    ).resolves.toBe(false);
  });

  it('still refuses for the pre-existing reasons (audience check is additive)', async () => {
    await expect(
      svc.isMvEligibleFunnel({ ...params, hasCohortRestriction: false, groupBy: 'session_id' }),
    ).resolves.toBe(false);
    await expect(
      svc.isMvEligibleFunnel({ ...params, hasCohortRestriction: false, anyFilterOnProfile: true }),
    ).resolves.toBe(false);
  });
});

/**
 * funnel_metric's property aggregates used to accept no cohort restriction at
 * all: the funnel above them was filtered while the sums underneath covered the
 * whole population. Nothing errored — the report simply contradicted itself.
 */
describe('getFunnelPropertyStats cohort attachment', () => {
  const statsArgs = (over: any = {}) => ({
    projectId: 'regain-app',
    startDate: '2026-07-22 00:00:00',
    endDate: '2026-08-21 00:00:00',
    stepConditions: ["name = 'A'", "name = 'B'"],
    funnelWindowSeconds: 86_400,
    groupBy: 'profile_id' as const,
    allEventNames: ['A', 'B'],
    propertyKey: 'properties.value',
    timezone: 'Asia/Kolkata',
    ...over,
  });

  // The SQL is captured from the query the service builds rather than executed.
  const capture = async (args: any) => {
    const queries: string[] = [];
    const service = new FunnelService({} as any);
    (service as any).client = {};
    const mod = await import('../clickhouse/client');
    const spy = vi
      .spyOn(mod, 'chQuery')
      .mockImplementation(async (sql: string) => {
        queries.push(sql);
        return [] as any;
      });
    await service.getFunnelPropertyStats(args);
    spy.mockRestore();
    return queries.join('\n');
  };

  it('restricts step_1 by the profile predicate in profile mode', async () => {
    const sql = await capture(statsArgs({ cohortPredicate: AUDIENCE }));
    expect(sql).toContain(AUDIENCE);
    // Profile mode must NOT use the session semi-join: it would admit every row
    // of an eligible session, counting other profiles that share it.
    expect(sql).not.toContain('SELECT DISTINCT session_id');
  });

  it('restricts by eligible sessions in session mode', async () => {
    const sql = await capture(
      statsArgs({ groupBy: 'session_id', cohortPredicate: AUDIENCE }),
    );
    expect(sql).toContain('SELECT DISTINCT session_id');
    expect(sql).toContain("session_id != ''");
  });

  it('adds nothing when there is no cohort restriction', async () => {
    const sql = await capture(statsArgs());
    expect(sql).not.toContain('SELECT DISTINCT session_id');
    expect(sql).not.toContain(AUDIENCE);
  });
});
