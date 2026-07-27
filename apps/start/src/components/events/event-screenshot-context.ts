import type { IChartEventItem } from '@openpanel/validation';
import type { RouterInputs, RouterOutputs } from '@/trpc/client';

type ScreenshotContext = NonNullable<
  RouterInputs['chart']['events']['screenshotContexts']
>[number];
type ScreenshotFilter = NonNullable<ScreenshotContext['filters']>[number];
type ChartEvent = RouterOutputs['chart']['events'][number];
export type EventScreenshots = ChartEvent['screenshots'];
const MAX_EVENT_TABLE_SCREENSHOT_CONTEXTS = 50;
export const EVENT_SCREENSHOT_SIGNED_URL_REFRESH_MS = 8 * 60 * 1000;
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

export function buildEventTableScreenshotContextBatches(
  events: { name: string; createdAt: Date }[]
): ScreenshotContext[][] {
  const contexts = new Map<string, ScreenshotContext>();
  for (const event of events) {
    const milliseconds = event.createdAt.getTime();
    if (!(event.name && Number.isFinite(milliseconds))) {
      continue;
    }
    const context = buildEventDetailScreenshotContext(event.name, milliseconds);
    const key = `${event.name}\u0000${context.startDateMs}`;
    if (!contexts.has(key)) {
      contexts.set(key, context);
    }
  }
  const values = [...contexts.values()];
  const batches: ScreenshotContext[][] = [];
  for (
    let offset = 0;
    offset < values.length;
    offset += MAX_EVENT_TABLE_SCREENSHOT_CONTEXTS
  ) {
    batches.push(
      values.slice(offset, offset + MAX_EVENT_TABLE_SCREENSHOT_CONTEXTS)
    );
  }
  return batches;
}

function screenshotKey(
  screenshot: NonNullable<EventScreenshots>[number]
): string {
  return screenshot.captureId ?? screenshot.url;
}

function mergeEventScreenshots(
  current: EventScreenshots,
  incoming: EventScreenshots
): EventScreenshots {
  const screenshots = [...(current ?? [])];
  const keys = new Set(screenshots.map(screenshotKey));
  for (const screenshot of incoming ?? []) {
    const key = screenshotKey(screenshot);
    if (!keys.has(key)) {
      keys.add(key);
      screenshots.push(screenshot);
    }
  }
  screenshots.sort((a, b) => (b.capturedAtMs ?? 0) - (a.capturedAtMs ?? 0));
  return screenshots.length > 0 ? screenshots : undefined;
}

export function mergeEventScreenshotCatalogs(
  catalogs: (RouterOutputs['chart']['events'] | undefined)[]
): RouterOutputs['chart']['events'] {
  const events = new Map<string, ChartEvent>();
  for (const catalog of catalogs) {
    for (const event of catalog ?? []) {
      const existing = events.get(event.name);
      const screenshots = mergeEventScreenshots(
        existing?.screenshots,
        event.screenshots
      );
      events.set(
        event.name,
        screenshots
          ? ({ ...(existing ?? event), screenshots } as ChartEvent)
          : (existing ?? event)
      );
    }
  }
  return [...events.values()];
}

export function eventScreenshotsForUtcDay(
  catalog: RouterOutputs['chart']['events'] | undefined,
  eventName: string,
  milliseconds: number
): EventScreenshots {
  const screenshots = catalog?.find(
    (event) => event.name === eventName
  )?.screenshots;
  if (!(screenshots?.length && Number.isFinite(milliseconds))) {
    return undefined;
  }
  const { startDateMs, endDateMs } = utcDayScreenshotRange(milliseconds);
  return screenshots.filter(
    (screenshot) =>
      screenshot.capturedAtMs !== undefined &&
      screenshot.capturedAtMs >= startDateMs &&
      screenshot.capturedAtMs <= endDateMs
  );
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
