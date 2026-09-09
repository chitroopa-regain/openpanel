import { addDays, format, subDays } from 'date-fns';
import { describe, expect, it } from 'vitest';
import { freshnessForSpanDays, getReportFreshness } from './cache-freshness';

const path = { path: 'chart.funnel' };
const day = (d: Date) => format(d, 'yyyy-MM-dd HH:mm:ss');

describe('getReportFreshness', () => {
  it('keeps live widgets uncached', () => {
    expect(getReportFreshness({ range: 'today' }, { path: 'overview.liveData' })).toBe(0);
  });

  it('keeps intraday ranges on the short live debounce', () => {
    expect(getReportFreshness({ range: 'today' }, path)).toBe(30);
    expect(getReportFreshness({ range: 'lastHour' }, path)).toBe(30);
    expect(getReportFreshness({ range: '30min' }, path)).toBe(30);
  });

  it('scales the window with how much history a live preset covers', () => {
    expect(getReportFreshness({ range: '7d' }, path)).toBe(60 * 5);
    expect(getReportFreshness({ range: '30d' }, path)).toBe(60 * 15);
    expect(getReportFreshness({ range: 'monthToDate' }, path)).toBe(60 * 15);
    expect(getReportFreshness({ range: '3m' }, path)).toBe(60 * 60);
    expect(getReportFreshness({ range: '12m' }, path)).toBe(60 * 60);
  });

  it('treats closed periods as stable for a day', () => {
    expect(getReportFreshness({ range: 'yesterday' }, path)).toBe(60 * 60 * 24);
    expect(getReportFreshness({ range: 'lastMonth' }, path)).toBe(60 * 60 * 24);
    const end = subDays(new Date(), 3);
    expect(
      getReportFreshness(
        { range: 'custom', startDate: day(subDays(end, 30)), endDate: day(end) },
        path,
      ),
    ).toBe(60 * 60 * 24);
  });

  it('scales a custom range that reaches into today by its span', () => {
    const tomorrow = addDays(new Date(), 1);
    expect(
      getReportFreshness(
        { range: 'custom', startDate: day(subDays(tomorrow, 2)), endDate: day(tomorrow) },
        path,
      ),
    ).toBe(60 * 5);
    expect(
      getReportFreshness(
        { range: 'custom', startDate: day(subDays(tomorrow, 31)), endDate: day(tomorrow) },
        path,
      ),
    ).toBe(60 * 15);
    expect(
      getReportFreshness(
        { range: 'custom', startDate: day(subDays(tomorrow, 200)), endDate: day(tomorrow) },
        path,
      ),
    ).toBe(60 * 60);
  });

  it('falls back to the live debounce for unknown ranges', () => {
    expect(getReportFreshness({ range: 'someNewPreset' }, path)).toBe(30);
    expect(getReportFreshness(undefined, path)).toBe(30);
  });

  it('buckets spans monotonically', () => {
    const spans = [0, 1, 2, 7, 8, 45, 46, 400].map(freshnessForSpanDays);
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i]!).toBeGreaterThanOrEqual(spans[i - 1]!);
    }
  });
});
