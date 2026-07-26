import { describe, expect, it } from 'vitest';
import {
  buildScreenshotContexts,
  utcDayScreenshotRange,
} from './event-screenshot-context';

const eventSeries = (filters: unknown[]) =>
  [
    {
      type: 'event',
      name: 'Paywall: Shown',
      filters,
    },
  ] as never;

describe('buildScreenshotContexts', () => {
  it('matches the full UTC event day when ingestion is delayed', () => {
    expect(utcDayScreenshotRange(Date.UTC(2026, 6, 26, 23, 58))).toEqual({
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
