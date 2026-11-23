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
    eventDropAudit: { create: vi.fn(), update: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), groupBy: vi.fn() },
    eventReplayRequest: { create: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn() },
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
vi.mock('./organization.service', () => ({
  getSettingsForProject: async () => ({ timezone: 'Asia/Kolkata' }),
}));
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
}));
vi.mock('./event.service', () => ({
  getEventMetasCached: { clear: mocks.clearMetas },
}));

import { EventDropError } from './event-drop-rules';
import {
  buildSlackText,
  dropManagedEvent,
  INGEST_REFRESH_GRACE_MS,
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
  db.eventReplayRequest.create.mockResolvedValue({ id: 'replay-1' });
  db.eventReplayRequest.findFirst.mockResolvedValue(null);
  db.eventReplayRequest.findMany.mockResolvedValue([]);
  db.eventDropAudit.findFirst.mockResolvedValue(null);
  db.eventDropAudit.groupBy.mockResolvedValue([]);
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
    expect(
      new Date(result.recoverableUntil).getTime() - new Date(result.droppedAt).getTime()
    ).toBe(24 * 60 * 60 * 1000);
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
    expect(db.$executeRaw).toHaveBeenCalledOnce();
    expect(db.$executeRaw.mock.calls[0]).toContain('event-drop:regain-app:App Init: Theme Set');
    const lockOrder = db.$executeRaw.mock.invocationCallOrder[0]!;
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

  it('refuses a re-drop (409) while a replay of the event is pending or running', async () => {
    db.eventReplayRequest.findFirst.mockResolvedValue({ id: 'replay-9' });
    await expect(
      dropManagedEvent({
        projectId: 'regain-app',
        name: 'App Init: Theme Set',
        confirmName: 'App Init: Theme Set',
        source: 'Agent',
        requestedBy: 'Chitroopa',
      })
    ).rejects.toMatchObject({
      code: 'REDROP_COOLDOWN',
      httpStatus: 409,
      message: 'Replay of this event is still running; try again when it finishes',
    });
    expect(db.eventReplayRequest.findFirst.mock.calls[0]![0].where).toMatchObject({
      eventName: 'App Init: Theme Set',
      status: { in: ['pending', 'running'] },
    });
    expect(mocks.addDroppedEvent).not.toHaveBeenCalled();
    expect(db.eventMeta.upsert).not.toHaveBeenCalled();
  });

  it('refuses a re-drop (409) for 24 h after the last undrop', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-23T12:00:00Z'));
    try {
      db.eventDropAudit.findFirst.mockResolvedValue({ createdAt: new Date('2026-11-23T03:30:00Z') });
      await expect(
        dropManagedEvent({
          projectId: 'regain-app',
          name: 'App Init: Theme Set',
          confirmName: 'App Init: Theme Set',
          source: 'UI',
        })
      ).rejects.toMatchObject({
        code: 'REDROP_COOLDOWN',
        httpStatus: 409,
        message:
          'This event was undropped at 23 Nov 2026, 09:00 GMT+5:30; it can be dropped again after 24 Nov 2026, 09:00 GMT+5:30',
      });
      expect(db.eventDropAudit.findFirst.mock.calls[0]![0]).toMatchObject({
        where: { eventName: 'App Init: Theme Set', action: { in: ['undrop', 'undrop_replay'] } },
        orderBy: { createdAt: 'desc' },
      });
      expect(mocks.addDroppedEvent).not.toHaveBeenCalled();
      expect(db.eventMeta.upsert).not.toHaveBeenCalled();

      // 24 h later the same drop goes ahead.
      vi.setSystemTime(new Date('2026-11-24T03:30:01Z'));
      await dropManagedEvent({
        projectId: 'regain-app',
        name: 'App Init: Theme Set',
        confirmName: 'App Init: Theme Set',
        source: 'UI',
      });
      expect(mocks.addDroppedEvent).toHaveBeenCalledWith('regain-app', 'App Init: Theme Set');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports the cooldown, not "give a reason", for a used event dropped with no reason', async () => {
    db.eventDropAudit.findFirst.mockResolvedValue({ createdAt: new Date(Date.now() - 60 * 1000) });
    await expect(
      dropManagedEvent({
        projectId: 'regain-app',
        name: 'Home Page: Shown',
        confirmName: 'Home Page: Shown',
        source: 'UI',
      })
    ).rejects.toMatchObject({ code: 'REDROP_COOLDOWN', httpStatus: 409 });

    // Without the cooldown the same request still needs a reason.
    db.eventDropAudit.findFirst.mockResolvedValue(null);
    await expect(
      dropManagedEvent({
        projectId: 'regain-app',
        name: 'Home Page: Shown',
        confirmName: 'Home Page: Shown',
        source: 'UI',
      })
    ).rejects.toMatchObject({ code: 'REASON_REQUIRED' });
  });

  it('still reports a confirmation typo before the cooldown', async () => {
    db.eventDropAudit.findFirst.mockResolvedValue({ createdAt: new Date(Date.now() - 60 * 1000) });
    await expect(
      dropManagedEvent({
        projectId: 'regain-app',
        name: 'App Init: Theme Set',
        confirmName: 'App Init: Theme',
        source: 'UI',
      })
    ).rejects.toMatchObject({ code: 'CONFIRM_MISMATCH' });
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
  it('undrops and queues a replay of the held window', async () => {
    const droppedAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    db.eventMeta.findUnique.mockResolvedValue({ droppedAt });
    const result = await undropManagedEvent({
      projectId: 'regain-app',
      name: 'Group Preview: Page Changed',
      confirmName: 'Group Preview: Page Changed',
      replay: true,
      source: 'UI',
    });
    expect(mocks.removeDroppedEvent).toHaveBeenCalledWith('regain-app', 'Group Preview: Page Changed');
    const replay = db.eventReplayRequest.create.mock.calls[0]![0].data;
    expect(replay).toMatchObject({ projectId: 'regain-app', eventName: 'Group Preview: Page Changed' });
    expect(replay.fromTs).toEqual(droppedAt);
    // The window runs past the undrop by ingest's refresh grace.
    expect(replay.toTs.getTime()).toBeGreaterThanOrEqual(
      Date.now() + INGEST_REFRESH_GRACE_MS - 1000
    );
    expect(db.eventDropAudit.create.mock.calls[0]![0].data).toMatchObject({
      action: 'undrop_replay',
      replayRequestId: 'replay-1',
    });
    expect(result.replayRequestId).toBe('replay-1');
  });

  it('keeps the 24 h start clamp at the real undrop time', async () => {
    const droppedAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    db.eventMeta.findUnique.mockResolvedValue({ droppedAt });
    const before = Date.now();
    await undropManagedEvent({ projectId: 'regain-app', name: 'A', confirmName: 'A', replay: true, source: 'UI' });
    const { fromTs, toTs } = db.eventReplayRequest.create.mock.calls[0]![0].data;
    expect(fromTs.getTime()).toBeGreaterThanOrEqual(before - 24 * 60 * 60 * 1000);
    expect(fromTs.getTime()).toBeLessThanOrEqual(Date.now() - 24 * 60 * 60 * 1000);
    expect(toTs.getTime() - fromTs.getTime()).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000 + INGEST_REFRESH_GRACE_MS - 50);
  });

  it('starts after the previous replay so a quick drop/undrop/drop/undrop never copies twice', async () => {
    const droppedAt = new Date(Date.now() - 10 * 1000);
    const previousEnd = new Date(Date.now() + 20 * 1000); // earlier replay's grace still running
    db.eventMeta.findUnique.mockResolvedValue({ droppedAt });
    db.eventReplayRequest.findFirst.mockResolvedValue({ toTs: previousEnd });
    await undropManagedEvent({ projectId: 'regain-app', name: 'A', confirmName: 'A', replay: true, source: 'UI' });
    const { fromTs, toTs } = db.eventReplayRequest.create.mock.calls[0]![0].data;
    expect(fromTs).toEqual(previousEnd);
    expect(toTs.getTime()).toBeGreaterThan(previousEnd.getTime());
    // Failed earlier replays do not count as covered.
    expect(db.eventReplayRequest.findFirst.mock.calls[0]![0].where).toMatchObject({
      status: { not: 'failed' },
    });
  });

  it('undrops without replay', async () => {
    db.eventMeta.findUnique.mockResolvedValue({ droppedAt: new Date() });
    const result = await undropManagedEvent({
      projectId: 'regain-app',
      name: 'A',
      confirmName: 'A',
      replay: false,
      source: 'UI',
    });
    expect(db.eventReplayRequest.create).not.toHaveBeenCalled();
    expect(result.replayRequestId).toBeNull();
  });

  it('refuses an event that is not dropped', async () => {
    await expect(
      undropManagedEvent({ projectId: 'regain-app', name: 'A', confirmName: 'A', replay: true, source: 'UI' })
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
    db.eventReplayRequest.findMany.mockResolvedValue([{ eventName: 'Home Page: Shown' }]);
    const undropAt = new Date(Date.now() - 60 * 60 * 1000);
    db.eventDropAudit.groupBy.mockResolvedValue([
      { eventName: 'App Init: Theme Set', _max: { createdAt: undropAt } },
    ]);
    mocks.chQuery.mockImplementation(async ({ query }: { query: string }) => {
      if (query.includes('event_name_daily')) {
        throw new Error('Code: 60. DB::Exception: Table openpanel.event_name_daily does not exist. (UNKNOWN_TABLE)');
      }
      return chResult([
        { name: 'Home Page: Shown' },
        { name: 'session_start' },
        { name: 'App Init: Theme Set' },
        { name: '*' },
      ]);
    });
    const result = await listManagedEvents({ projectId: 'regain-app' });
    expect(result.volumeAvailable).toBe(false);
    const byName = (name: string) => result.events.find((e) => e.name === name);
    expect(byName('Home Page: Shown')?.dropBlocked).toMatchObject({ reason: 'replay', until: null });
    expect(byName('App Init: Theme Set')?.dropBlocked).toMatchObject({
      reason: 'cooldown',
      until: new Date(undropAt.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    });
    expect(byName('session_start')?.dropBlocked).toBeNull();
    expect(db.eventDropAudit.groupBy.mock.calls[0]![0].where).toMatchObject({
      projectId: 'regain-app',
      action: { in: ['undrop', 'undrop_replay'] },
    });
    expect(result.events.map((e) => [e.name, e.status, e.volume1d])).toEqual(
      expect.arrayContaining([
        ['Home Page: Shown', 'active', null],
        ['session_start', 'protected', null],
        ['Old Thing', 'dropped', null],
      ])
    );
    expect(result.events.find((e) => e.name === 'Old Thing')?.recoverableUntil).toBe(
      '2026-11-24T10:00:00.000Z'
    );
    expect(result.counts).toMatchObject({ all: 3, used: 1, unused: 0, dropped: 1, protected: 1 });
  });

  it('computes % of project and the "Not used + high volume" filter', async () => {
    mocks.chQuery.mockImplementation(async ({ query }: { query: string }) => {
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
      extra: 'recoverable until 2026-11-24 12:15 UTC',
    });
    expect(text).toContain('*Dropped* `App Init: Logback Only` in Regain Android');
    expect(text).toContain('Reason: Not used &lt;anywhere&gt;');
    expect(text).toContain('Via: Agent (asked by Chitroopa, <https://maker.example.com/maker/abc|chat>)');
    expect(text).toContain('Boards: <https://op/x|C64 Launch Board>');
    expect(text).toContain('recoverable until');
  });
});
