/* @vitest-environment jsdom */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CohortTable, {
  type CohortData,
  getCohortBreakdownGroups,
} from './table';
import { getChartColor } from '@/utils/theme';

vi.mock('../context', () => ({
  useReportChartContext: () => ({
    report: {
      breakdowns: [{ id: 'variant', name: 'profile.variant' }],
      options: { type: 'retention' },
      unit: '%',
    },
  }),
}));

vi.mock('@/hooks/use-numer-formatter', () => ({
  useNumber: () => ({
    format: (value: number) => String(value),
    formatWithUnit: (value: number, unit?: string) =>
      unit ? `${value}${unit}` : String(value),
  }),
}));

vi.mock('@/translations/properties', () => ({
  getPropertyLabel: (name: string) => name,
}));

afterEach(cleanup);

const normalizeColor = (color: string) => {
  const element = document.createElement('span');
  element.style.backgroundColor = color;
  return element.style.backgroundColor;
};

const row = (
  cohortInterval: string,
  breakdowns: string[],
  sum = 10
): CohortData[number] => ({
  breakdowns,
  cohort_interval: cohortInterval,
  percentages: [0.5],
  sum,
  values: [5],
});

describe('retention breakdown table groups', () => {
  it('keeps only the weighted average in the collapsed group summary', () => {
    const groups = getCohortBreakdownGroups([
      row('Weighted Average', ['control'], 20),
      row('2026-07-21', ['control']),
      row('2026-07-22', ['control']),
      row('Weighted Average', ['price_half'], 30),
      row('2026-07-21', ['price_half']),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      label: 'control',
      summary: { cohort_interval: 'Weighted Average', sum: 20 },
    });
    expect(groups[0]?.cohorts.map((item) => item.cohort_interval)).toEqual([
      '2026-07-21',
      '2026-07-22',
    ]);
    expect(groups[1]).toMatchObject({
      label: 'price_half',
      summary: { cohort_interval: 'Weighted Average', sum: 30 },
    });
  });

  it('keeps multi-property tuples separate and labels missing values', () => {
    const groups = getCohortBreakdownGroups([
      row('Weighted Average', ['same', '']),
      row('2026-07-21', ['same', '']),
      row('Weighted Average', ['', 'same']),
      row('2026-07-21', ['', 'same']),
    ]);

    expect(groups.map((group) => group.label)).toEqual([
      'same / (not set)',
      '(not set) / same',
    ]);
    expect(new Set(groups.map((group) => group.key)).size).toBe(2);
  });

  it('shows exact chart colors and accessible collapsed summaries', () => {
    const data: CohortData = [
      row('Weighted Average', ['control'], 20),
      row('2026-07-21', ['control']),
      row('Weighted Average', ['price_half'], 30),
      row('2026-07-22', ['price_half']),
    ];

    render(createElement(CohortTable, { data }));

    const control = screen.getByRole('button', { name: 'control' });
    const priceHalf = screen.getByRole('button', { name: 'price_half' });

    expect(control.getAttribute('aria-expanded')).toBe('false');
    expect(priceHalf.getAttribute('aria-expanded')).toBe('false');
    expect(
      (control.querySelector('[data-breakdown-color]') as HTMLElement).style
        .backgroundColor
    ).toBe(normalizeColor(getChartColor(0)));
    expect(
      (priceHalf.querySelector('[data-breakdown-color]') as HTMLElement).style
        .backgroundColor
    ).toBe(normalizeColor(getChartColor(1)));
    const controlledRows = document.getElementById(
      control.getAttribute('aria-controls')!
    );
    const priceHalfRows = document.getElementById(
      priceHalf.getAttribute('aria-controls')!
    );
    expect(controlledRows?.hidden).toBe(true);
    expect(priceHalfRows?.hidden).toBe(true);

    fireEvent.click(control);
    expect(control.getAttribute('aria-expanded')).toBe('true');
    expect(controlledRows?.hidden).toBe(false);
    expect(priceHalfRows?.hidden).toBe(true);

    fireEvent.click(control);
    expect(controlledRows?.hidden).toBe(true);
  });

  it('uses the displayed rows to preserve no-breakdown rendering', () => {
    const data: CohortData = [
      row('Weighted Average', [], 20),
      row('2026-07-21', []),
      row('2026-07-22', []),
    ];

    render(createElement(CohortTable, { data }));

    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByText('Weighted Average')).toBeTruthy();
    expect(screen.getByText('2026-07-21')).toBeTruthy();
    expect(screen.getByText('2026-07-22')).toBeTruthy();
  });

  it('collapses matching groups when refreshed data arrives', async () => {
    const initialData: CohortData = [
      row('Weighted Average', ['control'], 20),
      row('2026-07-21', ['control']),
    ];
    const { rerender } = render(
      createElement(CohortTable, { data: initialData })
    );
    const control = screen.getByRole('button', { name: 'control' });
    const controlledRows = document.getElementById(
      control.getAttribute('aria-controls')!
    );

    fireEvent.click(control);
    expect(controlledRows?.hidden).toBe(false);

    const refreshedData: CohortData = [
      row('Weighted Average', ['control'], 25),
      row('2026-07-22', ['control']),
    ];
    rerender(createElement(CohortTable, { data: refreshedData }));

    await waitFor(() => {
      expect(control.getAttribute('aria-expanded')).toBe('false');
    });
    expect(controlledRows?.hidden).toBe(true);
  });
});
