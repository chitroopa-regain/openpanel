import type { IChartEventItem } from '@openpanel/validation';
import type { RouterInputs } from '@/trpc/client';

type ScreenshotContext = NonNullable<
  RouterInputs['chart']['events']['screenshotContexts']
>[number];
type ScreenshotFilter = NonNullable<ScreenshotContext['filters']>[number];
const USER_PROPERTY_PREFIX = /^(?:profile|user)(?:\.|$)/;

interface BreakdownValueContext {
  eventName: string;
  property: string;
  value: string | number | boolean | null;
}

function propertyScope(name: string): ScreenshotFilter['scope'] {
  return USER_PROPERTY_PREFIX.test(name) ? 'user' : 'event';
}

function timestamp(value: string | null | undefined) {
  if (!value) {
    return undefined;
  }
  const result = new Date(value).getTime();
  return Number.isFinite(result) ? result : undefined;
}

export function buildScreenshotContexts({
  series,
  startDate,
  endDate,
  breakdownValue,
}: {
  series: IChartEventItem[];
  startDate?: string | null;
  endDate?: string | null;
  breakdownValue?: BreakdownValueContext;
}): ScreenshotContext[] {
  const startDateMs = timestamp(startDate);
  const endDateMs = timestamp(endDate);
  return series.flatMap((item) => {
    if (item.type !== 'event') {
      return [];
    }
    const filters = item.filters.flatMap<ScreenshotFilter>((filter) => {
      if (filter.operator !== 'is' || filter.value.length === 0) {
        return [];
      }
      return [
        {
          property: filter.name,
          scope: propertyScope(filter.name),
          values: filter.value,
        },
      ];
    });
    const breakdown =
      breakdownValue?.eventName === item.name
        ? {
            property: breakdownValue.property,
            scope: propertyScope(breakdownValue.property),
            values: [breakdownValue.value],
          }
        : undefined;
    if (
      filters.length === 0 &&
      !breakdown &&
      startDateMs === undefined &&
      endDateMs === undefined
    ) {
      return [];
    }
    return [
      {
        eventName: item.name,
        filters,
        breakdown,
        startDateMs,
        endDateMs,
      },
    ];
  });
}
