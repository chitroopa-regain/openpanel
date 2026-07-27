import { describe, expect, it } from 'vitest';
import {
  buildEventDetailScreenshotContext,
  buildEventTableScreenshotContextBatches,
  buildScreenshotContexts,
  eventScreenshotsForUtcDay,
  mergeEventScreenshotCatalogs,
  utcDayScreenshotRange,
} from './event-screenshot-context';
import type { RouterOutputs } from '@/trpc/client';

const eventSeries = (filters: unknown[]) =>
  [
    {
      type: 'event',
      name: 'Paywall: Shown',
      filters,
    },
  ] as never;

const screenshot = (capturedAtMs?: number) => ({
  url: 'https://api.regainapp.ai/event_screenshots/capture/image?token=test',
  captureId: `capture-${capturedAtMs}`,
  capturedAtMs,
  eventProperties: {},
  userProperties: {},
});

describe('buildScreenshotContexts', () => {
  it('matches the full UTC event day when ingestion is delayed', () => {
    expect(utcDayScreenshotRange(Date.UTC(2026, 6, 26, 23, 58))).toEqual({
      startDateMs: Date.UTC(2026, 6, 26),
      endDateMs: Date.UTC(2026, 6, 26, 23, 59, 59, 999),
    });
  });

  it('does not treat enriched detail properties as report filters', () => {
    expect(
      buildEventDetailScreenshotContext(
        'BL: Block Feature Screen Shown',
        Date.UTC(2026, 6, 26, 14, 21)
      )
    ).toEqual({
      eventName: 'BL: Block Feature Screen Shown',
      filters: [],
      startDateMs: Date.UTC(2026, 6, 26),
      endDateMs: Date.UTC(2026, 6, 26, 23, 59, 59, 999),
    });
  });

  it('includes the complete final report day', () => {
    const [context] = buildScreenshotContexts({
      series: eventSeries([]),
      startDate: '2026-06-01T00:00:00.000Z',
      endDate: '2026-06-30T00:00:00.000Z',
    });

    expect(context?.startDateMs).toBe(Date.UTC(2026, 5, 1));
    expect(context?.endDateMs).toBe(Date.UTC(2026, 5, 30, 23, 59, 59, 999));
  });

  it('marks unsupported report filters as unmatchable instead of falling back', () => {
    const [context] = buildScreenshotContexts({
      series: eventSeries([
        {
          name: 'properties.variant',
          operator: 'is_not',
          value: ['control'],
        },
      ]),
    });

    expect(context).toEqual(
      expect.objectContaining({
        eventName: 'Paywall: Shown',
        filters: [],
        matchable: false,
      })
    );
  });
});

describe('event table screenshot matching', () => {
  it('deduplicates event and UTC-day contexts', () => {
    const first = new Date('2026-07-27T01:00:00.000Z');
    const second = new Date('2026-07-27T22:00:00.000Z');
    const [contexts] = buildEventTableScreenshotContextBatches([
      { name: 'Home Page: Shown', createdAt: first },
      { name: 'Home Page: Shown', createdAt: second },
      { name: 'FT: Overlay Shown', createdAt: second },
    ]);

    expect(contexts).toEqual([
      {
        eventName: 'Home Page: Shown',
        filters: [],
        ...utcDayScreenshotRange(first.getTime()),
      },
      {
        eventName: 'FT: Overlay Shown',
        filters: [],
        ...utcDayScreenshotRange(second.getTime()),
      },
    ]);
  });

  it('batches every context instead of dropping rows after the API limit', () => {
    const events = Array.from({ length: 105 }, (_, index) => ({
      name: `Event ${index}`,
      createdAt: new Date('2026-07-27T12:00:00.000Z'),
    }));

    const batches = buildEventTableScreenshotContextBatches(events);

    expect(batches.map((batch) => batch.length)).toEqual([50, 50, 5]);
    expect(batches.flat()).toHaveLength(105);
    expect(batches[2]?.[4]?.eventName).toBe('Event 104');
  });

  it('merges screenshots for the same event across context batches', () => {
    const first = screenshot(Date.UTC(2026, 6, 26, 12));
    const second = screenshot(Date.UTC(2026, 6, 27, 12));
    const catalogs = [
      [{ name: 'Home Page: Shown', screenshots: [first] }],
      [{ name: 'Home Page: Shown', screenshots: [second, first] }],
    ] as unknown as RouterOutputs['chart']['events'][];

    const merged = mergeEventScreenshotCatalogs(catalogs);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.screenshots).toEqual([second, first]);
  });

  it('returns only screenshots for the exact event name and UTC day', () => {
    const occurrence = new Date('2026-07-27T21:50:00.000Z');
    const sameDay = screenshot(new Date('2026-07-27T16:08:20.000Z').getTime());
    const previousDay = screenshot(
      new Date('2026-07-26T23:59:59.999Z').getTime()
    );
    const catalog = [
      {
        name: 'Home Page: Shown',
        screenshots: [sameDay, previousDay, screenshot(undefined)],
      },
      { name: 'Other Event', screenshots: [sameDay] },
    ] as unknown as RouterOutputs['chart']['events'];

    expect(
      eventScreenshotsForUtcDay(
        catalog,
        'Home Page: Shown',
        occurrence.getTime()
      )
    ).toEqual([sameDay]);
    expect(
      eventScreenshotsForUtcDay(catalog, 'Missing Event', occurrence.getTime())
    ).toBeUndefined();
  });
});
