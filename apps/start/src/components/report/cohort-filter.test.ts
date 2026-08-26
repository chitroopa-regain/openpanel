import { describe, expect, it } from 'vitest';
import { reportSlice } from './reportSlice';

const { addSerie, changeChartType, changeCohortFilters, changeCohortBreakdown, setReport } =
  reportSlice.actions;
const initial = reportSlice.getInitialState();

function withOneEvent() {
  return reportSlice.reducer(
    initial,
    addSerie({
      type: 'event',
      name: 'FT: Overlay Shown',
      segment: 'event',
      filters: [],
    } as any),
  );
}

describe('report-level cohort filter rows', () => {
  it('stores rows in order and clears on empty', () => {
    let state = reportSlice.reducer(
      withOneEvent(),
      changeCohortFilters([
        { operator: 'in', cohortIds: ['a', 'b'] },
        { operator: 'not_in', cohortIds: ['c'] },
      ]),
    );

    expect(state.cohortFilters).toEqual([
      { operator: 'in', cohortIds: ['a', 'b'] },
      { operator: 'not_in', cohortIds: ['c'] },
    ]);
    expect(state.dirty).toBe(true);

    state = reportSlice.reducer(state, changeCohortFilters([]));
    // Normalised to undefined rather than an empty array: a stored `[]` would
    // read as "a filter exists" everywhere downstream.
    expect(state.cohortFilters).toBeUndefined();
  });

  it('does not touch the series — a cohort filter is report-level only', () => {
    const state = reportSlice.reducer(
      withOneEvent(),
      changeCohortFilters([{ operator: 'in', cohortIds: ['a'] }]),
    );
    expect((state.series[0] as any).cohortFilter).toBeUndefined();
    expect((state.series[0] as { name?: string }).name).toBe('FT: Overlay Shown');
  });
});

describe('chart types that DO apply the filter keep it', () => {
  // The regression this pins: funnel and retention apply the cohort filter in
  // their query paths, so stripping it on switch (as the old shared list did)
  // would silently widen the report.
  it.each(['funnel', 'funnel_metric', 'retention'] as const)(
    'keeps the filter when switching to %s',
    (chartType) => {
      let state = reportSlice.reducer(
        withOneEvent(),
        changeCohortFilters([{ operator: 'in', cohortIds: ['a'] }]),
      );
      state = reportSlice.reducer(state, changeChartType(chartType));
      expect(state.cohortFilters).toEqual([
        { operator: 'in', cohortIds: ['a'] },
      ]);
    },
  );

  it.each(['funnel', 'funnel_metric', 'retention'] as const)(
    'keeps the cohort BREAKDOWN on %s too',
    (chartType) => {
      let state = reportSlice.reducer(withOneEvent(), changeCohortBreakdown(['a']));
      state = reportSlice.reducer(state, changeChartType(chartType));
      // These paths now run the per-bucket loop, so the breakdown means
      // something on them and must survive the switch.
      expect(state.cohortBreakdown).toEqual({ cohortIds: ['a'] });
    },
  );

  it.each(['sankey', 'conversion'] as const)(
    'still drops the cohort BREAKDOWN on %s',
    (chartType) => {
      let state = reportSlice.reducer(withOneEvent(), changeCohortBreakdown(['a']));
      state = reportSlice.reducer(state, changeChartType(chartType));
      // No bucket loop on these paths: keeping it would render one unsplit
      // series while claiming a split.
      expect(state.cohortBreakdown).toBeUndefined();
    },
  );
});

describe('chart types that ignore the filter strip it', () => {
  it.each(['sankey', 'conversion'] as const)(
    'clears the filter when switching to %s',
    (chartType) => {
      let state = reportSlice.reducer(
        withOneEvent(),
        changeCohortFilters([{ operator: 'in', cohortIds: ['a'] }]),
      );
      state = reportSlice.reducer(state, changeChartType(chartType));
      // Worse than rendering unfiltered: the query guard REJECTS a filter these
      // paths cannot apply, so leaving it set breaks the report outright.
      expect(state.cohortFilters).toBeUndefined();
    },
  );

  it('strips it on hydration too, not only on a switch', () => {
    const state = reportSlice.reducer(
      initial,
      setReport({
        ...initial,
        chartType: 'sankey',
        cohortFilters: [{ operator: 'in', cohortIds: ['a'] }],
      } as any),
    );
    expect(state.cohortFilters).toBeUndefined();
  });

  it('hydrates a filter untouched on a supporting chart type', () => {
    const state = reportSlice.reducer(
      initial,
      setReport({
        ...initial,
        chartType: 'retention',
        cohortFilters: [{ operator: 'not_in', cohortIds: ['a'] }],
      } as any),
    );
    expect(state.cohortFilters).toEqual([
      { operator: 'not_in', cohortIds: ['a'] },
    ]);
  });
});
