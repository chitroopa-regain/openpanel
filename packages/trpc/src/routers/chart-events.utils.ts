import { z } from 'zod';

const SCREENSHOT_LOOKUP_TIMEOUT_MS = 2000;
const TRAILING_SLASHES = /\/+$/;
const MAX_SCREENSHOTS_PER_EVENT = 5;
const MAX_EVENT_NAMES_PER_LOOKUP = 100;
const MAX_CONTEXT_REQUESTS = 20;
const MAX_TOTAL_CONTEXT_REQUESTS = 100;
const REGAIN_SCREENSHOT_ORIGINS = new Set([
  'https://api.regainapp.ai',
  'https://staging.regainapp.ai',
]);
const PROFILE_PROPERTIES_PREFIX = /^(?:profile|user)\.properties\./;
const EVENT_PROPERTIES_PREFIX = /^properties\./;
const PROFILE_PREFIX = /^(?:profile|user)\./;
const jsonScalarSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);
const propertiesSchema = z.record(z.string(), z.unknown());

const screenshotVariantSchema = z.object({
  screenshot_url: z.string().min(1),
  capture_id: z.string().optional().nullable(),
  captured_at_ms: z.union([z.string(), z.number()]).optional().nullable(),
  app_package: z.string().optional().nullable(),
  app_version: z.string().optional().nullable(),
  properties: propertiesSchema.optional().nullable(),
  event_properties: propertiesSchema.optional().nullable(),
  user_properties: propertiesSchema.optional().nullable(),
  original_event_properties_json: z
    .union([z.string(), propertiesSchema])
    .optional()
    .nullable(),
});

const flatScreenshotSchema = screenshotVariantSchema.extend({
  original_event_name: z.string().min(1),
});
const nestedEventSchema = z.object({
  event_name: z.string().min(1),
  variants: z.array(screenshotVariantSchema),
});
const screenshotLookupResponseSchema = z.union([
  z.array(flatScreenshotSchema),
  z.object({ screenshots: z.array(flatScreenshotSchema) }),
  z.object({ event_screenshots: z.array(flatScreenshotSchema) }),
  z.object({ events: z.array(nestedEventSchema) }),
]);

export const screenshotMatchFilterSchema = z.object({
  property: z.string().min(1),
  scope: z.enum(['event', 'user']),
  values: z.array(jsonScalarSchema).min(1),
});

export const screenshotMatchContextSchema = z.object({
  eventName: z.string().min(1),
  filters: z.array(screenshotMatchFilterSchema).default([]),
  breakdown: screenshotMatchFilterSchema.optional(),
  startDateMs: z.number().finite().optional(),
  endDateMs: z.number().finite().optional(),
  matchable: z.boolean().optional(),
});

export type ScreenshotMatchContext = z.infer<
  typeof screenshotMatchContextSchema
>;

export interface EventScreenshot {
  url: string;
  captureId?: string;
  capturedAtMs?: number;
  appPackage?: string;
  appVersion?: string;
  eventProperties: Record<string, unknown>;
  userProperties: Record<string, unknown>;
}

export function getMissingScreenshotContextEventNames(
  contexts: ScreenshotMatchContext[],
  representedEventNames: Iterable<string>
) {
  const represented = new Set(representedEventNames);
  return [...new Set(contexts.map((context) => context.eventName))].filter(
    (eventName) => !represented.has(eventName)
  );
}

function hasAllowedScreenshotPath(url: URL) {
  return url.pathname.startsWith('/event_screenshots/');
}

export function getAllowedEventScreenshotUrl(value: string) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      !REGAIN_SCREENSHOT_ORIGINS.has(url.origin) ||
      !hasAllowedScreenshotPath(url)
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function optionalString(value: string | null | undefined) {
  return value || undefined;
}

function parseProperties(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function normalizeResponse(value: unknown) {
  const parsed = screenshotLookupResponseSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  if (Array.isArray(parsed.data)) {
    return parsed.data;
  }
  if ('events' in parsed.data) {
    return parsed.data.events.flatMap((event) =>
      event.variants.map((variant) => ({
        ...variant,
        original_event_name: event.event_name,
      }))
    );
  }
  return 'screenshots' in parsed.data
    ? parsed.data.screenshots
    : parsed.data.event_screenshots;
}

function propertyValue(
  properties: Record<string, unknown>,
  property: string
): unknown {
  if (Object.hasOwn(properties, property)) {
    return properties[property];
  }
  const normalized = property
    .replace(PROFILE_PROPERTIES_PREFIX, '')
    .replace(EVENT_PROPERTIES_PREFIX, '')
    .replace(PROFILE_PREFIX, '');
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

function normalizedPropertyName(property: string) {
  return property
    .replace(PROFILE_PROPERTIES_PREFIX, '')
    .replace(EVENT_PROPERTIES_PREFIX, '')
    .replace(PROFILE_PREFIX, '');
}

function utcDate(milliseconds?: number) {
  return milliseconds === undefined
    ? undefined
    : new Date(milliseconds).toISOString().slice(0, 10);
}

function requestsForContext(context: ScreenshotMatchContext) {
  if (context.matchable === false) {
    return [];
  }
  const filters = [
    ...context.filters,
    ...(context.breakdown ? [context.breakdown] : []),
  ];
  if (filters.some((filter) => filter.values.length === 0)) {
    return null;
  }
  let requests = [
    {
      event_names: [context.eventName],
      report_start_date: utcDate(context.startDateMs),
      report_end_date: utcDate(context.endDateMs),
      event_property_filters: {} as Record<
        string,
        z.infer<typeof jsonScalarSchema>
      >,
      user_property_filters: {} as Record<
        string,
        z.infer<typeof jsonScalarSchema>
      >,
    },
  ];
  for (const filter of filters) {
    const property = normalizedPropertyName(filter.property);
    const expanded = requests.flatMap((request) =>
      filter.values.map((value) => ({
        ...request,
        event_property_filters:
          filter.scope === 'event'
            ? { ...request.event_property_filters, [property]: value }
            : request.event_property_filters,
        user_property_filters:
          filter.scope === 'user'
            ? { ...request.user_property_filters, [property]: value }
            : request.user_property_filters,
      }))
    );
    if (expanded.length > MAX_CONTEXT_REQUESTS) {
      return [];
    }
    requests = expanded;
  }
  return requests.map((request) => ({
    event_names: request.event_names,
    report_start_date: request.report_start_date,
    report_end_date: request.report_end_date,
    event_property_filters:
      Object.keys(request.event_property_filters).length > 0
        ? request.event_property_filters
        : undefined,
    user_property_filters:
      Object.keys(request.user_property_filters).length > 0
        ? request.user_property_filters
        : undefined,
  }));
}

function scalarEquals(
  actual: unknown,
  expected: z.infer<typeof jsonScalarSchema>
) {
  return actual === expected;
}

export function selectEventScreenshotSamples(
  samples: EventScreenshot[],
  context?: Omit<ScreenshotMatchContext, 'eventName'>
) {
  const sorted = [...samples].sort(
    (left, right) =>
      (right.capturedAtMs ?? Number.NEGATIVE_INFINITY) -
      (left.capturedAtMs ?? Number.NEGATIVE_INFINITY)
  );
  if (!context) {
    return sorted.slice(0, MAX_SCREENSHOTS_PER_EVENT);
  }

  const filters = context.breakdown
    ? [...context.filters, context.breakdown]
    : context.filters;
  return sorted
    .filter((sample) => {
      if (
        context.startDateMs !== undefined &&
        (sample.capturedAtMs === undefined ||
          sample.capturedAtMs < context.startDateMs)
      ) {
        return false;
      }
      if (
        context.endDateMs !== undefined &&
        (sample.capturedAtMs === undefined ||
          sample.capturedAtMs > context.endDateMs)
      ) {
        return false;
      }
      return filters.every((filter) => {
        const properties =
          filter.scope === 'user'
            ? sample.userProperties
            : sample.eventProperties;
        const actual = propertyValue(properties, filter.property);
        return filter.values.some((expected) => scalarEquals(actual, expected));
      });
    })
    .slice(0, MAX_SCREENSHOTS_PER_EVENT);
}

function selectEventScreenshotSamplesForContexts(
  samples: EventScreenshot[],
  contexts: Omit<ScreenshotMatchContext, 'eventName'>[]
) {
  if (contexts.length === 0) {
    return selectEventScreenshotSamples(samples);
  }
  return [...samples]
    .sort(
      (left, right) =>
        (right.capturedAtMs ?? Number.NEGATIVE_INFINITY) -
        (left.capturedAtMs ?? Number.NEGATIVE_INFINITY)
    )
    .filter((sample) =>
      contexts.some(
        (context) =>
          context.matchable !== false &&
          selectEventScreenshotSamples([sample], context).length > 0
      )
    )
    .slice(0, MAX_SCREENSHOTS_PER_EVENT);
}

export function indexEventScreenshots(
  value: unknown,
  contexts: ScreenshotMatchContext[] = []
) {
  const rows = normalizeResponse(value);
  const screenshots = new Map<string, EventScreenshot[]>();
  if (!rows) {
    return screenshots;
  }

  for (const row of rows) {
    const url = getAllowedEventScreenshotUrl(row.screenshot_url);
    if (!url) {
      continue;
    }
    const capturedAtMs = Number(row.captured_at_ms);
    const screenshot: EventScreenshot = {
      url,
      captureId: optionalString(row.capture_id),
      capturedAtMs:
        row.captured_at_ms !== undefined &&
        row.captured_at_ms !== null &&
        Number.isFinite(capturedAtMs)
          ? capturedAtMs
          : undefined,
      appPackage: optionalString(row.app_package),
      appVersion: optionalString(row.app_version),
      eventProperties: parseProperties(
        row.event_properties ??
          row.properties ??
          row.original_event_properties_json
      ),
      userProperties: parseProperties(row.user_properties),
    };
    const existing = screenshots.get(row.original_event_name) ?? [];
    const duplicate = existing.some((item) =>
      screenshot.captureId
        ? item.captureId === screenshot.captureId
        : !item.captureId && item.url === screenshot.url
    );
    if (!duplicate) {
      existing.push(screenshot);
    }
    screenshots.set(row.original_event_name, existing);
  }

  const contextsByEvent = new Map<string, ScreenshotMatchContext[]>();
  for (const context of contexts) {
    const existing = contextsByEvent.get(context.eventName) ?? [];
    existing.push(context);
    contextsByEvent.set(context.eventName, existing);
  }
  for (const [eventName, samples] of screenshots) {
    screenshots.set(
      eventName,
      selectEventScreenshotSamplesForContexts(
        samples,
        contextsByEvent.get(eventName) ?? []
      )
    );
  }
  return screenshots;
}

export async function fetchEventScreenshots(
  eventNames: string[],
  contexts: ScreenshotMatchContext[] = [],
  options: {
    metadataUrl?: string;
    readToken?: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {}
) {
  const metadataUrl =
    options.metadataUrl ?? process.env.EVENT_SCREENSHOT_METADATA_URL;
  const readToken =
    options.readToken ?? process.env.EVENT_SCREENSHOT_READ_TOKEN;
  if (!(metadataUrl && readToken && eventNames.length)) {
    return new Map<string, EventScreenshot[]>();
  }

  const uniqueEventNames = [...new Set(eventNames)];
  const contextualEventNames = new Set(
    contexts.map((context) => context.eventName)
  );
  const plainEventNames = uniqueEventNames.filter(
    (name) => !contextualEventNames.has(name)
  );
  const requests: Record<string, unknown>[] = [];
  for (
    let offset = 0;
    offset < plainEventNames.length;
    offset += MAX_EVENT_NAMES_PER_LOOKUP
  ) {
    requests.push({
      event_names: plainEventNames.slice(
        offset,
        offset + MAX_EVENT_NAMES_PER_LOOKUP
      ),
    });
  }
  let contextRequestCount = 0;
  for (const context of contexts) {
    const contextRequests = requestsForContext(context) ?? [];
    if (
      contextRequestCount + contextRequests.length >
      MAX_TOTAL_CONTEXT_REQUESTS
    ) {
      continue;
    }
    requests.push(...contextRequests);
    contextRequestCount += contextRequests.length;
  }
  if (requests.length === 0) {
    return new Map<string, EventScreenshot[]>();
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? SCREENSHOT_LOOKUP_TIMEOUT_MS
  );

  try {
    const responses = await Promise.allSettled(
      requests.map((request) =>
        (options.fetchImpl ?? fetch)(
          `${metadataUrl.replace(TRAILING_SLASHES, '')}/event_screenshots/internal/lookup`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Event-Screenshot-Token': readToken,
            },
            body: JSON.stringify(request),
            signal: controller.signal,
          }
        )
      )
    );
    const payloads = await Promise.allSettled(
      responses.flatMap((response) =>
        response.status === 'fulfilled' && response.value.ok
          ? [response.value.json()]
          : []
      )
    );
    const rows = payloads.flatMap((payload) =>
      payload.status === 'fulfilled'
        ? (normalizeResponse(payload.value) ?? [])
        : []
    );
    return indexEventScreenshots(rows, contexts);
  } catch (error) {
    console.warn('chart.events: screenshot metadata lookup failed', error);
    return new Map<string, EventScreenshot[]>();
  } finally {
    clearTimeout(timeout);
  }
}
