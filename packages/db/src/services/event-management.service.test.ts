import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const db = {
    project: { findUnique: vi.fn() },
    eventMeta: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
    },
    dashboard: { findMany: vi.fn(), findFirst: vi.fn() },
    report: { findMany: vi.fn(), findFirst: vi.fn() },
    customEvent: { findMany: vi.fn() },
    customCohort: { findMany: vi.fn() },
    resourceView: { findMany: vi.fn() },
    eventDropAudit: { create: vi.fn(), update: vi.fn(), findMany: vi.fn() },
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
  };
  return {
    db,
    chQuery: vi.fn(),
    addDroppedEvent: vi.fn(),
    removeDroppedEvent: vi.fn(),
    clearMetas: vi.fn(),
  };
});

vi.mock('../prisma-client', () => ({ db: mocks.db }));
vi.mock('../clickhouse/client', () => ({
  ch: { query: mocks.chQuery },
  TABLE_NAMES: { event_names_mv: 'distinct_event_names_mv' },
}));
vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('./drop-events.service', () => ({
  addDroppedEvent: mocks.addDroppedEvent,
  removeDroppedEvent: mocks.removeDroppedEvent,
  projectDropLockKey: (projectId: string) => `event-drop-project:${projectId}`,
}));
vi.mock('./event.service', () => ({
  getEventMetasCached: { clear: mocks.clearMetas },
}));

import { EventDropError } from './event-drop-rules';
import {
  buildSlackText,
  dropManagedEvent,
  getEventVolumes,
  listManagedEvents,
  recordResourceView,
  undropManagedEvent,
} from './event-management.service';

const { db } = mocks;
const PROJECT = { id: 'regain-app', name: 'Regain Android', organizationId: 'org1' };

function chResult(rows: unknown[]) {
  return { json: async () => rows };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.OPENPANEL_SLACK_WEBHOOK_URL;
  process.env.DASHBOARD_URL = 'https://op.example.com';
  db.project.findUnique.mockResolvedValue(PROJECT);
  db.eventMeta.findUnique.mockResolvedValue(null);
  db.eventMeta.findMany.mockResolvedValue([]);
  db.eventMeta.upsert.mockResolvedValue({});
  db.eventMeta.updateMany.mockResolvedValue({ count: 1 });
  db.eventMeta.update.mockResolvedValue({});
  db.dashboard.findMany.mockResolvedValue([
    { id: 'd-c73', name: 'C73 OB offer spin A/B', updatedAt: new Date() },
  ]);
  db.report.findMany.mockResolvedValue([
    {
      id: 'r1',
      name: 'Home funnel',
      dashboardId: 'd-c73',
      updatedAt: new Date(),
      events: [{ id: 'A', type: 'event', name: 'Home Page: Shown', segment: 'event', filters: [] }],
      breakdowns: [],
      options: null,
      cohortFilters: null,
      cohortBreakdown: null,
    },
  ]);
  db.customEvent.findMany.mockResolvedValue([]);
  db.customCohort.findMany.mockResolvedValue([]);
  db.resourceView.findMany.mockResolvedValue([]);
  db.eventDropAudit.create.mockResolvedValue({ id: 'audit-1' });
  db.eventDropAudit.update.mockResolvedValue({});
  db.$transaction.mockImplementation(async (fn: (tx: typeof db) => unknown) => fn(db));
  mocks.addDroppedEvent.mockResolvedValue(undefined);
  mocks.removeDroppedEvent.mockResolvedValue(undefined);
  mocks.clearMetas.mockResolvedValue(1);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('dropManagedEvent', () => {
  it('drops an unused event: Redis set, droppedAt, audit row; never touches ClickHouse', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const result = await dropManagedEvent({
      projectId: 'regain-app',
      name: 'App Init: Logback Only',
      confirmName: 'App Init: Logback Only',
      source: 'Agent',
      requestedBy: 'Chitroopa',
      chatUrl: 'https://maker.example.com/maker/abc',
      reason: 'Not used anywhere; 5.4M/day',
    });
    expect(mocks.addDroppedEvent).toHaveBeenCalledWith('regain-app', 'App Init: Logback Only');
    expect(db.eventMeta.upsert).toHaveBeenCalledOnce();
    expect(db.eventDropAudit.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'drop',
          source: 'Agent',
          requestedBy: 'Chitroopa',
          chatUrl: 'https://maker.example.com/maker/abc',
          reason: 'Not used anywhere; 5.4M/day',
          boardsAffected: [],
        }),
      })
    );
    expect(mocks.chQuery).not.toHaveBeenCalled();
    // Slack webhook unset: skipped silently.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.auditId).toBe('audit-1');
    // No recovery promise: dropped events are not kept.
    expect(result).not.toHaveProperty('recoverableUntil');
  });

  it('refuses a used event without a reason before touching Redis', async () => {
    await expect(
      dropManagedEvent({
        projectId: 'regain-app',
        name: 'Home Page: Shown',
        confirmName: 'Home Page: Shown',
        source: 'UI',
      })
    ).rejects.toMatchObject({ code: 'REASON_REQUIRED', httpStatus: 409 });
    expect(mocks.addDroppedEvent).not.toHaveBeenCalled();
  });

  it('drops anyway with a reason, snapshots the boards and posts to Slack', async () => {
    process.env.OPENPANEL_SLACK_WEBHOOK_URL = 'https://hooks.slack.test/x';
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchSpy);
    await dropManagedEvent({
      projectId: 'regain-app',
      name: 'Home Page: Shown',
      confirmName: 'Home Page: Shown',
      source: 'UI',
      reason: 'Tracked by Home: Opened now',
    });
    const audit = db.eventDropAudit.create.mock.calls[0]![0].data;
    expect(audit.action).toBe('drop_anyway');
    expect(audit.boardsAffected).toEqual([
      {
        id: 'd-c73',
        name: 'C73 OB offer spin A/B',
        url: 'https://op.example.com/org1/regain-app/dashboards/d-c73',
        active: true,
      },
    ]);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body);
    expect(body.text).toContain('Dropped anyway');
    expect(body.text).toContain('C73 OB offer spin A/B');
    expect(db.eventDropAudit.update).toHaveBeenCalledWith({
      where: { id: 'audit-1' },
      data: { slackPosted: true },
    });
  });

  it('a failing Slack webhook does not fail the drop', async () => {
    process.env.OPENPANEL_SLACK_WEBHOOK_URL = 'https://hooks.slack.test/x';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));
    await expect(
      dropManagedEvent({
        projectId: 'regain-app',
        name: 'App Init: Theme Set',
        confirmName: 'App Init: Theme Set',
        source: 'UI',
      })
    ).resolves.toMatchObject({ status: 'dropped' });
    expect(db.eventDropAudit.update).toHaveBeenCalledWith({
      where: { id: 'audit-1' },
      data: { slackPosted: false },
    });
  });

  it('takes the per-event lock and writes Redis last, after the DB rows', async () => {
    await dropManagedEvent({
      projectId: 'regain-app',
      name: 'App Init: Theme Set',
      confirmName: 'App Init: Theme Set',
      source: 'UI',
    });
    // Shared project lock (a full resync takes it exclusive), then the event lock.
    expect(db.$executeRaw).toHaveBeenCalledTimes(2);
    expect(db.$executeRaw.mock.calls[0]!.join('')).toContain('pg_advisory_xact_lock_shared');
    expect(db.$executeRaw.mock.calls[0]).toContain('event-drop-project:regain-app');
    expect(db.$executeRaw.mock.calls[1]).toContain('event-drop:regain-app:App Init: Theme Set');
    const lockOrder = db.$executeRaw.mock.invocationCallOrder[1]!;
    const upsertOrder = db.eventMeta.upsert.mock.invocationCallOrder[0]!;
    const auditOrder = db.eventDropAudit.create.mock.invocationCallOrder[0]!;
    const redisOrder = mocks.addDroppedEvent.mock.invocationCallOrder[0]!;
    expect(lockOrder).toBeLessThan(upsertOrder);
    expect(upsertOrder).toBeLessThan(redisOrder);
    expect(auditOrder).toBeLessThan(redisOrder);
  });

  it('reconciles Redis to the committed state when Redis fails', async () => {
    mocks.addDroppedEvent.mockRejectedValueOnce(new Error('redis timeout'));
    // The transaction rolled back, so Postgres says "not dropped".
    db.eventMeta.findUnique.mockResolvedValue(null);
    await expect(
      dropManagedEvent({
        projectId: 'regain-app',
        name: 'App Init: Theme Set',
        confirmName: 'App Init: Theme Set',
        source: 'UI',
      })
    ).rejects.toMatchObject({ code: 'UNAVAILABLE', httpStatus: 503 });
    expect(mocks.removeDroppedEvent).toHaveBeenCalledWith('regain-app', 'App Init: Theme Set');
  });

  it('reconciles to "dropped" when another request committed the drop meanwhile', async () => {
    db.eventDropAudit.create.mockRejectedValueOnce(new Error('pg blip'));
    db.eventMeta.findUnique
      .mockResolvedValueOnce(null) // inside the transaction
      .mockResolvedValueOnce({ droppedAt: new Date() }); // committed state, read after
    await expect(
      dropManagedEvent({
        projectId: 'regain-app',
        name: 'App Init: Theme Set',
        confirmName: 'App Init: Theme Set',
        source: 'UI',
      })
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(mocks.addDroppedEvent).toHaveBeenCalledWith('regain-app', 'App Init: Theme Set');
    expect(mocks.removeDroppedEvent).not.toHaveBeenCalled();
  });

  it('rolls Redis back when the database write fails', async () => {
    db.eventMeta.upsert.mockRejectedValue(new Error('pg down'));
    await expect(
      dropManagedEvent({
        projectId: 'regain-app',
        name: 'App Init: Theme Set',
        confirmName: 'App Init: Theme Set',
        source: 'UI',
      })
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(mocks.removeDroppedEvent).toHaveBeenCalledWith('regain-app', 'App Init: Theme Set');
  });

  it('allows a re-drop right after an undrop (no cooldown, no replay)', async () => {
    db.eventMeta.findUnique.mockResolvedValue({ droppedAt: new Date() });
    await undropManagedEvent({ projectId: 'regain-app', name: 'App Init: Theme Set', confirmName: 'App Init: Theme Set', source: 'UI' });
    db.eventMeta.findUnique.mockResolvedValue({ droppedAt: null });
    const result = await dropManagedEvent({
      projectId: 'regain-app',
      name: 'App Init: Theme Set',
      confirmName: 'App Init: Theme Set',
      source: 'UI',
    });
    expect(result.status).toBe('dropped');
    expect(mocks.addDroppedEvent).toHaveBeenCalledWith('regain-app', 'App Init: Theme Set');
  });

  it('needs requestedBy for Agent drops and an http(s) chat URL', async () => {
    await expect(
      dropManagedEvent({
        projectId: 'regain-app',
        name: 'X',
        confirmName: 'X',
        source: 'Agent',
      })
    ).rejects.toBeInstanceOf(EventDropError);
    await expect(
      dropManagedEvent({
        projectId: 'regain-app',
        name: 'X',
        confirmName: 'X',
        source: 'Agent',
        requestedBy: 'TR',
        chatUrl: 'javascript:alert(1)',
      })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('404s an unknown project', async () => {
    db.project.findUnique.mockResolvedValue(null);
    await expect(
      dropManagedEvent({ projectId: 'nope', name: 'X', confirmName: 'X', source: 'UI' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
  });
});

describe('undropManagedEvent', () => {
  it('undrops: lets new events in, clears droppedAt, audits; no replay', async () => {
    const droppedAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    db.eventMeta.findUnique.mockResolvedValue({ droppedAt });
    const result = await undropManagedEvent({
      projectId: 'regain-app',
      name: 'Group Preview: Page Changed',
      confirmName: 'Group Preview: Page Changed',
      source: 'UI',
    });
    expect(mocks.removeDroppedEvent).toHaveBeenCalledWith('regain-app', 'Group Preview: Page Changed');
    expect(db.eventMeta.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { droppedAt: null, clearedAt: null } })
    );
    expect(db.eventDropAudit.create.mock.calls[0]![0].data).toMatchObject({
      action: 'undrop',
      eventName: 'Group Preview: Page Changed',
      // Start of the gap, for the board note.
      droppedFrom: droppedAt,
    });
    expect(db.eventDropAudit.create.mock.calls[0]![0].data).not.toHaveProperty('replayRequestId');
    expect(result).toEqual({ name: 'Group Preview: Page Changed', status: 'active', auditId: 'audit-1' });
  });

  it('refuses an event that is not dropped', async () => {
    await expect(
      undropManagedEvent({ projectId: 'regain-app', name: 'A', confirmName: 'A', source: 'UI' })
    ).rejects.toMatchObject({ code: 'NOT_DROPPED' });
    expect(mocks.removeDroppedEvent).not.toHaveBeenCalled();
  });
});

describe('recordResourceView', () => {
  it('records a view of a board in the project', async () => {
    db.dashboard.findFirst.mockResolvedValue({ id: 'd1' });
    await expect(
      recordResourceView({ projectId: 'regain-app', resourceType: 'dashboard', resourceId: 'd1' })
    ).resolves.toBe(true);
    expect(db.$executeRaw).toHaveBeenCalledOnce();
  });

  it('ignores boards and reports of other projects and bad report ids', async () => {
    db.dashboard.findFirst.mockResolvedValue(null);
    db.report.findFirst.mockResolvedValue(null);
    await expect(
      recordResourceView({ projectId: 'regain-app', resourceType: 'dashboard', resourceId: 'other' })
    ).resolves.toBe(false);
    await expect(
      recordResourceView({
        projectId: 'regain-app',
        resourceType: 'report',
        resourceId: '3f2b6a1e-0000-4000-8000-000000000001',
      })
    ).resolves.toBe(false);
    await expect(
      recordResourceView({ projectId: 'regain-app', resourceType: 'report', resourceId: 'not-a-uuid' })
    ).resolves.toBe(false);
    expect(db.report.findFirst).toHaveBeenCalledOnce();
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });
});

describe('listManagedEvents', () => {
  it('still lists events with "—" volume when event_name_daily is missing', async () => {
    db.eventMeta.findMany.mockResolvedValue([
      { name: 'Old Thing', droppedAt: new Date('2026-11-23T10:00:00Z') },
    ]);
    mocks.chQuery.mockImplementation(async ({ query }: { query: string }) => {
      if (query.includes('event_name_daily')) {
        throw new Error('Code: 60. DB::Exception: Table openpanel.event_name_daily does not exist. (UNKNOWN_TABLE)');
      }
      return chResult([{ name: 'Home Page: Shown' }, { name: 'session_start' }, { name: '*' }]);
    });
    const result = await listManagedEvents({ projectId: 'regain-app' });
    expect(result.volumeAvailable).toBe(false);
    expect(result.events.map((e) => [e.name, e.status, e.volume1d])).toEqual(
      expect.arrayContaining([
        ['Home Page: Shown', 'active', null],
        ['session_start', 'protected', null],
        ['Old Thing', 'dropped', null],
      ])
    );
    expect(result.events.find((e) => e.name === 'Old Thing')).not.toHaveProperty('recoverableUntil');
    expect(result.counts).toMatchObject({ all: 3, used: 1, unused: 0, dropped: 1, protected: 1 });
  });

  it('computes % of project and the "Not used + high volume" filter', async () => {
    mocks.chQuery.mockImplementation(async ({ query }: { query: string }) => {
      if (query.includes('event_name_rollup_days')) {
        return chResult([{ day: '2026-11-22' }]);
      }
      if (query.includes('event_name_daily')) {
        return chResult([
          { name: 'Big Unused', v1: 900, v7: 6000, v30: 25000, last_seen_ts: 1763891000, daily: [['2026-11-22', 900]], volume_day: '2026-11-22' },
          { name: 'Home Page: Shown', v1: 96, v7: 600, v30: 2500, last_seen_ts: 1763891000, daily: [], volume_day: '2026-11-22' },
          { name: 'Tiny Unused', v1: 4, v7: 20, v30: 80, last_seen_ts: 0, daily: [], volume_day: '2026-11-22' },
        ]);
      }
      return chResult([]);
    });
    const result = await listManagedEvents({ projectId: 'regain-app', filter: 'unused_high' });
    expect(result.volumeAvailable).toBe(true);
    expect(result.events.map((e) => e.name)).toEqual(['Big Unused']);
    expect(result.events[0]!.pctOfProject).toBe(90);
    expect(result.events[0]!.trend30d).toHaveLength(30);
    expect(result.events[0]!.trend30d!.at(-1)).toBe(900);
    expect(result.totals).toMatchObject({ events: 3, volume1d: 1000, unusedEvents: 2, unusedVolume1d: 904 });
    expect(result.counts.unused_high).toBe(1);
    expect(result.volumeDay).toBe('2026-11-22');
    expect(result.volumeIsPartial).toBe(false);
  });

  it('before any finished day: 1d is today so far, 7d/30d are "—", same 1d drives % and filters', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-23T06:00:00Z')); // 11:30 IST
    try {
      mocks.chQuery.mockImplementation(async ({ query }: { query: string }) => {
        if (query.includes('event_name_rollup_days')) {
          return chResult([]);
        }
        if (query.includes('event_name_daily')) {
          return chResult([
            { name: 'Big Unused', v1: 300, v7: 300, v30: 300, last_seen_ts: 0, computed_ms: Date.parse('2026-11-23T05:31:00Z'), daily: [['2026-11-23', 300]] },
            { name: 'Home Page: Shown', v1: 100, v7: 100, v30: 100, last_seen_ts: 0, computed_ms: 0, daily: [['2026-11-23', 100]] },
          ]);
        }
        return chResult([]);
      });
      const result = await listManagedEvents({ projectId: 'regain-app' });
      expect(result.volumeIsPartial).toBe(true);
      expect(result.volumeDay).toBe('2026-11-23');
      expect(result.volumeAsOf).toBe('2026-11-23T05:31:00.000Z');
      const big = result.events.find((e) => e.name === 'Big Unused')!;
      expect(big).toMatchObject({ volume1d: 300, volume7d: null, volume30d: null, pctOfProject: 75 });
      expect(big.trend30d!.at(-1)).toBe(300);
      expect(result.totals.volume1d).toBe(400);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('getEventVolumes (IST days; ClickHouse today() is UTC and never used)', () => {
  const daily = () => mocks.chQuery.mock.calls.map((c) => c[0].query as string).find((q) => q.includes('event_name_daily'))!;
  const rollup = () => mocks.chQuery.mock.calls.map((c) => c[0].query as string).find((q) => q.includes('event_name_rollup_days'))!;

  it('23:59 IST is still the 23rd; 00:01 IST is the 24th', async () => {
    mocks.chQuery.mockImplementation(async ({ query }: { query: string }) =>
      chResult([])
    );
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-11-23T18:29:00Z')); // 23:59 IST
      expect((await getEventVolumes('regain-app')).volumeDay).toBe('2026-11-23');
      expect(rollup()).toContain("day < toDate('2026-11-23')");
      mocks.chQuery.mockClear();
      vi.setSystemTime(new Date('2026-11-23T18:31:00Z')); // 00:01 IST on the 24th, still the 23rd in UTC
      expect((await getEventVolumes('regain-app')).volumeDay).toBe('2026-11-24');
      expect(rollup()).toContain("day < toDate('2026-11-24')");
      expect(daily()).not.toContain('today()');
      expect(rollup()).not.toContain('today()');
    } finally {
      vi.useRealTimers();
    }
  });

  it('anchors 1d/7d/30d and the trend on the newest finished day', async () => {
    mocks.chQuery.mockImplementation(async ({ query }: { query: string }) => {
      if (query.includes('event_name_rollup_days')) {
        return chResult([{ day: '2026-11-21' }, { day: '2026-11-15' }]);
      }
      return chResult([
        { name: 'A', v1: 10, v7: 70, v30: 300, last_seen_ts: 0, computed_ms: 0, daily: [['2026-11-21', 10], ['2026-11-15', 9]] },
      ]);
    });
    const result = await getEventVolumes('regain-app', new Date('2026-11-23T06:00:00Z'));
    expect(result).toMatchObject({ available: true, volumeDay: '2026-11-21', partial: false, asOf: null });
    expect(result.rows.get('A')).toMatchObject({ volume1d: 10, volume7d: 70, volume30d: 300 });
    expect(result.rows.get('A')!.trend30d.at(-1)).toBe(10);
    expect(result.rows.get('A')!.trend30d.at(-7)).toBe(9);
    expect(daily()).toContain("sumIf(e, day = toDate('2026-11-21'))");
    expect(daily()).toContain("day > toDate('2026-11-21') - 7 AND day <= toDate('2026-11-21')");
    expect(daily()).toContain('FINAL');
    expect(rollup()).toContain('pass >= 1 AND running = 0');
    // Anchor has no lower bound; the day list is the 30 days ending on it.
    expect(rollup()).toContain("WHERE pass >= 1 AND running = 0 AND day < toDate('2026-11-23')");
    expect(rollup()).toContain('day <= anchor AND day > anchor - 30');
  });

  it('an old newest finished day (rollup stalled) still anchors the windows, not "today so far"', async () => {
    mocks.chQuery.mockImplementation(async ({ query }: { query: string }) =>
      chResult(query.includes('event_name_rollup_days') ? [{ day: '2026-10-01' }, { day: '2026-09-20' }] : [])
    );
    const result = await getEventVolumes('regain-app', new Date('2026-11-23T06:00:00Z'));
    expect(result).toMatchObject({ volumeDay: '2026-10-01', partial: false });
    expect(daily()).toContain("day > toDate('2026-10-01') - 30 AND day <= toDate('2026-10-01')");
    // Last seen still reads the rows after the anchor, up to today.
    expect(daily()).toContain("AND day > toDate('2026-10-01') - 30 AND day <= toDate('2026-11-23')");
  });

  it('7d/30d leave out days that are not finished (e.g. a recount still running)', async () => {
    mocks.chQuery.mockImplementation(async ({ query }: { query: string }) =>
      // 22 Nov is being recounted (running = 1), so the query does not return it.
      chResult(query.includes('event_name_rollup_days') ? [{ day: '2026-11-21' }, { day: '2026-11-19' }] : [])
    );
    await getEventVolumes('regain-app', new Date('2026-11-23T06:00:00Z'));
    expect(daily()).toContain("AND day IN (toDate('2026-11-21'), toDate('2026-11-19'))) AS v7");
    expect(daily()).toContain("AND day IN (toDate('2026-11-21'), toDate('2026-11-19'))) AS v30");
    expect(daily()).toContain("sumIf(e, day = toDate('2026-11-21')) AS v1");
  });

  it('any other rollup_days error shows "—" instead of unfinished numbers', async () => {
    mocks.chQuery.mockImplementation(async ({ query }: { query: string }) => {
      if (query.includes('event_name_rollup_days')) {
        throw new Error('Timeout exceeded: elapsed 30000 ms');
      }
      return chResult([{ name: 'A', v1: 5, v7: 5, v30: 5, last_seen_ts: 0, computed_ms: 0, daily: [] }]);
    });
    const result = await getEventVolumes('regain-app', new Date('2026-11-23T06:00:00Z'));
    expect(result).toMatchObject({ available: false, volumeDay: null });
    expect(daily()).toBeUndefined();
  });

  it('falls back to yesterday (IST) when the rollup_days table is missing', async () => {
    mocks.chQuery.mockImplementation(async ({ query }: { query: string }) => {
      if (query.includes('event_name_rollup_days')) {
        throw new Error('Code: 60. DB::Exception: Table openpanel.event_name_rollup_days does not exist. (UNKNOWN_TABLE)');
      }
      return chResult([]);
    });
    const result = await getEventVolumes('regain-app', new Date('2026-11-23T18:31:00Z'));
    expect(result).toMatchObject({ available: true, volumeDay: '2026-11-23', partial: false });
    // Every day up to yesterday counts: no finished-day filter.
    expect(daily()).not.toContain('day IN');
  });
});

describe('buildSlackText', () => {
  it('names the action, reason, who asked and the boards', () => {
    const text = buildSlackText({
      projectName: 'Regain Android',
      eventName: 'App Init: Logback Only',
      action: 'drop',
      reason: 'Not used <anywhere>',
      source: 'Agent',
      requestedBy: 'Chitroopa',
      chatUrl: 'https://maker.example.com/maker/abc',
      boards: [{ name: 'C64 Launch Board', url: 'https://op/x', active: false }],
      extra: 'events sent while dropped are not kept',
    });
    expect(text).toContain('*Dropped* `App Init: Logback Only` in Regain Android');
    expect(text).toContain('Reason: Not used &lt;anywhere&gt;');
    expect(text).toContain('Via: Agent (asked by Chitroopa, <https://maker.example.com/maker/abc|chat>)');
    expect(text).toContain('Boards: <https://op/x|C64 Launch Board>');
    expect(text).toContain('events sent while dropped are not kept');
  });
});
