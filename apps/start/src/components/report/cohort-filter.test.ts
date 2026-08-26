import { describe, expect, it } from 'vitest';
import { reportSlice } from './reportSlice';

const {
  addSerie,
  changeChartType,
  changeReportCohortFilter,
  changeSeriesCohortFilter,
  setReport,
} = reportSlice.actions;
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

describe('inline (per-metric) cohort filter', () => {
  it('applies to only the targeted series', () => {
    let state = withOneEvent();
    state = reportSlice.reducer(
      state,
      addSerie({
        type: 'event',
        name: 'Other Event',
        segment: 'event',
        filters: [],
      } as any),
    );
    const [first, second] = state.series;

    state = reportSlice.reducer(
      state,
      changeSeriesCohortFilter({
        seriesId: first!.id!,
        filter: { operator: 'in', cohortIds: ['cohort-a'] },
      }),
    );

    expect((state.series[0] as any).cohortFilter).toEqual({
      operator: 'in',
      cohortIds: ['cohort-a'],
    });
    // The sibling must be untouched — the whole point of a per-metric filter.
    expect((state.series[1] as any).cohortFilter).toBeUndefined();
    expect(state.series[1]!.id).toBe(second!.id);
  });

  it('preserves the rest of the series when setting a filter', () => {
    // A dedicated action exists precisely because changeEvent replaces the whole
    // object; this pins that sibling fields survive.
    let state = withOneEvent();
    const id = state.series[0]!.id!;
    state = reportSlice.reducer(
      state,
      changeSeriesCohortFilter({
        seriesId: id,
        filter: { operator: 'not_in', cohortIds: ['cohort-b'] },
      }),
    );
    expect((state.series[0] as any).name).toBe('FT: Overlay Shown');
    expect((state.series[0] as any).segment).toBe('event');
    expect((state.series[0] as any).cohortFilter.operator).toBe('not_in');
  });

  it('clears the filter when passed undefined', () => {
    let state = withOneEvent();
    const id = state.series[0]!.id!;
    state = reportSlice.reducer(
      state,
      changeSeriesCohortFilter({
        seriesId: id,
        filter: { operator: 'in', cohortIds: ['cohort-a'] },
      }),
    );
    state = reportSlice.reducer(
      state,
      changeSeriesCohortFilter({ seriesId: id, filter: undefined }),
    );
    expect((state.series[0] as any).cohortFilter).toBeUndefined();
  });
});

describe('report-level cohort filter', () => {
  it('round-trips and clears', () => {
    let state = reportSlice.reducer(
      initial,
      changeReportCohortFilter({ operator: 'in', cohortIds: ['a', 'b'] }),
    );
    expect(state.cohortFilter).toEqual({ operator: 'in', cohortIds: ['a', 'b'] });

    state = reportSlice.reducer(state, changeReportCohortFilter(undefined));
    expect(state.cohortFilter).toBeUndefined();
  });
});

describe('unsupported chart types strip every cohort surface', () => {
  it.each(['funnel', 'funnel_metric', 'retention', 'sankey', 'conversion'])(
    'hydrating a saved %s report drops report-level AND inline filters',
    (chartType) => {
      const state = reportSlice.reducer(
        initial,
        setReport({
          ...initial,
          chartType: chartType as any,
          cohortFilter: { operator: 'in', cohortIds: ['a'] },
          cohortBreakdown: { cohortIds: ['b'] },
          series: [
            {
              id: 'A',
              type: 'event',
              name: 'E',
              segment: 'event',
              filters: [],
              cohortFilter: { operator: 'in', cohortIds: ['c'] },
            },
          ],
        } as any),
      );
      // Leaving any of these set would show an active filter in the sidebar
      // over numbers the query path never actually filtered.
      expect(state.cohortFilter).toBeUndefined();
      expect(state.cohortBreakdown).toBeUndefined();
      expect((state.series[0] as any).cohortFilter).toBeUndefined();
    },
  );

  it.each(['linear', 'bar', 'area', 'pie', 'metric', 'table', 'histogram'])(
    'keeps them on %s',
    (chartType) => {
      const state = reportSlice.reducer(
        initial,
        setReport({
          ...initial,
          chartType: chartType as any,
          cohortFilter: { operator: 'not_in', cohortIds: ['a'] },
        } as any),
      );
      expect(state.cohortFilter).toEqual({
        operator: 'not_in',
        cohortIds: ['a'],
      });
    },
  );

  it('switching an existing report to an unsupported type clears the filter', () => {
    let state = reportSlice.reducer(
      initial,
      changeReportCohortFilter({ operator: 'in', cohortIds: ['a'] }),
    );
    state = reportSlice.reducer(state, changeChartType('funnel'));
    expect(state.cohortFilter).toBeUndefined();
  });
});
