import { describe, expect, it } from 'vitest';
import { reportSlice } from './reportSlice';

const { addBreakdown, changeChartType, changeCohortBreakdown, setReport } =
  reportSlice.actions;
const initial = reportSlice.getInitialState();

describe('cohort breakdown / property breakdown are mutually exclusive', () => {
  it('selecting cohorts clears any property breakdown', () => {
    // The server REJECTS the combination, so the UI must not let a user build a
    // report that can only fail when it runs.
    const withProperty = reportSlice.reducer(
      initial,
      addBreakdown({ name: 'country' }),
    );
    expect(withProperty.breakdowns).toHaveLength(1);

    const withCohorts = reportSlice.reducer(
      withProperty,
      changeCohortBreakdown(['cohort-a', 'cohort-b']),
    );
    expect(withCohorts.cohortBreakdown?.cohortIds).toEqual([
      'cohort-a',
      'cohort-b',
    ]);
    expect(withCohorts.breakdowns).toHaveLength(0);
  });

  it('adding a property breakdown clears the cohort breakdown', () => {
    const withCohorts = reportSlice.reducer(
      initial,
      changeCohortBreakdown(['cohort-a']),
    );
    expect(withCohorts.cohortBreakdown).toBeDefined();

    const withProperty = reportSlice.reducer(
      withCohorts,
      addBreakdown({ name: 'country' }),
    );
    expect(withProperty.cohortBreakdown).toBeUndefined();
    expect(withProperty.breakdowns).toHaveLength(1);
  });

  it('clearing the last cohort removes the breakdown entirely', () => {
    const withCohorts = reportSlice.reducer(
      initial,
      changeCohortBreakdown(['cohort-a']),
    );
    const cleared = reportSlice.reducer(withCohorts, changeCohortBreakdown([]));
    expect(cleared.cohortBreakdown).toBeUndefined();
  });

  it('preserves selection order — it becomes series order', () => {
    const s = reportSlice.reducer(initial, changeCohortBreakdown(['b', 'a', 'c']));
    expect(s.cohortBreakdown?.cohortIds).toEqual(['b', 'a', 'c']);
  });
});

describe('cohort breakdown is dropped on chart types that ignore it', () => {
  const withCohorts = () =>
    reportSlice.reducer(initial, changeCohortBreakdown(['cohort-a']));

  it.each(['sankey', 'conversion'])(
    'clears the cohort breakdown when switching to %s',
    (type) => {
      // Those query paths ignore the field, so leaving it set would render an
      // unsplit chart that still claims a breakdown.
      const s = reportSlice.reducer(withCohorts(), changeChartType(type as never));
      expect(s.cohortBreakdown).toBeUndefined();
    },
  );

  it.each([
    'linear', 'bar', 'area', 'pie', 'metric', 'table', 'histogram',
    // funnel and retention run the per-bucket loop now, so the breakdown is
    // meaningful on them and must survive the switch.
    'funnel', 'funnel_metric', 'retention',
  ])(
    'keeps the cohort breakdown when switching to %s',
    (type) => {
      const s = reportSlice.reducer(withCohorts(), changeChartType(type as never));
      expect(s.cohortBreakdown?.cohortIds).toEqual(['cohort-a']);
    },
  );
});

describe('hydration drops a cohort breakdown the chart type cannot apply', () => {
  const report = (chartType: string) =>
    ({
      projectId: 'p', name: 'r', chartType, lineType: 'monotone', interval: 'day',
      breakdowns: [], series: [], range: '30d', previous: false, metric: 'sum',
      cohortBreakdown: { cohortIds: ['cohort-a'] },
    }) as never;

  it('strips it when loading a saved sankey report', () => {
    // Reports saved before this rule existed — or created straight through the
    // API — can arrive in this state; the sankey path would ignore the field
    // and render an unsplit series without complaint.
    const s = reportSlice.reducer(initial, setReport(report('sankey')));
    expect(s.cohortBreakdown).toBeUndefined();
  });

  it('keeps it when loading a saved funnel report', () => {
    const s = reportSlice.reducer(initial, setReport(report('funnel')));
    expect(s.cohortBreakdown?.cohortIds).toEqual(['cohort-a']);
  });

  it('keeps it when loading a saved linear report', () => {
    const s = reportSlice.reducer(initial, setReport(report('linear')));
    expect(s.cohortBreakdown?.cohortIds).toEqual(['cohort-a']);
  });
});
