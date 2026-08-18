import { describe, expect, it } from 'vitest';
import {
  changeRetentionBreakdownSort,
  changeRetentionTopN,
  reportSlice,
  setReport,
} from './reportSlice';

const baseReport = {
  projectId: 'project',
  name: 'Report',
  chartType: 'linear',
  lineType: 'monotone',
  interval: 'day',
  breakdowns: [],
  series: [],
  range: '30d',
  previous: false,
  metric: 'sum',
  limit: 500,
};

describe('report display mode persistence', () => {
  it('initializes new reports with the visible Both selection', () => {
    const state = reportSlice.reducer(undefined, { type: 'test/init' });

    expect(state.options).toEqual({ type: 'generic', displayMode: 'both' });
  });

  it('hydrates legacy reports with Both so saving honors the editor selection', () => {
    const state = reportSlice.reducer(
      undefined,
      setReport({
        ...baseReport,
        options: { type: 'retention', criteria: 'on' },
      } as never)
    );

    expect(state.options).toEqual({
      type: 'retention',
      criteria: 'on',
      displayMode: 'both',
    });
    expect(state.dirty).toBe(false);
  });
});

describe('retention breakdown controls', () => {
  it('persists top count and profile-count sort in retention options', () => {
    let state = reportSlice.reducer(
      undefined,
      setReport({
        ...baseReport,
        chartType: 'retention',
        options: { type: 'retention' },
      } as never)
    );

    state = reportSlice.reducer(state, changeRetentionTopN(5));
    state = reportSlice.reducer(
      state,
      changeRetentionBreakdownSort('profile_count_asc')
    );

    expect(state.options).toMatchObject({
      type: 'retention',
      topN: 5,
      breakdownSort: 'profile_count_asc',
    });
    expect(state.dirty).toBe(true);
  });
});
