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

function inclusiveEndTimestamp(value: string | null | undefined) {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  date.setUTCHours(23, 59, 59, 999);
  return date.getTime();
}

export function utcDayScreenshotRange(milliseconds: number) {
  const date = new Date(milliseconds);
  const startDateMs = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate()
  );
  return {
    startDateMs,
    endDateMs: startDateMs + 24 * 60 * 60 * 1000 - 1,
  };
}

export function buildEventDetailScreenshotContext(
  eventName: string,
  milliseconds: number
): ScreenshotContext {
  return {
    eventName,
    // Event detail properties include OpenPanel/Jitsu enrichment that is not
    // part of Android's event-specific capture metadata. Detail previews are
    // representative; report contexts remain exact and fail closed below.
    filters: [],
    ...utcDayScreenshotRange(milliseconds),
  };
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
  const endDateMs = inclusiveEndTimestamp(endDate);
  return series.flatMap((item) => {
    if (item.type !== 'event') {
      return [];
    }
    const matchable = item.filters.every(
      (filter) => filter.operator === 'is' && filter.value.length > 0
    );
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
      matchable &&
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
        matchable,
      },
    ];
  });
}
