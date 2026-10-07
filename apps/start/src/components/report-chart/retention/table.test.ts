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
      interval: 'month',
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
    // Collapsed groups must not build their date rows at all (phone DOM size).
    expect(controlledRows?.querySelectorAll('tr')).toHaveLength(0);
    expect(priceHalfRows?.querySelectorAll('tr')).toHaveLength(0);

    fireEvent.click(control);
    expect(control.getAttribute('aria-expanded')).toBe('true');
    expect(controlledRows?.hidden).toBe(false);
    expect(controlledRows?.textContent).toContain('2026-07-21');
    expect(priceHalfRows?.hidden).toBe(true);
    expect(priceHalfRows?.querySelectorAll('tr')).toHaveLength(0);

    fireEvent.click(control);
    expect(controlledRows?.hidden).toBe(true);
    expect(controlledRows?.querySelectorAll('tr')).toHaveLength(0);
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

  it('renders each heat cell as td + one div with the value as direct text', () => {
    const data: CohortData = [
      { ...row('2026-07-21', []), values: [5, 0], percentages: [0.5, 0] },
      {
        ...row('2026-07-22', []),
        values: [1, null as unknown as number],
        percentages: [0.1, null as unknown as number],
      },
    ];

    render(createElement(CohortTable, { data }));

    const cells = Array.from(
      document.querySelectorAll<HTMLElement>('td > div.isolate')
    );
    // 2 rows x 2 day columns
    expect(cells).toHaveLength(4);
    for (const cell of cells) {
      expect(cell.children).toHaveLength(0);
    }
    const [filled, zero, , empty] = cells as [
      HTMLElement,
      HTMLElement,
      HTMLElement,
      HTMLElement,
    ];
    expect(filled.style.getPropertyValue('--cell-opacity')).not.toBe('');
    expect(filled.className).toContain('before:bg-highlight');
    expect(zero.className).not.toContain('before:bg-highlight');
    expect(empty.textContent).toBe('—');
    expect(empty.className).not.toContain('before:bg-highlight');
    expect(empty.getAttribute('style')).toBeNull();
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
          ...{
            roasAvailable: false,
            roasMaxDay: 0,
            coverageFrom: {},
            spendPendingToday: [],
            trackingStart: null,
            spendFilters: { applied: [], ignored: [] },
          },
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
    expect(headers.slice(1, 6)).toEqual([
      'Play installs',
      'Spend',
      'CPI',
      'Revenue',
      'Total profiles',
    ]);
    const cpi = screen
      .getAllByTestId('retention-cpi-cell')
      .map((cell) => cell.textContent);
    expect(cpi).toEqual(['₹191', '₹127.3', '₹141', '—']);
    expect(screen.getAllByTestId('retention-spend-cell')[2]?.textContent).toBe(
      '₹2,82,000'
    );
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
          ...{
            roasAvailable: false,
            roasMaxDay: 0,
            coverageFrom: {},
            spendPendingToday: [],
            trackingStart: null,
            spendFilters: { applied: [], ignored: [] },
          },
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
    ).toEqual(['—', '1.00x', '1.25x']);
    expect(
      screen.getAllByTestId('retention-roas-d30-cell').map((c) => c.textContent)
    ).toEqual(['—', '—', '—']);
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
          {
            ...row('2026-10-02', [], 10000),
            spend: 149_929,
            cpi: 15,
            roas: {
              d0: 0.42,
              d7: null,
              d30: null,
              lifetime: 0.42,
              partial: ['d0'],
            },
          },
        ],
        acquisitionCost: {
          ...{
            roasAvailable: false,
            roasMaxDay: 0,
            coverageFrom: {},
            spendPendingToday: [],
            trackingStart: null,
            spendFilters: { applied: [], ignored: [] },
          },
          mode: 'blended',
          breakdown: null,
          totalSpend: 149_929,
          attributedSpend: 149_929,
          currency: 'INR',
          roasAvailable: true,
          roasMaxDay: 7,
          coverageFrom: {},
          spendPendingToday: ['meta_ads'],
        },
      })
    );
    // [0] is the Total row; [1] is today's cohort.
    const d0 = screen.getAllByTestId('retention-roas-d0-cell')[1];
    expect(d0?.textContent).toBe('0.42xso far');
    expect(
      screen.getByTestId('retention-acquisition-cost-note').textContent
    ).toContain("Meta has not reported today's spend yet");
  });

  it('shows booked revenue and ROAS before tracking without extra tags or faded text', () => {
    render(
      createElement(CohortTable, {
        data: [
          {
            ...row('2026-02-01', [], 0),
            spend: 1_034_746,
            cpi: 1.73,
            playInstalls: 596_667,
            lifetimeRevenue: 1_188_650,
            revenueBasis: 'booked',
            installsSource: 'play',
            externalInstalls: 596_667,
            roas: {
              d0: null,
              d7: null,
              d30: null,
              lifetime: 1.149,
              basis: 'booked',
            },
          },
        ],
        acquisitionCost: {
          ...{
            roasAvailable: false,
            roasMaxDay: 0,
            coverageFrom: {},
            spendPendingToday: [],
            trackingStart: null,
            spendFilters: { applied: [], ignored: [] },
          },
          mode: 'blended',
          breakdown: null,
          totalSpend: 1_034_746,
          attributedSpend: 0,
          currency: 'INR',
          roasAvailable: true,
          roasMaxDay: 7,
          coverageFrom: {},
          spendPendingToday: [],
          trackingStart: '2026-03-12',
          spendFilters: { applied: [], ignored: [] },
        },
      })
    );
    expect(
      screen.getAllByTestId('retention-play-installs-cell')[0]?.textContent
    ).toBe('596667');
    expect(
      screen.getAllByTestId('retention-revenue-cell')[0]?.textContent
    ).toBe('₹11,88,650');
    expect(
      screen.getAllByTestId('retention-roas-lifetime-cell')[0]?.textContent
    ).toBe('1.15x');
    expect(screen.getAllByTestId('retention-cpi-cell')[0]?.textContent).toBe(
      '₹1.7'
    );
    // Same text colour on every row: no muted styling on Spend / CPI / Revenue.
    for (const id of [
      'retention-spend-cell',
      'retention-cpi-cell',
      'retention-revenue-cell',
    ]) {
      expect(
        screen.getAllByTestId(id)[0]?.querySelector('div')?.className ?? ''
      ).not.toContain('text-muted-foreground');
    }
    expect(
      screen.getAllByTestId('retention-roas-d0-cell')[0]?.textContent
    ).toBe('—');
  });

  it('shows a Total row above Weighted Average that sums every row', () => {
    const cost = {
      mode: 'blended' as const,
      breakdown: null,
      totalSpend: 0,
      attributedSpend: 0,
      currency: 'INR' as const,
      roasAvailable: true,
      roasMaxDay: 30,
      coverageFrom: {},
      spendPendingToday: [],
      trackingStart: '2026-03-12',
      spendFilters: { applied: [], ignored: [] },
    };
    render(
      createElement(CohortTable, {
        data: [
          {
            ...row('Weighted Average', [], 3000),
            spend: 300_000,
            cpi: 100,
            playInstalls: 4000,
            lifetimeRevenue: 450_000,
            roas: { d0: 0.5, d7: null, d30: null, lifetime: 1.5 },
          },
          // Before tracking: Play CPI, booked revenue.
          {
            ...row('2026-02-01', [], 0),
            spend: 100_000,
            cpi: 1,
            playInstalls: 100_000,
            lifetimeRevenue: 120_000,
            revenueBasis: 'booked',
            installsSource: 'play',
            externalInstalls: 100_000,
            roas: {
              d0: null,
              d7: null,
              d30: null,
              lifetime: 1.2,
              basis: 'booked',
            },
          },
          // Tracked.
          {
            ...row('2026-03-01', [], 3000),
            spend: 300_000,
            cpi: 100,
            playInstalls: 4000,
            lifetimeRevenue: 450_000,
            revenueBasis: 'cohort',
            roas: { d0: 0.5, d7: null, d30: null, lifetime: 1.5 },
          },
        ],
        acquisitionCost: cost,
      })
    );
    const bodyRows = screen.getAllByRole('row').slice(1);
    expect(bodyRows[0]?.textContent).toContain('Total');
    expect(bodyRows[1]?.textContent).toContain('Weighted Average');
    const total = screen.getByTestId('retention-total-row');
    const cell = (id: string) =>
      total.querySelector(`[data-testid="${id}"]`)?.textContent;
    expect(cell('retention-play-installs-cell')).toBe('104000');
    expect(cell('retention-spend-cell')).toBe('₹4,00,000');
    // 400000 / (100000 Play installs + 3000 cohort installs)
    expect(cell('retention-cpi-cell')).toBe('₹3.9');
    expect(cell('retention-revenue-cell')).toBe('₹5,70,000');
    expect(cell('retention-roas-lifetime-cell')).toBe('1.43x');
    expect(cell('retention-roas-d0-cell')).toBe('—');
  });

  it('collapses day columns of rows before tracking into one cell', () => {
    const wide = (interval: string, sum: number) => ({
      ...row(interval, [], sum),
      values: Array.from({ length: 200 }, () => 0),
      percentages: Array.from({ length: 200 }, () => 0),
    });
    render(
      createElement(CohortTable, {
        data: [
          { ...wide('Weighted Average', 3000), spend: 1, cpi: 1 },
          {
            ...wide('2026-02-01', 0),
            spend: 1_034_746,
            cpi: 1.73,
            installsSource: 'play',
            externalInstalls: 596_667,
          },
          { ...wide('2026-03-01', 3000), spend: 300_000, cpi: 100 },
        ],
        acquisitionCost: {
          ...{
            roasAvailable: false,
            roasMaxDay: 0,
            coverageFrom: {},
            spendPendingToday: [],
            trackingStart: null,
            spendFilters: { applied: [], ignored: [] },
          },
          mode: 'blended',
          breakdown: null,
          totalSpend: 0,
          attributedSpend: 0,
          currency: 'INR',
          roasAvailable: true,
          roasMaxDay: 30,
          coverageFrom: {},
          spendPendingToday: [],
          trackingStart: '2026-03-12',
          spendFilters: { applied: [], ignored: [] },
        },
      })
    );
    const merged = screen.getAllByTestId('retention-before-tracking-cell');
    expect(merged).toHaveLength(1);
    expect(merged[0]?.getAttribute('colspan')).toBe('200');
    // The tracked March row keeps all 200 day cells.
    const marchRow = screen.getByText('2026-03-01').closest('tr');
    expect(marchRow?.querySelectorAll('td').length).toBeGreaterThan(200);
  });

  it('offers no ROAS columns when the report does not measure revenue', () => {
    render(
      createElement(CohortTable, {
        data: [
          { ...row('2026-09-29', [], 2000), spend: 1, cpi: 1, roas: null },
        ],
        acquisitionCost: {
          ...{
            roasAvailable: false,
            roasMaxDay: 0,
            coverageFrom: {},
            spendPendingToday: [],
            trackingStart: null,
            spendFilters: { applied: [], ignored: [] },
          },
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

describe('partial maturity presentation', () => {
  it('renders a dynamic star on real zero, removes it on completion, leaves null blank', () => {
    const data = [
      {
        ...row('2026-09-01', []),
        values: [0],
        percentages: [0],
        coverage: [{ eligible: 23, total: 30 }],
      },
    ];
    const { rerender } = render(createElement(CohortTable, { data }));
    const title =
      'Based on 23 of 30 September cohort days. Only completed windows contribute; their matching denominators are used.';
    expect(screen.getByTitle(title).textContent).toContain('0%*');
    expect(screen.getByLabelText(title).textContent).toBe('*');
    rerender(
      createElement(CohortTable, {
        data: [{ ...data[0]!, coverage: [{ eligible: 30, total: 30 }] }],
      })
    );
    expect(screen.queryByTitle(title)).toBeNull();
    expect(screen.queryByText('*')).toBeNull();
    rerender(
      createElement(CohortTable, {
        data: [
          {
            ...data[0]!,
            values: [null],
            percentages: [null],
            coverage: [{ eligible: 0, total: 30 }],
          },
        ],
      })
    );
    expect(screen.getByText('—')).toBeTruthy();
    expect(screen.queryByText('*')).toBeNull();
  });

  it('shows coverage on collapsed summaries and expanded dated breakdowns', () => {
    const data = [
      {
        ...row('Weighted Average', ['control']),
        coverage: [{ eligible: 1, total: 2 }],
      },
      {
        ...row('2026-09-01', ['control']),
        coverage: [{ eligible: 1, total: 2 }],
      },
    ];
    render(createElement(CohortTable, { data }));
    expect(screen.getAllByText('*')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'control' }));
    expect(screen.getAllByText('*')).toHaveLength(2);
    expect(
      screen.getByTitle(/Based on 1 of 2 September cohort days/)
    ).toBeTruthy();
  });

  it('stars partial ROAS without mislabelling it as today so far', () => {
    render(
      createElement(CohortTable, {
        data: [
          {
            ...row('2026-09-01', []),
            spend: 100,
            cpi: 10,
            roas: {
              d0: 1,
              d7: 0,
              d30: null,
              lifetime: 1,
              coverage: { d7: { eligible: 23, total: 30 } },
            },
          },
        ],
        acquisitionCost: {
          mode: 'blended',
          breakdown: null,
          totalSpend: 100,
          attributedSpend: 100,
          currency: 'INR',
          roasAvailable: true,
          roasMaxDay: 30,
          coverageFrom: {},
          spendPendingToday: [],
          trackingStart: null,
          spendFilters: { applied: [], ignored: [] },
        },
      })
    );
    const cell = screen
      .getAllByTestId('retention-roas-d7-cell')
      .find((cell) => cell.querySelector('[title]'))!;
    expect(cell.textContent).toContain('*');
    expect(cell.textContent).not.toContain('so far');
    expect(cell.querySelector('[title]')?.getAttribute('title')).toContain(
      '23 of 30 September cohort days'
    );
  });
});
