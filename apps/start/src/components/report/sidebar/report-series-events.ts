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
    // Spread first. Building this object field-by-field silently discarded
    // everything not named here — firstTimeFilter, hidden, property — every
    // time a metric was changed to a custom event, on every chart type.
    // `name` belongs to the ordinary-event shape and `formula` to formulas;
    // neither exists on a custom event, so they are dropped rather than spread
    // through. Everything else carries over.
    const { name: _name, formula: _formula, ...carried } = currentEvent as {
      name?: string;
      formula?: string;
    } & Record<string, unknown>;
    return {
      ...carried,
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
    // Same fix, plus: the reserved `name` filter is REPLACED while every other
    // filter is kept. Rebuilding `filters` from scratch threw away the user's
    // real filters (country, plan, …) on every retention event change.
    const preservedFilters =
      'filters' in currentEvent
        ? (currentEvent.filters ?? []).filter((filter) => filter.name !== 'name')
        : [];
    // `formula` and `customEventId` do not exist on an ordinary event.
    const { formula: _f, customEventId: _c, ...carried } = currentEvent as {
      formula?: string;
      customEventId?: string;
    } & Record<string, unknown>;
    return {
      ...carried,
      id: currentEvent.id,
      type: 'event',
      segment: 'user',
      filters: [
        {
          name: 'name',
          operator: 'is',
          value,
        },
        ...preservedFilters,
      ],
      name: '*',
    } as IChartEventItem;
  }

  return {
    ...currentEvent,
    type: 'event',
    name: value,
    filters: 'filters' in currentEvent ? (currentEvent.filters ?? []) : [],
  } as IChartEventItem;
}
