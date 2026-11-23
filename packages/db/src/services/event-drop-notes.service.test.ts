import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  db: {
    eventMeta: { findMany: vi.fn() },
    eventDropAudit: { findMany: vi.fn() },
    report: { findMany: vi.fn() },
    customEvent: { findMany: vi.fn() },
    customCohort: { findMany: vi.fn() },
  },
  getChartStartEndDate: vi.fn(),
}));

vi.mock('../prisma-client', () => ({ db: mocks.db }));
vi.mock('./chart.service', () => ({ getChartStartEndDate: mocks.getChartStartEndDate }));
vi.mock('./organization.service', () => ({
  getSettingsForProject: async () => ({ timezone: 'Asia/Kolkata' }),
}));

import { getDropNotes, labelNote } from './event-drop-notes.service';

const { db } = mocks;
const report = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  events: [{ id: 'A', type: 'event', name, segment: 'event', filters: [] }],
  options: null,
  cohortFilters: null,
  cohortBreakdown: null,
  range: '30d',
  dateConfig: null,
  ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  db.eventMeta.findMany.mockResolvedValue([
    { name: 'Stamp Book: Card Shown', droppedAt: new Date('2026-11-23T03:40:00Z') },
  ]);
  db.eventDropAudit.findMany.mockResolvedValue([]);
  db.report.findMany.mockResolvedValue([
    report('r1', 'Stamp Book: Card Shown'),
    report('r2', 'Stamp Book: Opened'),
  ]);
  db.customEvent.findMany.mockResolvedValue([]);
  db.customCohort.findMany.mockResolvedValue([]);
  // Last 72 h in IST, as getChartStartEndDate formats it.
  mocks.getChartStartEndDate.mockReturnValue({
    startDate: '2026-11-21 00:00:00',
    endDate: '2026-11-23 23:59:59',
  });
});

describe('labelNote', () => {
  it('writes times in the project timezone, with the year only when it is not this year', () => {
    const thisYear = new Date().getUTCFullYear();
    const note = labelNote(
      { eventName: 'A', from: `${thisYear}-03-01T20:00:00.000Z`, to: `${thisYear}-03-02T04:30:00.000Z` },
      'Asia/Kolkata'
    );
    expect(note).toMatchObject({
      fromDay: '2 Mar',
      fromDayTime: '2 Mar, 01:30',
      fromTime: '01:30',
      toDayTime: '2 Mar, 10:00',
      toTime: '10:00',
    });
    expect(labelNote({ eventName: 'A', from: '2020-01-05T00:00:00.000Z', to: null }, 'UTC').fromDay).toBe('5 Jan 2020');
  });
});

describe('getDropNotes', () => {
  it('returns notes for the board in one batch, keyed by report', async () => {
    const notes = await getDropNotes({ projectId: 'regain-app', dashboardId: 'd1', range: '3d' as never });
    expect(Object.keys(notes)).toEqual(['r1']);
    expect(notes.r1?.[0]).toMatchObject({ eventName: 'Stamp Book: Card Shown', to: null });
    // 03:40 UTC is 09:10 in the project's timezone (Asia/Kolkata).
    expect(notes.r1?.[0]?.fromTime).toBe('09:10');
    expect(notes.r1?.[0]?.fromDay).toMatch(/^23 Nov/);
    // One query per table for the whole board, not one per chart.
    expect(db.report.findMany).toHaveBeenCalledOnce();
    expect(db.report.findMany.mock.calls[0]![0].where).toEqual({ projectId: 'regain-app', dashboardId: 'd1' });
    expect(db.eventMeta.findMany).toHaveBeenCalledOnce();
    expect(db.eventDropAudit.findMany).toHaveBeenCalledOnce();
  });

  it('applies the board override range, else the report range', async () => {
    await getDropNotes({ projectId: 'regain-app', dashboardId: 'd1', range: '7d' as never });
    expect(mocks.getChartStartEndDate.mock.calls[0]![0]).toMatchObject({ range: '7d' });
    mocks.getChartStartEndDate.mockClear();
    await getDropNotes({ projectId: 'regain-app', dashboardId: 'd1', range: null });
    expect(mocks.getChartStartEndDate.mock.calls[0]![0]).toMatchObject({ range: '30d' });
  });

  it('leaves out a past drop gap outside the chart range, keeps one inside', async () => {
    db.eventMeta.findMany.mockResolvedValue([]);
    db.eventDropAudit.findMany.mockResolvedValue([
      { eventName: 'Stamp Book: Card Shown', action: 'drop', createdAt: new Date('2026-10-01T00:00:00Z') },
      { eventName: 'Stamp Book: Card Shown', action: 'undrop', createdAt: new Date('2026-10-02T00:00:00Z') },
    ]);
    expect(await getDropNotes({ projectId: 'regain-app', dashboardId: 'd1' })).toEqual({});
    mocks.getChartStartEndDate.mockReturnValue({
      startDate: '2026-09-25 00:00:00',
      endDate: '2026-10-05 23:59:59',
    });
    const notes = await getDropNotes({ projectId: 'regain-app', dashboardId: 'd1' });
    expect(notes.r1?.[0]).toMatchObject({ to: '2026-10-02T00:00:00.000Z' });
    // No date cutoff on the audit history.
    expect(db.eventDropAudit.findMany.mock.calls[0]![0].where).toEqual({ projectId: 'regain-app' });
  });

  it("uses the editor's unsaved series instead of the saved report", async () => {
    const notes = await getDropNotes({
      projectId: 'regain-app',
      draft: {
        events: [{ id: 'A', type: 'event', name: 'Stamp Book: Card Shown', segment: 'event', filters: [] }],
      },
      range: '7d' as never,
    });
    expect(Object.keys(notes)).toEqual(['draft']);
    expect(db.report.findMany).not.toHaveBeenCalled();
    const saved = await getDropNotes({
      projectId: 'regain-app',
      reportId: '3f2b6a1e-0000-4000-8000-000000000001',
      draft: { events: [{ id: 'A', type: 'event', name: 'Home Page: Shown', segment: 'event', filters: [] }] },
    });
    expect(saved).toEqual({});
  });

  it('skips the report queries when nothing was ever dropped', async () => {
    db.eventMeta.findMany.mockResolvedValue([]);
    expect(await getDropNotes({ projectId: 'regain-app', dashboardId: 'd1' })).toEqual({});
    expect(db.report.findMany).not.toHaveBeenCalled();
  });

  it('loads one report on the report page and nothing without a board or report', async () => {
    await getDropNotes({ projectId: 'regain-app', reportId: '3f2b6a1e-0000-4000-8000-000000000001' });
    expect(db.report.findMany.mock.calls[0]![0].where).toEqual({
      projectId: 'regain-app',
      id: '3f2b6a1e-0000-4000-8000-000000000001',
    });
    db.report.findMany.mockClear();
    expect(await getDropNotes({ projectId: 'regain-app' })).toEqual({});
    expect(db.report.findMany).not.toHaveBeenCalled();
  });

  it('finds the event behind a custom event', async () => {
    db.customEvent.findMany.mockResolvedValue([
      { id: 'ce1', components: [{ eventName: 'Stamp Book: Card Shown', filters: [] }] },
    ]);
    db.report.findMany.mockResolvedValue([
      report('r3', '', {
        events: [{ id: 'A', type: 'custom_event', customEventId: 'ce1', segment: 'event', filters: [] }],
      }),
    ]);
    expect(Object.keys(await getDropNotes({ projectId: 'regain-app', dashboardId: 'd1' }))).toEqual(['r3']);
  });
});
