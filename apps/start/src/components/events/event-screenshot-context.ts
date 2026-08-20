import type { IChartEventItem, IChartSerie } from '@openpanel/validation';
import type { RouterInputs, RouterOutputs } from '@/trpc/client';

type ScreenshotContext = NonNullable<
  RouterInputs['chart']['events']['screenshotContexts']
>[number];
type ScreenshotFilter = NonNullable<ScreenshotContext['filters']>[number];
type ChartEvent = RouterOutputs['chart']['events'][number];
export type EventScreenshots = ChartEvent['screenshots'];
export const MAX_SCREENSHOT_CONTEXTS_PER_QUERY = 50;
export const EVENT_SCREENSHOT_SIGNED_URL_REFRESH_MS = 8 * 60 * 1000;
const USER_PROPERTY_PREFIX = /^(?:profile|user)(?:\.|$)/;
const PROFILE_PROPERTIES_PREFIX = /^(?:profile|user)\.properties\./;
const EVENT_PROPERTIES_PREFIX = /^properties\./;
const PROFILE_PREFIX = /^(?:profile|user)\./;

interface BreakdownValueContext {
  eventName: string;
  property: string;
  value: string | number | boolean | null;
}

export interface BreakdownScreenshotTarget {
  serieId: string;
  eventName: string;
  context: ScreenshotContext;
}

interface FunnelBreakdownRow {
  id: string;
  breakdowns?: string[] | null;
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
    offset += MAX_SCREENSHOT_CONTEXTS_PER_QUERY
  ) {
    batches.push(
      values.slice(offset, offset + MAX_SCREENSHOT_CONTEXTS_PER_QUERY)
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

export function buildBreakdownScreenshotTargets({
  chartSeries,
  reportSeries,
  startDate,
  endDate,
}: {
  chartSeries: IChartSerie[];
  reportSeries: IChartEventItem[];
  startDate?: string | null;
  endDate?: string | null;
}): BreakdownScreenshotTarget[] {
  return chartSeries.flatMap((chartSerie) => {
    const breakdownEntries = Object.entries(chartSerie.event.breakdowns ?? {});
    if (chartSerie.serieType !== 'event' || breakdownEntries.length === 0) {
      return [];
    }

    const reportSerie = chartSerie.event.id
      ? reportSeries.find(
          (item) => item.type === 'event' && item.id === chartSerie.event.id
        )
      : (() => {
          const nameMatches = reportSeries.filter(
            (item) =>
              item.type === 'event' && item.name === chartSerie.event.name
          );
          return nameMatches.length === 1 ? nameMatches[0] : undefined;
        })();
    if (!reportSerie || reportSerie.type !== 'event') {
      return [];
    }

    const [primaryBreakdown, ...additionalBreakdownEntries] = breakdownEntries;
    if (!primaryBreakdown) {
      return [];
    }
    const [context] = buildScreenshotContexts({
      series: [{ ...reportSerie, name: chartSerie.event.name }],
      startDate,
      endDate,
      breakdownValue: {
        eventName: chartSerie.event.name,
        property: primaryBreakdown[0],
        value: primaryBreakdown[1],
      },
    });
    if (!context) {
      return [];
    }

    const additionalBreakdowns = additionalBreakdownEntries.map(
      ([property, value]) => ({
        property,
        scope: propertyScope(property),
        values: [value],
      })
    );

    return [
      {
        serieId: chartSerie.id,
        eventName: chartSerie.event.name,
        context: {
          ...context,
          filters: [...(context.filters ?? []), ...additionalBreakdowns],
        },
      },
    ];
  });
}

export function buildFunnelBreakdownScreenshotTargets({
  rows,
  reportSeries,
  breakdownProperties,
  breakdownStep = 0,
  startDate,
  endDate,
}: {
  rows: FunnelBreakdownRow[];
  reportSeries: IChartEventItem[];
  breakdownProperties: string[];
  breakdownStep?: number;
  startDate?: string | null;
  endDate?: string | null;
}): BreakdownScreenshotTarget[] {
  const reportSerie = reportSeries[breakdownStep];
  if (
    !reportSerie ||
    reportSerie.type !== 'event' ||
    breakdownProperties.length === 0
  ) {
    return [];
  }
  return rows.flatMap((row) => {
    const values: Array<string | null> =
      row.breakdowns && row.breakdowns.length > 0
        ? row.breakdowns
        : breakdownProperties.map(() => null);
    if (values.length !== breakdownProperties.length) {
      return [];
    }
    const primaryProperty = breakdownProperties[0];
    const primaryValue = values[0];
    if (primaryProperty === undefined || primaryValue === undefined) {
      return [];
    }
    const [baseContext] = buildScreenshotContexts({
      series: [reportSerie],
      startDate,
      endDate,
      breakdownValue: {
        eventName: reportSerie.name,
        property: primaryProperty,
        value: primaryValue,
      },
    });
    if (!baseContext) {
      return [];
    }
    const additionalBreakdownProperties = breakdownProperties.slice(1);
    const additionalBreakdowns = additionalBreakdownProperties.flatMap(
      (property, index) => {
        const value = values[index + 1];
        return value === undefined
          ? []
          : [
              {
                property,
                scope: propertyScope(property),
                values: [value],
              },
            ];
      }
    );
    return [
      {
        serieId: row.id,
        eventName: baseContext.eventName,
        context: {
          ...baseContext,
          filters: [...(baseContext.filters ?? []), ...additionalBreakdowns],
        },
      },
    ];
  });
}

export function buildBreakdownScreenshotContextBatches(
  targets: BreakdownScreenshotTarget[]
): ScreenshotContext[][] {
  const batches: ScreenshotContext[][] = [];
  for (
    let offset = 0;
    offset < targets.length;
    offset += MAX_SCREENSHOT_CONTEXTS_PER_QUERY
  ) {
    batches.push(
      targets
        .slice(offset, offset + MAX_SCREENSHOT_CONTEXTS_PER_QUERY)
        .map((target) => target.context)
    );
  }
  return batches;
}

function screenshotPropertyValue(
  properties: Record<string, unknown>,
  property: string
): unknown {
  const normalized = property
    .replace(PROFILE_PROPERTIES_PREFIX, '')
    .replace(EVENT_PROPERTIES_PREFIX, '')
    .replace(PROFILE_PREFIX, '');
  if (Object.hasOwn(properties, property)) {
    return properties[property];
  }
  if (Object.hasOwn(properties, normalized)) {
    return properties[normalized];
  }
  return normalized.split('.').reduce<unknown>((current, part) => {
    if (!(current && typeof current === 'object' && !Array.isArray(current))) {
      return undefined;
    }
    return (current as Record<string, unknown>)[part];
  }, properties);
}

export function eventScreenshotsForContext(
  catalog: RouterOutputs['chart']['events'] | undefined,
  context: ScreenshotContext
): EventScreenshots {
  if (context.matchable === false) {
    return undefined;
  }
  const screenshots = catalog?.find(
    (event) => event.name === context.eventName
  )?.screenshots;
  if (!screenshots?.length) {
    return undefined;
  }
  const filters = context.breakdown
    ? [...(context.filters ?? []), context.breakdown]
    : (context.filters ?? []);
  const matches = screenshots.filter((screenshot) => {
    if (
      context.startDateMs !== undefined &&
      (screenshot.capturedAtMs === undefined ||
        screenshot.capturedAtMs < context.startDateMs)
    ) {
      return false;
    }
    if (
      context.endDateMs !== undefined &&
      (screenshot.capturedAtMs === undefined ||
        screenshot.capturedAtMs > context.endDateMs)
    ) {
      return false;
    }
    return filters.every((filter) => {
      const properties =
        filter.scope === 'user'
          ? screenshot.userProperties
          : screenshot.eventProperties;
      const actual = screenshotPropertyValue(properties, filter.property);
      return filter.values.some(
        (expected) =>
          actual === expected || (expected === null && actual === undefined)
      );
    });
  });
  return matches.length > 0 ? matches : undefined;
}
