import { describe, expect, it } from 'vitest';
import { buildDropPeriods, dropNotesForReport } from './event-drop-notes';

const d = (iso: string) => new Date(iso);

describe('buildDropPeriods', () => {
  it('pairs drop → undrop from the audit log and adds the current drop from event_meta', () => {
    const periods = buildDropPeriods(
      [{ name: 'Stamp Book: Card Shown', droppedAt: d('2026-11-23T03:40:00Z') }],
      [
        // out of order on purpose
        { eventName: 'Auth Interceptor: Request Failed', action: 'undrop', createdAt: d('2026-11-22T12:35:00Z') },
        { eventName: 'Auth Interceptor: Request Failed', action: 'drop', createdAt: d('2026-11-22T11:50:00Z') },
        { eventName: 'Stamp Book: Card Shown', action: 'drop_anyway', createdAt: d('2026-11-23T03:40:00Z') },
      ]
    );
    expect(periods.get('Auth Interceptor: Request Failed')).toEqual([
      {
        eventName: 'Auth Interceptor: Request Failed',
        from: d('2026-11-22T11:50:00Z'),
        to: d('2026-11-22T12:35:00Z'),
      },
    ]);
    // The open audit drop is not doubled: event_meta is the current period.
    expect(periods.get('Stamp Book: Card Shown')).toEqual([
      { eventName: 'Stamp Book: Card Shown', from: d('2026-11-23T03:40:00Z'), to: null },
    ]);
  });

  it('keeps several past periods and ignores an undrop with no drop', () => {
    const periods = buildDropPeriods([], [
      { eventName: 'A', action: 'undrop', createdAt: d('2026-10-01T00:00:00Z') },
      { eventName: 'A', action: 'drop', createdAt: d('2026-10-02T00:00:00Z') },
      { eventName: 'A', action: 'undrop', createdAt: d('2026-10-03T00:00:00Z') },
      { eventName: 'A', action: 'drop', createdAt: d('2026-10-10T00:00:00Z') },
      { eventName: 'A', action: 'undrop', createdAt: d('2026-10-10T06:00:00Z') },
    ]);
    expect(periods.get('A')).toEqual([
      { eventName: 'A', from: d('2026-10-02T00:00:00Z'), to: d('2026-10-03T00:00:00Z') },
      { eventName: 'A', from: d('2026-10-10T00:00:00Z'), to: d('2026-10-10T06:00:00Z') },
    ]);
  });

  it('a drop made before the audit log existed still shows (event_meta only)', () => {
    const periods = buildDropPeriods([{ name: 'Legacy', droppedAt: d('2026-04-08T12:00:00Z') }], []);
    expect(periods.get('Legacy')?.[0]).toMatchObject({ to: null });
  });
});

describe('dropNotesForReport', () => {
  const periods = buildDropPeriods(
    [{ name: 'Stamp Book: Card Shown', droppedAt: d('2026-11-23T03:40:00Z') }],
    [
      { eventName: 'Old', action: 'drop', createdAt: d('2026-09-01T00:00:00Z') },
      { eventName: 'Old', action: 'undrop', createdAt: d('2026-09-02T00:00:00Z') },
    ]
  );
  const last72h = { start: d('2026-11-20T18:30:00Z'), end: d('2026-11-23T18:29:59Z') };

  it('notes a current drop inside the chart range', () => {
    expect(dropNotesForReport(['Stamp Book: Card Shown', 'Stamp Book: Opened'], periods, last72h)).toEqual([
      { eventName: 'Stamp Book: Card Shown', from: '2026-11-23T03:40:00.000Z', to: null },
    ]);
  });

  it('notes a current drop that started before the range (the whole range has no data)', () => {
    const later = { start: d('2026-12-01T00:00:00Z'), end: d('2026-12-07T00:00:00Z') };
    expect(dropNotesForReport(['Stamp Book: Card Shown'], periods, later)).toHaveLength(1);
  });

  it('notes a current drop even when the chart range ends before it (the event is dropped now)', () => {
    const before = { start: d('2026-11-01T00:00:00Z'), end: d('2026-11-07T00:00:00Z') };
    expect(dropNotesForReport(['Stamp Book: Card Shown'], periods, before)).toHaveLength(1);
  });

  it('includes a past drop window only when it overlaps the range', () => {
    expect(dropNotesForReport(['Old'], periods, last72h)).toEqual([]);
    const sept = { start: d('2026-08-25T00:00:00Z'), end: d('2026-09-30T00:00:00Z') };
    expect(dropNotesForReport(['Old'], periods, sept)).toEqual([
      { eventName: 'Old', from: '2026-09-01T00:00:00.000Z', to: '2026-09-02T00:00:00.000Z' },
    ]);
  });

  it('charts without dropped events get no note', () => {
    expect(dropNotesForReport(['Home Page: Shown'], periods, last72h)).toEqual([]);
  });
});
