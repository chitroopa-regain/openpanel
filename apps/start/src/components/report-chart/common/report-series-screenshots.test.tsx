/* @vitest-environment jsdom */

import { render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  ReportSeriesScreenshot,
  ReportSeriesScreenshotsProvider,
} from './report-series-screenshots';

const useQueriesMock = vi.hoisted(() => vi.fn());

vi.mock('@tanstack/react-query', () => ({
  useQueries: useQueriesMock,
}));

vi.mock('../context', () => ({
  useReportChartContext: () => ({
    report: {
      endDate: '2026-08-07T00:00:00.000Z',
      projectId: 'project-1',
      series: [
        {
          filters: [],
          id: 'event-a',
          name: 'Paywall: Shown',
          type: 'event',
        },
      ],
      startDate: '2026-08-01T00:00:00.000Z',
    },
  }),
}));

vi.mock('@/integrations/trpc/react', () => ({
  useTRPC: () => ({
    chart: {
      events: {
        queryOptions: (input: unknown) => ({ input }),
      },
    },
  }),
}));

vi.mock('@/components/events/event-screenshot-preview', () => ({
  EventScreenshotPreview: ({
    eventName,
    screenshots,
  }: {
    eventName: string;
    screenshots?: Array<{ captureId: string }>;
  }) =>
    createElement(
      'div',
      { 'data-testid': eventName },
      screenshots?.map((item) => item.captureId).join(',') ?? 'none'
    ),
}));

const chartSeries = [
  {
    event: {
      breakdowns: { 'properties.source': 'SOURCE_A' },
      id: 'event-a',
      name: 'Paywall: Shown',
    },
    id: 'row-a',
    serieType: 'event',
  },
  {
    event: {
      breakdowns: { 'properties.source': 'SOURCE_B' },
      id: 'event-a',
      name: 'Paywall: Shown',
    },
    id: 'row-b',
    serieType: 'event',
  },
] as never;

const catalog = [
  {
    name: 'Paywall: Shown',
    screenshots: [
      {
        captureId: 'source-a',
        capturedAtMs: Date.UTC(2026, 7, 2),
        eventProperties: { source: 'SOURCE_A' },
        url: 'https://example.com/a.png',
        userProperties: {},
      },
      {
        captureId: 'source-b',
        capturedAtMs: Date.UTC(2026, 7, 2),
        eventProperties: { source: 'SOURCE_B' },
        url: 'https://example.com/b.png',
        userProperties: {},
      },
    ],
  },
];

describe('ReportSeriesScreenshotsProvider', () => {
  it('queries once per batch and keeps previews isolated by exact row context', () => {
    useQueriesMock.mockImplementation(({ queries }) =>
      queries.map(() => ({
        data: catalog,
        isError: false,
        isFetching: false,
        isPending: false,
        refetch: vi.fn(),
      }))
    );

    render(
      <ReportSeriesScreenshotsProvider chartSeries={chartSeries}>
        <ReportSeriesScreenshot eventName="row-a" serieId="row-a" />
        <ReportSeriesScreenshot eventName="row-b" serieId="row-b" />
      </ReportSeriesScreenshotsProvider>
    );

    expect(useQueriesMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('row-a').textContent).toBe('source-a');
    expect(screen.getByTestId('row-b').textContent).toBe('source-b');
  });
});
