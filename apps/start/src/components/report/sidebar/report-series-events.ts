import type { IChartEventItem } from '@openpanel/validation';

type EventNameItem = {
  name: string;
  isCustomEvent?: boolean;
  customEventId?: string;
};

export function buildChangedReportEvent({
  currentEvent,
  value,
  eventNames,
}: {
  currentEvent: IChartEventItem;
  value: string | string[];
  eventNames: EventNameItem[];
}): IChartEventItem {
  const selectedItem = Array.isArray(value)
    ? null
    : eventNames.find((eventName) => eventName.name === value);

  if (
    selectedItem?.isCustomEvent &&
    'customEventId' in selectedItem &&
    selectedItem.customEventId
  ) {
    return {
      id: currentEvent.id,
      type: 'custom_event',
      customEventId: selectedItem.customEventId,
      segment: 'event',
      displayName: selectedItem.name,
      filters: 'filters' in currentEvent ? (currentEvent.filters ?? []) : [],
    } as IChartEventItem;
  }

  if (Array.isArray(value)) {
    return {
      id: currentEvent.id,
      type: 'event',
      segment: 'user',
      filters: [
        {
          name: 'name',
          operator: 'is',
          value,
        },
      ],
      name: '*',
    };
  }

  return {
    ...currentEvent,
    type: 'event',
    name: value,
    filters: 'filters' in currentEvent ? (currentEvent.filters ?? []) : [],
  } as IChartEventItem;
}
