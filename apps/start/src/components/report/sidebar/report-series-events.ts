import type { IChartEventItem } from '@openpanel/validation';

type EventNameItem = {
  name: string;
  isCustomEvent?: boolean;
  customEventId?: string;
};

export function findSelectedCustomEvent(
  value: string | string[],
  eventNames: EventNameItem[]
): (EventNameItem & { isCustomEvent: true; customEventId: string }) | null {
  const selectedValue = Array.isArray(value)
    ? value.length === 1
      ? value[0]
      : null
    : value;
  const selectedItem = selectedValue
    ? eventNames.find((eventName) => eventName.name === selectedValue)
    : null;

  if (selectedItem?.isCustomEvent && selectedItem.customEventId) {
    return {
      ...selectedItem,
      isCustomEvent: true,
      customEventId: selectedItem.customEventId,
    };
  }

  return null;
}

export function buildChangedReportEvent({
  currentEvent,
  value,
  eventNames,
}: {
  currentEvent: IChartEventItem;
  value: string | string[];
  eventNames: EventNameItem[];
}): IChartEventItem {
  const selectedItem = findSelectedCustomEvent(value, eventNames);

  if (selectedItem) {
    return {
      id: currentEvent.id,
      type: 'custom_event',
      customEventId: selectedItem.customEventId,
      segment: 'event',
      displayName: selectedItem.name,
      filters:
        'filters' in currentEvent
          ? (currentEvent.filters ?? []).filter(
              (filter) => !Array.isArray(value) || filter.name !== 'name'
            )
          : [],
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
