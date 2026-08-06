import { describe, expect, it, vi } from 'vitest';
import type { IChartEventItem } from '@openpanel/validation';

vi.mock('../prisma-client', () => ({ db: {} }));

import { transformReport, transformReportEventItem } from './reports.service';

describe('transformReportEventItem', () => {
  it.each([
    {
      type: 'event',
      id: 'event-a',
      name: 'Server: Purchase',
      segment: 'event',
      filters: [],
      hidden: true,
    },
    {
      type: 'custom_event',
      id: 'custom-b',
      customEventId: 'purchase-custom',
      segment: 'event',
      filters: [],
      hidden: true,
    },
    {
      type: 'formula',
      id: 'formula-c',
      formula: 'A/B',
      hidden: true,
    },
  ] satisfies IChartEventItem[])('preserves hidden for $type series', (item) => {
    expect(transformReportEventItem(item, 0).hidden).toBe(true);
  });
});

describe('transformReport range', () => {
  const report = {
    id: 'report-1',
    dashboardId: 'dashboard-1',
    projectId: 'project-1',
    name: 'Retention',
    chartType: 'retention',
    lineType: 'monotone',
    interval: 'month',
    events: [],
    breakdowns: [],
    previous: false,
    formula: null,
    metric: 'sum',
    unit: null,
    options: null,
    dateConfig: null,
    layout: null,
  };

  it.each([
    '3m',
    '6m',
  ] as const)('preserves the current %s month range', (range) => {
    expect(transformReport({ ...report, range } as never).range).toBe(range);
  });

  it('falls back for a genuinely deprecated range', () => {
    expect(transformReport({ ...report, range: '1y' } as never).range).toBe(
      '30d'
    );
  });
});
