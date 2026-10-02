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
      series: [
        {
          id: 'retention-start',
          name: 'Subscription Intro BS: Shown',
          type: 'event',
        },
      ],
      unit: '%',
    },
  }),
}));

vi.mock('../common/report-series-screenshots', () => ({
  ReportSeriesScreenshotsProvider: ({ children }: { children: unknown }) =>
    children,
  ReportSeriesScreenshot: ({ serieId }: { serieId: string }) =>
    createElement('span', { 'data-testid': `screenshot-${serieId}` }),
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
    expect(screen.getAllByTestId(/screenshot-/)).toHaveLength(2);
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

  it('shows Spend and CPI before Total profiles only when acquisition cost is on', () => {
    const data = [
      { ...row('Weighted Average', [], 3000), spend: 382000, cpi: 127.33 },
      { ...row('2026-09-29', [], 2000), spend: 282000, cpi: 141 },
      { ...row('2026-09-30', [], 0), spend: 100000, cpi: null },
    ];

    render(
      createElement(CohortTable, {
        data,
        acquisitionCost: {
          mode: 'blended',
          breakdown: null,
          totalSpend: 382000,
          attributedSpend: 382000,
          currency: 'INR',
        },
      })
    );

    const headers = screen
      .getAllByRole('columnheader')
      .map((header) => header.textContent);
    expect(headers.slice(1, 6)).toEqual(['Play installs', 'Spend', 'CPI', 'Revenue', 'Total profiles']);
    const cpi = screen
      .getAllByTestId('retention-cpi-cell')
      .map((cell) => cell.textContent);
    expect(cpi).toEqual(['₹127.3', '₹141', '—']);
    expect(
      screen.getAllByTestId('retention-spend-cell')[1]?.textContent
    ).toBe('₹2,82,000');
    expect(
      screen.getByTestId('retention-acquisition-cost-note').textContent
    ).toContain('blended');
    cleanup();

    render(createElement(CohortTable, { data }));
    expect(screen.queryByText('CPI')).toBeNull();
    expect(screen.queryByTestId('retention-acquisition-cost-note')).toBeNull();
  });

  it('shows ROAS columns and hides any column whose tick box is cleared', () => {
    const data = [
      {
        ...row('Weighted Average', [], 3000),
        spend: 382000,
        cpi: 127.33,
        roas: { d0: 0.5, d7: 1, d30: null, lifetime: 0.942 },
      },
      {
        ...row('2026-09-29', [], 2000),
        spend: 282000,
        cpi: 141,
        roas: { d0: 0.5, d7: 1.25, d30: null, lifetime: 1.064 },
      },
    ];
    render(
      createElement(CohortTable, {
        data,
        acquisitionCost: {
          mode: 'blended',
          breakdown: null,
          totalSpend: 382000,
          attributedSpend: 382000,
          currency: 'INR',
          roasAvailable: true,
          roasMaxDay: 7,
        },
      })
    );
    const headers = () =>
      screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers().slice(1, 10)).toEqual([
      'Play installs',
      'Spend',
      'CPI',
      'Revenue',
      'D0 ROAS',
      'D7 ROAS',
      'D30 ROAS',
      'Lifetime ROAS',
      'Total profiles',
    ]);
    expect(
      screen.getAllByTestId('retention-roas-d7-cell').map((c) => c.textContent)
    ).toEqual(['1.00x', '1.25x']);
    expect(
      screen.getAllByTestId('retention-roas-d30-cell').map((c) => c.textContent)
    ).toEqual(['—', '—']);
    expect(screen.getByText(/D30 ROAS \(range too short\)/)).toBeTruthy();

    fireEvent.click(screen.getByRole('checkbox', { name: /^CPI$/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /D30 ROAS/ }));
    expect(headers().slice(1, 8)).toEqual([
      'Play installs',
      'Spend',
      'Revenue',
      'D0 ROAS',
      'D7 ROAS',
      'Lifetime ROAS',
      'Total profiles',
    ]);
  });

  it("marks today's D0 ROAS as so far and names platforms whose spend is pending", () => {
    render(
      createElement(CohortTable, {
        data: [
          { ...row('2026-10-02', [], 10000), spend: 149_929, cpi: 15, roas: { d0: 0.42, d7: null, d30: null, lifetime: 0.42, partial: ['d0'] } },
        ],
        acquisitionCost: {
          mode: 'blended', breakdown: null, totalSpend: 149_929, attributedSpend: 149_929, currency: 'INR',
          roasAvailable: true, roasMaxDay: 7, coverageFrom: {}, spendPendingToday: ['meta_ads'],
        },
      })
    );
    const d0 = screen.getAllByTestId('retention-roas-d0-cell')[0];
    expect(d0?.textContent).toBe('0.42xso far');
    expect(screen.getByTestId('retention-acquisition-cost-note').textContent).toContain(
      "Meta has not reported today's spend yet"
    );
  });

  it('shows booked revenue and ROAS before tracking without extra tags or faded text', () => {
    render(
      createElement(CohortTable, {
        data: [
          { ...row('2026-02-01', [], 0), spend: 1_034_746, cpi: 1.73, playInstalls: 596_667, lifetimeRevenue: 1_188_650, revenueBasis: 'booked', installsSource: 'play', externalInstalls: 596_667, roas: { d0: null, d7: null, d30: null, lifetime: 1.149, basis: 'booked' } },
        ],
        acquisitionCost: {
          mode: 'blended', breakdown: null, totalSpend: 1_034_746, attributedSpend: 0, currency: 'INR',
          roasAvailable: true, roasMaxDay: 7, coverageFrom: {}, spendPendingToday: [], trackingStart: '2026-03-12', spendFilters: { applied: [], ignored: [] },
        },
      })
    );
    expect(screen.getAllByTestId('retention-play-installs-cell')[0]?.textContent).toBe('596667');
    expect(screen.getAllByTestId('retention-revenue-cell')[0]?.textContent).toBe('₹11,88,650');
    expect(screen.getAllByTestId('retention-roas-lifetime-cell')[0]?.textContent).toBe('1.15x');
    expect(screen.getAllByTestId('retention-cpi-cell')[0]?.textContent).toBe('₹1.7');
    // Same text colour on every row: no muted styling on Spend / CPI / Revenue.
    for (const id of ['retention-spend-cell', 'retention-cpi-cell', 'retention-revenue-cell']) {
      expect(screen.getAllByTestId(id)[0]?.querySelector('div')?.className ?? '').not.toContain('text-muted-foreground');
    }
    expect(screen.getAllByTestId('retention-roas-d0-cell')[0]?.textContent).toBe('—');
  });

  it('offers no ROAS columns when the report does not measure revenue', () => {
    render(
      createElement(CohortTable, {
        data: [{ ...row('2026-09-29', [], 2000), spend: 1, cpi: 1, roas: null }],
        acquisitionCost: {
          mode: 'blended',
          breakdown: null,
          totalSpend: 1,
          attributedSpend: 1,
          currency: 'INR',
          roasAvailable: false,
          roasMaxDay: 7,
        },
      })
    );
    expect(screen.queryByText('D0 ROAS')).toBeNull();
    expect(
      screen.getByTestId('retention-acquisition-cost-note').textContent
    ).toContain('ROAS needs a revenue metric');
  });

  it('renders immature intervals as unavailable instead of zero', () => {
    const data: CohortData = [
      {
        ...row('Weighted Average', [], 20),
        percentages: [null],
        values: [null],
      },
      {
        ...row('2026-07-31', [], 20),
        percentages: [null],
        values: [null],
      },
    ];

    render(createElement(CohortTable, { data }));

    expect(screen.getAllByText('—')).toHaveLength(2);
    expect(screen.queryByText('0%')).toBeNull();
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
