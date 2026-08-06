import { describe, expect, it } from 'vitest';

import {
  buildChangedReportEvent,
  findSelectedCustomEvent,
} from './report-series-events';

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

  it('resolves a retention multi-select custom event instead of treating its display name as a raw event', () => {
    expect(
      buildChangedReportEvent({
        currentEvent: {
          ...baseEvent,
          name: '*',
          filters: [
            {
              name: 'name',
              operator: 'is',
              value: ['FT: Session Completed'],
            },
            ...baseEvent.filters,
          ],
        },
        value: ['OB Setup Completed Regain'],
        eventNames: [
          {
            name: 'OB Setup Completed Regain',
            isCustomEvent: true,
            customEventId: 'ob-setup-custom-event-id',
          },
        ],
      })
    ).toMatchObject({
      type: 'custom_event',
      customEventId: 'ob-setup-custom-event-id',
      displayName: 'OB Setup Completed Regain',
      filters: baseEvent.filters,
    });
  });

  it('keeps multiple regular retention events as a wildcard event selection', () => {
    expect(
      buildChangedReportEvent({
        currentEvent: baseEvent,
        value: ['FT: Session Completed', 'Active User Event New'],
        eventNames: [],
      })
    ).toMatchObject({
      type: 'event',
      name: '*',
      filters: [
        {
          name: 'name',
          operator: 'is',
          value: ['FT: Session Completed', 'Active User Event New'],
        },
      ],
    });
  });

  it('does not resolve empty or multi-value selections as custom events', () => {
    const eventNames = [
      {
        name: 'OB Setup Completed Regain',
        isCustomEvent: true,
        customEventId: 'ob-setup-custom-event-id',
      },
    ];

    expect(findSelectedCustomEvent([], eventNames)).toBeNull();
    expect(
      findSelectedCustomEvent(
        ['OB Setup Completed Regain', 'FT: Session Completed'],
        eventNames
      )
    ).toBeNull();
  });
});
