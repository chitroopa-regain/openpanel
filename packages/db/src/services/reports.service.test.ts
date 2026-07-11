import { describe, expect, it, vi } from 'vitest';
import type { IChartEventItem } from '@openpanel/validation';

vi.mock('../prisma-client', () => ({ db: {} }));

import { transformReportEventItem } from './reports.service';

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
