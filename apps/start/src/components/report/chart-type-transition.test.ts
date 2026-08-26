import { describe, expect, it } from 'vitest';
import { reportSlice } from './reportSlice';

const { changeChartType, setReport } = reportSlice.actions;
const initial = reportSlice.getInitialState();

const ev = (name: string, extra: Record<string, unknown> = {}) => ({
  id: name,
  type: 'event' as const,
  name,
  segment: 'event' as const,
  filters: [],
  ...extra,
});

function withSeries(series: unknown[], chartType = 'linear') {
  return reportSlice.reducer(
    initial,
    setReport({ ...initial, chartType, series } as any),
  );
}

describe('funnel <-> retention keeps the selected events', () => {
  it('entering retention moves the event into the reserved name filter', () => {
    // The reported bug: both slots read "Select event" because retention looks
    // in filters, not in `name`.
    let s = withSeries([ev('Application Installed'), ev('Server: Purchase')], 'funnel');
    s = reportSlice.reducer(s, changeChartType('retention'));

    const [a, b] = s.series as any[];
    expect(a.name).toBe('*');
    expect(a.filters).toEqual([
      { name: 'name', operator: 'is', value: ['Application Installed'] },
    ]);
    expect(b.filters[0].value).toEqual(['Server: Purchase']);
  });

  it('leaving retention moves it back into name, not the wildcard', () => {
    let s = withSeries([ev('Application Installed'), ev('Server: Purchase')], 'funnel');
    s = reportSlice.reducer(s, changeChartType('retention'));
    s = reportSlice.reducer(s, changeChartType('linear'));

    const [a, b] = s.series as any[];
    expect(a.name).toBe('Application Installed');
    expect(b.name).toBe('Server: Purchase');
    // The reserved filter must not linger as an ordinary one.
    expect(a.filters).toEqual([]);
  });

  it("preserves the user's own filters across a round trip", () => {
    const withFilter = ev('Application Installed', {
      filters: [{ name: 'country', operator: 'is', value: ['IN'] }],
      firstTimeFilter: true,
    });
    let s = withSeries([withFilter, ev('Server: Purchase')], 'funnel');
    s = reportSlice.reducer(s, changeChartType('retention'));

    const inRetention = (s.series as any[])[0];
    expect(inRetention.filters).toEqual([
      { name: 'name', operator: 'is', value: ['Application Installed'] },
      { name: 'country', operator: 'is', value: ['IN'] },
    ]);

    s = reportSlice.reducer(s, changeChartType('linear'));
    const back = (s.series as any[])[0];
    expect(back.name).toBe('Application Installed');
    expect(back.filters).toEqual([
      { name: 'country', operator: 'is', value: ['IN'] },
    ]);
    expect(back.firstTimeFilter).toBe(true);
  });

  it('a genuine wildcard stays unset rather than becoming the event "*"', () => {
    let s = withSeries([{ ...ev('*'), name: '*' }], 'retention');
    s = reportSlice.reducer(s, changeChartType('linear'));
    expect((s.series as any[])[0].name).not.toBe('*');
  });
});

describe('truncation matches Mixpanel: keep the first two, permanently', () => {
  it('drops metric C on entering retention and does NOT restore it', () => {
    let s = withSeries([ev('A'), ev('B'), ev('C')], 'linear');
    s = reportSlice.reducer(s, changeChartType('retention'));
    expect(s.series).toHaveLength(2);
    // The reason must be the CAP, not "cannot use" — retention supports all
    // three of these kinds; there is simply no room for the third.
    expect(s.lastTransitionNotice).toMatch(/uses 2 metrics, so 1 more was removed/);
    expect(s.lastTransitionNotice).not.toMatch(/cannot use/);

    // Mixpanel does not bring C back, and neither do we.
    s = reportSlice.reducer(s, changeChartType('linear'));
    expect(s.series).toHaveLength(2);
    expect((s.series as any[]).map((x) => x.name)).toEqual(['A', 'B']);
  });

  it('removes formulas, which none of these chart types can evaluate', () => {
    let s = withSeries(
      [ev('A'), { id: 'F', type: 'formula', formula: 'A/B' }, ev('B')],
      'linear',
    );
    s = reportSlice.reducer(s, changeChartType('retention'));
    expect((s.series as any[]).some((x) => x.type === 'formula')).toBe(false);
    expect(s.lastTransitionNotice).toMatch(/formula, which retention cannot use/);
  });

  it('🔴 sankey keeps the USABLE series, not the raw first one', () => {
    // The execution bug: sankey's server strips custom events via
    // onlyReportEvents, so keeping [0] raw would retain the custom event and
    // fail with "Start and end events are required".
    let s = withSeries(
      [{ id: 'CE', type: 'custom_event', customEventId: 'ce-1', filters: [] }, ev('B')],
      'linear',
    );
    s = reportSlice.reducer(s, changeChartType('sankey'));
    expect(s.series).toHaveLength(1);
    expect((s.series as any[])[0].type).toBe('event');
    expect((s.series as any[])[0].name).toBe('B');
  });

  it('retention keeps custom events — the onlyReportEvents comment is stale', () => {
    let s = withSeries(
      [{ id: 'CE', type: 'custom_event', customEventId: 'ce-1', filters: [] }, ev('B')],
      'linear',
    );
    s = reportSlice.reducer(s, changeChartType('retention'));
    expect(s.series).toHaveLength(2);
    expect((s.series as any[])[0].type).toBe('custom_event');
  });
});

describe('multi-event slot leaving retention', () => {
  it('keeps the first and reports what it dropped', () => {
    // Silently keeping value[0] changes the NUMBER while the report looks
    // identical — on real data 672 -> 602 returning users. Say so.
    let s = withSeries(
      [
        {
          ...ev('*'),
          name: '*',
          filters: [
            { name: 'name', operator: 'is', value: ['FT: Session Completed', 'FT: Bubble Enabled'] },
          ],
        },
      ],
      'retention',
    );
    s = reportSlice.reducer(s, changeChartType('linear'));
    expect((s.series as any[])[0].name).toBe('FT: Session Completed');
    expect(s.lastTransitionNotice).toMatch(/FT: Bubble Enabled/);
  });
});

describe('cohort filters are cleared on every rejecting target', () => {
  it.each(['funnel', 'funnel_metric', 'retention', 'sankey', 'conversion'])(
    'clears on %s',
    (target) => {
      let s = withSeries(
        [ev('A', { cohortFilter: { operator: 'in', cohortIds: ['c1'] } })],
        'linear',
      );
      s = reportSlice.reducer(
        { ...s, cohortFilter: { operator: 'in', cohortIds: ['c1'] } } as any,
        changeChartType(target as any),
      );
      expect(s.cohortFilter).toBeUndefined();
      for (const serie of s.series as any[]) {
        expect(serie.cohortFilter).toBeUndefined();
      }
    },
  );

  it('preserves them on a supported target', () => {
    let s = withSeries(
      [ev('A', { cohortFilter: { operator: 'in', cohortIds: ['c1'] } })],
      'linear',
    );
    s = reportSlice.reducer(s, changeChartType('bar'));
    expect((s.series as any[])[0].cohortFilter).toEqual({
      operator: 'in',
      cohortIds: ['c1'],
    });
  });
});

describe('the notice states the real reason', () => {
  it('separates "cannot use" from "no room for"', () => {
    // A formula (unsupported kind) AND a fourth metric (over the cap) together.
    let s = withSeries(
      [ev('A'), { id: 'F', type: 'formula', formula: 'A/B' }, ev('B'), ev('C')],
      'linear',
    );
    s = reportSlice.reducer(s, changeChartType('retention'));
    expect(s.lastTransitionNotice).toMatch(/formula, which retention cannot use/);
    expect(s.lastTransitionNotice).toMatch(/so 1 more was removed/);
    expect(s.series).toHaveLength(2);
  });
});

describe('funnel and funnel_metric', () => {
  it.each(['funnel', 'funnel_metric'])(
    '%s keeps every step — funnels have no cap',
    (target) => {
      let s = withSeries([ev('A'), ev('B'), ev('C'), ev('D')], 'linear');
      s = reportSlice.reducer(s, changeChartType(target as any));
      expect(s.series).toHaveLength(4);
      expect(s.lastTransitionNotice).toBeUndefined();
    },
  );

  it.each(['funnel', 'funnel_metric'])(
    '%s removes formulas, which resolveSeriesForFunnel silently skips',
    (target) => {
      // No else branch in resolveSeriesForFunnel: a formula would sit in the
      // editor while the server ignored it.
      let s = withSeries(
        [ev('A'), { id: 'F', type: 'formula', formula: 'A/B' }, ev('B')],
        'linear',
      );
      s = reportSlice.reducer(s, changeChartType(target as any));
      expect((s.series as any[]).some((x) => x.type === 'formula')).toBe(false);
      expect(s.lastTransitionNotice).toMatch(
        new RegExp(`formula, which ${target} cannot use`),
      );
    },
  );

  it('funnel keeps custom events', () => {
    let s = withSeries(
      [{ id: 'CE', type: 'custom_event', customEventId: 'ce-1', filters: [] }, ev('B')],
      'linear',
    );
    s = reportSlice.reducer(s, changeChartType('funnel'));
    expect(s.series).toHaveLength(2);
  });
});
