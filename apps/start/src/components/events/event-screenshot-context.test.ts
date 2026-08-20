import { describe, expect, it } from 'vitest';
import {
  buildBreakdownScreenshotContextBatches,
  buildBreakdownScreenshotTargets,
  buildEventDetailScreenshotContext,
  buildEventTableScreenshotContextBatches,
  buildFunnelBreakdownScreenshotTargets,
  buildScreenshotContexts,
  eventScreenshotsForContext,
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

describe('breakdown table screenshot matching', () => {
  const reportSeries = [
    {
      id: 'A',
      type: 'event',
      name: 'Subscription Intro BS: Shown',
      filters: [
        {
          id: 'filter-1',
          name: 'properties.variant',
          operator: 'is',
          value: ['control'],
        },
      ],
    },
  ] as never;

  it('builds an exact context for every chart breakdown row', () => {
    const targets = buildBreakdownScreenshotTargets({
      chartSeries: [
        {
          id: 'source-row',
          serieType: 'event',
          event: {
            id: 'A',
            name: 'Subscription Intro BS: Shown',
            breakdowns: {
              'properties.source': 'FT_POMODORO_SELECTION',
              'profile.properties.plan': 'pro',
            },
          },
        },
      ] as never,
      reportSeries,
      startDate: '2026-08-01T00:00:00.000Z',
      endDate: '2026-08-07T00:00:00.000Z',
    });

    expect(targets).toEqual([
      expect.objectContaining({
        serieId: 'source-row',
        eventName: 'Subscription Intro BS: Shown',
        context: expect.objectContaining({
          eventName: 'Subscription Intro BS: Shown',
          breakdown: {
            property: 'properties.source',
            scope: 'event',
            values: ['FT_POMODORO_SELECTION'],
          },
          filters: expect.arrayContaining([
            {
              property: 'properties.variant',
              scope: 'event',
              values: ['control'],
            },
            {
              property: 'profile.properties.plan',
              scope: 'user',
              values: ['pro'],
            },
          ]),
        }),
      }),
    ]);
  });

  it('does not guess when multiple report series share an event name', () => {
    const targets = buildBreakdownScreenshotTargets({
      chartSeries: [
        {
          id: 'ambiguous-row',
          serieType: 'event',
          event: {
            name: 'Subscription Intro BS: Shown',
            breakdowns: { 'properties.source': 'SOURCE_A' },
          },
        },
      ] as never,
      reportSeries: [
        {
          id: 'A',
          type: 'event',
          name: 'Subscription Intro BS: Shown',
          filters: [],
        },
        {
          id: 'B',
          type: 'event',
          name: 'Subscription Intro BS: Shown',
          filters: [],
        },
      ] as never,
    });

    expect(targets).toEqual([]);
  });

  it('builds funnel row contexts from the configured breakdown step', () => {
    const targets = buildFunnelBreakdownScreenshotTargets({
      rows: [
        { id: 'source-a', breakdowns: ['SOURCE_A'] },
        { id: 'unset', breakdowns: null },
      ],
      reportSeries: [
        { id: 'A', type: 'event', name: 'Step One', filters: [] },
        { id: 'B', type: 'event', name: 'Step Two', filters: [] },
      ] as never,
      breakdownProperties: ['properties.source'],
      breakdownStep: 1,
    });

    expect(targets).toEqual([
      expect.objectContaining({
        serieId: 'source-a',
        eventName: 'Step Two',
        context: expect.objectContaining({
          eventName: 'Step Two',
          breakdown: {
            property: 'properties.source',
            scope: 'event',
            values: ['SOURCE_A'],
          },
        }),
      }),
      expect.objectContaining({
        serieId: 'unset',
        eventName: 'Step Two',
        context: expect.objectContaining({
          breakdown: {
            property: 'properties.source',
            scope: 'event',
            values: [null],
          },
        }),
      }),
    ]);

    const unsetTarget = targets.find((target) => target.serieId === 'unset');
    const unsetCatalog = [
      {
        name: 'Step Two',
        screenshots: [
          {
            ...screenshot(200),
            captureId: 'has-source',
            eventProperties: { source: 'SOURCE_A' },
          },
          {
            ...screenshot(100),
            captureId: 'missing-source',
            eventProperties: {},
          },
        ],
      },
    ] as never;
    if (!unsetTarget) {
      throw new Error('Expected a target for the Not set breakdown row');
    }
    expect(
      eventScreenshotsForContext(unsetCatalog, unsetTarget.context)?.map(
        (item) => item.captureId
      )
    ).toEqual(['missing-source']);
  });

  it('filters a merged screenshot catalog back to the exact source row', () => {
    const [target] = buildBreakdownScreenshotTargets({
      chartSeries: [
        {
          id: 'source-row',
          serieType: 'event',
          event: {
            id: 'A',
            name: 'Subscription Intro BS: Shown',
            breakdowns: { 'properties.source': 'SOURCE_A' },
          },
        },
      ] as never,
      reportSeries,
    });
    const catalog = [
      {
        name: 'Subscription Intro BS: Shown',
        screenshots: [
          {
            ...screenshot(200),
            captureId: 'source-a',
            eventProperties: { source: 'SOURCE_A', variant: 'control' },
          },
          {
            ...screenshot(300),
            captureId: 'source-b',
            eventProperties: { source: 'SOURCE_B', variant: 'control' },
          },
        ],
      },
    ] as never;

    expect(
      eventScreenshotsForContext(catalog, target!.context)?.map(
        (item) => item.captureId
      )
    ).toEqual(['source-a']);
  });

  it('batches more than fifty source contexts without dropping rows', () => {
    const targets = Array.from({ length: 51 }, (_, index) => ({
      serieId: `row-${index}`,
      eventName: 'Event',
      context: {
        eventName: 'Event',
        filters: [],
        breakdown: {
          property: 'properties.source',
          scope: 'event' as const,
          values: [`source-${index}`],
        },
      },
    }));

    expect(
      buildBreakdownScreenshotContextBatches(targets).map(
        (batch) => batch.length
      )
    ).toEqual([50, 1]);
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
