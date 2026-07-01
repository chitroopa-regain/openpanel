import { describe, expect, it } from 'vitest';

import { buildChangedReportEvent } from './report-series-events';

const baseEvent = {
  id: 'series-a',
  type: 'event' as const,
  name: 'New User Identify',
  segment: 'event' as const,
  displayName: 'Activation start',
  filters: [
    {
      id: 'filter-app-version',
      name: 'app_version',
      operator: 'is' as const,
      value: ['9.1.372'],
    },
  ],
  firstTimeFilter: true,
};

describe('buildChangedReportEvent', () => {
  it('preserves existing filters when changing a single event selection', () => {
    expect(
      buildChangedReportEvent({
        currentEvent: baseEvent,
        value: 'Signup Completed',
        eventNames: [],
      })
    ).toEqual({
      ...baseEvent,
      type: 'event',
      name: 'Signup Completed',
      filters: baseEvent.filters,
    });
  });

  it('preserves existing filters when changing to a custom event selection', () => {
    expect(
      buildChangedReportEvent({
        currentEvent: baseEvent,
        value: 'Paid Signup',
        eventNames: [
          {
            name: 'Paid Signup',
            isCustomEvent: true,
            customEventId: 'custom-event-id',
          },
        ],
      })
    ).toMatchObject({
      id: baseEvent.id,
      type: 'custom_event',
      customEventId: 'custom-event-id',
      displayName: 'Paid Signup',
      filters: baseEvent.filters,
    });
  });
});
