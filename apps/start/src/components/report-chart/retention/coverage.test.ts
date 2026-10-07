/* @vitest-environment jsdom */
import { cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { getBreakdownChartState } from './chart';
import { RetentionTooltip } from './tooltip';
import { describePartialCoverage } from './coverage';

vi.mock('../context', () => ({
  useReportChartContext: () => ({
    report: {
      interval: 'month',
      unit: '%',
      options: { type: 'retention', retentionUnit: 'day' },
    },
  }),
}));
vi.mock('@/hooks/use-numer-formatter', () => ({
  useNumber: () => ({
    format: String,
    formatWithUnit: (value: number) => `${value * 100}%`,
  }),
}));
afterEach(cleanup);

it('uses the same partial-cell coverage and eligible denominator in the actual chart tooltip', () => {
  const row = {
    cohort_interval: 'Weighted Average',
    breakdowns: [],
    sum: 900,
    values: [0],
    percentages: [0],
    valueWeights: [100],
    coverage: [{ eligible: 23, total: 30 }],
  };
  const state = getBreakdownChartState([row], true);
  const point = state.rechartData![0];
  render(
    createElement(RetentionTooltip, {
      active: true,
      payload: [{ payload: point }],
    })
  );
  expect(screen.getByText('day 0')).toBeTruthy(); // NOT month 0
  expect(screen.getByText('0%*')).toBeTruthy();
  expect(
    screen.getByText(describePartialCoverage(row.coverage[0])!)
  ).toBeTruthy();
  expect(screen.getByText('100')).toBeTruthy();
  expect(screen.queryByText('900')).toBeNull();
});

it('keeps full and unavailable coverage unstarred', () => {
  expect(
    describePartialCoverage({ eligible: 30, total: 30 }, '2026-09-01', 'month')
  ).toBeUndefined();
  expect(describePartialCoverage({ eligible: 0, total: 30 })).toBeUndefined();
});
