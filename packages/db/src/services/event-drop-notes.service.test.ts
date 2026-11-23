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

import { getDropNotes } from './event-drop-notes.service';

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

describe('getDropNotes', () => {
  it('returns notes for the board in one batch, keyed by report', async () => {
    const notes = await getDropNotes({ projectId: 'regain-app', dashboardId: 'd1', range: '3d' as never });
    expect(Object.keys(notes)).toEqual(['r1']);
    expect(notes.r1?.[0]).toMatchObject({ eventName: 'Stamp Book: Card Shown', to: null });
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

  it('leaves out a drop that starts after the chart range', async () => {
    mocks.getChartStartEndDate.mockReturnValue({
      startDate: '2026-11-01 00:00:00',
      endDate: '2026-11-07 23:59:59',
    });
    expect(await getDropNotes({ projectId: 'regain-app', dashboardId: 'd1' })).toEqual({});
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
