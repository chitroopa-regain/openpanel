import { round } from '@openpanel/common';
import {
  AggregateChartEngine,
  ChartEngine,
  ch,
  chQuery,
  clix,
  conversionService,
  createSqlBuilder,
  db,
  formatClickhouseDate,
  funnelService,
  getChartPrevStartEndDate,
  getChartStartEndDate,
  getCustomEventWhereClause,
  getEventFiltersWhereClause,
  getEventMetasCached,
  getProfilesCached,
  getProfilesForUserListCached,
  getProfileTraitsKeysCached,
  getReportById,
  getSelectPropertyKey,
  getSettingsForProject,
  getTraitBreakdownDescriptor,
  type IClickhouseProfile,
  type IServiceProfile,
  onlyReportEvents,
  qualifyFunnelCondition,
  resolveAudience,
  resolveSeriesForFunnel,
  sankeyService,
  TABLE_NAMES,
  type TraitBreakdown,
  validateShareAccess,
} from '@openpanel/db';
import {
  type IChartBreakdown,
  type IChartEventFilter,
  type ICustomEventComponent,
  zChartBreakdowns,
  zChartEventFilter,
  zChartSeries,
  zCriteria,
  zCohortBreakdown,
  zDateConfig,
  zReportAudience,
  zRange,
  zReportInput,
  zRetentionBreakdownSort,
  zRetentionMeasure,
  zRetentionTimeUnit,
  zTimeInterval,
} from '@openpanel/validation';
import {
  differenceInDays,
  differenceInMonths,
  differenceInWeeks,
  formatISO,
} from 'date-fns';
import { flatten, map, pipe, prop, range, sort, uniq } from 'ramda';
import sqlstring from 'sqlstring';
import { z } from 'zod';
import { getProjectAccess } from '../access';
import { getReportFreshness } from '../cache-freshness';
import { TRPCAccessError } from '../errors';
import {
  cacheMiddleware,
  createTRPCRouter,
  protectedProcedure,
  publicProcedure,
} from '../trpc';
import { buildEventNamesQuery } from './chart-event-names.utils';
import type { EventScreenshot } from './chart-events.utils';
import {
  fetchEventScreenshots,
  getMissingScreenshotContextEventNames,
  getScreenshotLookupEventNames,
  screenshotMatchContextSchema,
} from './chart-events.utils';
import { getChartPropertiesQueryScopes } from './chart-properties.utils';
import {
  aggregateRetentionRowsByDisplayInterval,
  buildRetentionBreakdownSelects,
  buildRetentionFirstTimeCteSql,
  buildRetentionMeasureIntervalSelect,
  getConcreteEventNameWhereClause,
  getRetentionElapsedIntervalExpression,
  getRetentionIntervalMaturityExpression,
  getRetentionMeasurePropertyExpression,
  getRetentionReturnEventWhereClause,
  getRetentionTimeUnitConfig,
  groupRetentionRowsByBreakdowns,
  isRetentionPropertyMeasure,
  type RawRetentionCohortRow,
} from './chart-retention.utils';

function utc(date: string | Date) {
  if (typeof date === 'string') {
    return date.replace('T', ' ').slice(0, 19);
  }
  return formatISO(date).replace('T', ' ').slice(0, 19);
}

/**
 * These query paths do not apply a cohort breakdown. Accepting the field and
 * ignoring it would return an unsplit series while the caller believes it asked
 * for one — wrong, and invisible. Persistence already rejects the combination;
 * this closes the same hole at the query boundary, where an ad-hoc API request
 * (or a stale client) can arrive with the field set.
 */
/**
 * Middleware form, so the check runs BEFORE `cacher`. As a resolver statement it
 * was skipped entirely on a cache hit, meaning a previously cached unsplit
 * result — most plausibly a legacy saved report keyed only by id — would still
 * be served silently. Ordering matters more than the check itself here.
 */
const guardNoCohortBreakdown =
  (path: string) =>
  async ({ ctx, next, getRawInput }: any) => {
    const rawInput = (await getRawInput()) as
      | { cohortBreakdown?: { cohortIds?: string[] } | null }
      | undefined;
    assertNoCohortBreakdown([rawInput, ctx?.report], path);
    return next();
  };

function assertNoCohortBreakdown(
  sources: Array<{ cohortBreakdown?: { cohortIds?: string[] } | null } | null | undefined>,
  path: string,
) {
  // Check the EFFECTIVE report, not just the raw input. These handlers can load
  // a saved report from ctx.report, so a caller passing only `{ id }` for a
  // report that already carries a cohortBreakdown (one created before the write
  // path started rejecting the combination) would otherwise get an unsplit
  // series with no error.
  for (const source of sources) {
    if ((source?.cohortBreakdown?.cohortIds?.length ?? 0) > 0) {
      throw new Error(`A cohort breakdown is not supported on ${path} reports.`);
    }
  }
}

const cacher = cacheMiddleware(getReportFreshness);

type FunnelPropertyStats = { sum: number; average: number; count: number };
type FunnelSeriesLike = {
  id: string;
  steps?: Array<{ count?: number }>;
  lastStep: Record<string, unknown> & {
    propertySum?: number;
    propertyAverage?: number;
    propertyCount?: number;
  };
};

export function getFunnelPropertyAveragePerStarter(
  sum: number,
  firstStepCount?: number
) {
  if (!firstStepCount || firstStepCount <= 0) {
    return 0;
  }
  return sum / firstStepCount;
}

export function attachFunnelPropertyStatsToSeries(
  series: FunnelSeriesLike[],
  statsByBreakdown: Map<string, FunnelPropertyStats> | null | undefined
) {
  for (const item of series) {
    const key = item.id === 'none' ? 'none' : item.id;
    const stats = statsByBreakdown?.get(key) ?? {
      sum: 0,
      average: 0,
      count: 0,
    };
    const firstStepCount = item.steps?.[0]?.count;
    item.lastStep.propertySum = stats.sum;
    // Funnel property average is intentionally ARPU-style: total property
    // value divided by the users entering this breakdown's funnel, not by
    // converted users only. This makes purchase value experiments comparable.
    item.lastStep.propertyAverage = getFunnelPropertyAveragePerStarter(
      stats.sum,
      firstStepCount
    );
    item.lastStep.propertyCount = stats.count;
  }
}

const chartProcedure = publicProcedure.use(
  async ({ ctx, next, getRawInput }) => {
    const rawInput = (await getRawInput()) as {
      projectId: string;
      shareId?: string;
      id?: string;
    };

    if (rawInput.shareId) {
      // Require reportId when shareId provided
      if (!rawInput.id) {
        throw new Error('reportId required with shareId');
      }

      // Validate share access
      const shareValidation = await validateShareAccess(
        rawInput.shareId,
        rawInput.id,
        {
          cookies: ctx.cookies,
          session: ctx.session?.userId
            ? { userId: ctx.session.userId }
            : undefined,
        }
      );
      if (!shareValidation.isValid) {
        throw TRPCAccessError('You do not have access to this share');
      }

      // Fetch report
      const report = await getReportById(rawInput.id);
      if (!report) {
        throw TRPCAccessError('Report not found');
      }

      return next({
        ctx: {
          report,
        },
      });
    }

    // Regular member access check
    if (!ctx.session?.userId) {
      throw TRPCAccessError('Authentication required');
    }
    const access = await getProjectAccess({
      projectId: rawInput.projectId,
      userId: ctx.session.userId,
    });
    if (!access) {
      throw TRPCAccessError('You do not have access to this project');
    }

    return next({
      ctx: {
        report: null,
      },
    });
  }
);

export const chartRouter = createTRPCRouter({
  projectCard: protectedProcedure
    .use(cacheMiddleware(60 * 5))
    .input(
      z.object({
        projectId: z.string(),
      })
    )
    .query(async ({ input: { projectId } }) => {
      const { timezone } = await getSettingsForProject(projectId);
      const chartPromise = chQuery<{
        value: number;
        date: Date;
        revenue: number;
      }>(
        `SELECT
            uniqHLL12(profile_id) as value,
            toStartOfDay(created_at) as date,
            sum(revenue * sign) as revenue
        FROM ${TABLE_NAMES.sessions}
        WHERE 
            project_id = ${sqlstring.escape(projectId)} AND 
            created_at >= now() - interval '3 month'
        GROUP BY date
        ORDER BY date ASC
        WITH FILL FROM toStartOfDay(now() - interval '1 month') 
        TO toStartOfDay(now()) 
        STEP INTERVAL 1 day
        SETTINGS session_timezone = '${timezone}'
      `
      );

      const metricsPromise = clix(ch, timezone)
        .select<{
          months_3: number;
          months_3_prev: number;
          month: number;
          day: number;
          day_prev: number;
          revenue: number;
        }>([
          'uniqHLL12(if(created_at >= (now() - toIntervalMonth(3)), profile_id, null)) AS months_3',
          'uniqHLL12(if(created_at >= (now() - toIntervalMonth(6)) AND created_at < (now() - toIntervalMonth(3)), profile_id, null)) AS months_3_prev',
          'uniqHLL12(if(created_at >= (now() - toIntervalMonth(1)), profile_id, null)) AS month',
          'uniqHLL12(if(created_at >= (now() - toIntervalDay(1)), profile_id, null)) AS day',
          'uniqHLL12(if(created_at >= (now() - toIntervalDay(2)) AND created_at < (now() - toIntervalDay(1)), profile_id, null)) AS day_prev',
          'sum(revenue * sign) as revenue',
        ])
        .from(TABLE_NAMES.sessions)
        .where('project_id', '=', projectId)
        .where('created_at', '>=', clix.exp('now() - toIntervalMonth(6)'))
        .execute();

      const [chart, [metrics]] = await Promise.all([
        chartPromise,
        metricsPromise,
      ]);

      const change =
        metrics && metrics.months_3_prev > 0 && metrics.months_3 > 0
          ? Math.round(
              ((metrics.months_3 - metrics.months_3_prev) /
                metrics.months_3_prev) *
                100
            )
          : null;

      const trend =
        change === null
          ? { direction: 'neutral' as const, percentage: null as number | null }
          : change > 0
            ? { direction: 'up' as const, percentage: change }
            : change < 0
              ? { direction: 'down' as const, percentage: Math.abs(change) }
              : { direction: 'neutral' as const, percentage: 0 };

      return {
        chart: chart.map((d) => ({ ...d, date: new Date(d.date) })),
        metrics,
        trend,
      };
    }),

  // Screenshot URLs are short-lived capabilities. Do not put this array in the
  // server SWR cache: top-level arrays cannot carry cache-staleness metadata and
  // would continue returning expired image URLs from the hard cache.
  events: chartProcedure
    .input(
      z.object({
        projectId: z.string(),
        includeDropped: z.boolean().default(false),
        screenshotContexts: z
          .array(screenshotMatchContextSchema)
          .max(50)
          .default([]),
      })
    )
    .query(
      async ({ input: { projectId, includeDropped, screenshotContexts } }) => {
        const PROTECTED_EVENTS = [
          'session_start',
          'session_end',
          'screen_view',
        ];

        const [events, meta, customEvents] = await Promise.all([
          chQuery<{ name: string; count: number }>(
            buildEventNamesQuery(projectId, TABLE_NAMES.event_names_mv)
          ),
          getEventMetasCached(projectId),
          db.customEvent.findMany({ where: { projectId } }).catch((error) => {
            console.warn(
              'chart.events: failed to load custom events, falling back to event_names_mv only',
              error
            );
            return [];
          }),
        ]);
        // Event selectors only need the catalog. Screenshot-bearing surfaces
        // issue focused context queries for visible events separately. Looking
        // up every catalog event here adds a two-second metadata timeout to
        // every selector search in large projects.
        const screenshotEventNames =
          getScreenshotLookupEventNames(screenshotContexts);
        const screenshots =
          process.env.EVENT_SCREENSHOT_PROJECT_ID === projectId
            ? await fetchEventScreenshots(
                screenshotEventNames,
                screenshotContexts
              )
            : new Map<string, EventScreenshot[]>();

        // Build ClickHouse-present events with metadata
        const activeEvents = events.map((event) => {
          const eventMeta = meta.find((m) => m.name === event.name);
          return {
            name: event.name,
            count: event.count,
            meta: eventMeta,
            isCustomEvent: false as const,
            customEventId: undefined as string | undefined,
            isProtected: PROTECTED_EVENTS.includes(event.name),
            droppedAt: eventMeta?.droppedAt ?? null,
            clearedAt: eventMeta?.clearedAt ?? null,
            screenshots: screenshots.get(event.name),
            screenshotContextRequested: screenshotContexts.some(
              (context) => context.eventName === event.name
            ),
          };
        });
        const contextOnlyEvents = (representedEventNames: Iterable<string>) =>
          getMissingScreenshotContextEventNames(
            screenshotContexts,
            representedEventNames
          ).map((name) => {
            const eventMeta = meta.find((item) => item.name === name);
            return {
              name,
              count: 0,
              meta: eventMeta,
              isCustomEvent: false as const,
              customEventId: undefined as string | undefined,
              isProtected: PROTECTED_EVENTS.includes(name),
              droppedAt: eventMeta?.droppedAt ?? null,
              clearedAt: eventMeta?.clearedAt ?? null,
              screenshots: screenshots.get(name),
              screenshotContextRequested: true,
            };
          });

        if (!includeDropped) {
          // Default: return only active (non-dropped) events for normal consumers
          const activeOnly = activeEvents.filter((e) => !e.droppedAt);
          return [
            {
              name: '*',
              count: events.reduce((acc, event) => acc + event.count, 0),
              meta: undefined,
              isCustomEvent: false as const,
              customEventId: undefined as string | undefined,
              isProtected: false,
              droppedAt: null as Date | null,
              clearedAt: null as Date | null,
              screenshots: undefined,
            },
            ...customEvents.map((ce) => ({
              name: ce.name,
              count: 0,
              meta: {
                name: ce.name,
                color: ce.color,
                icon: ce.icon,
                conversion: false,
              },
              isCustomEvent: true as const,
              customEventId: ce.id,
              isProtected: false,
              droppedAt: null as Date | null,
              clearedAt: null as Date | null,
              screenshots: screenshots.get(ce.name),
            })),
            ...activeOnly,
            ...contextOnlyEvents([
              ...customEvents.map((event) => event.name),
              // Known dropped events remain represented here so the fallback
              // cannot reintroduce them into includeDropped=false results,
              // whether or not the ClickHouse event-name MV still has a row.
              ...activeEvents.map((event) => event.name),
              ...meta
                .filter((eventMeta) => eventMeta.droppedAt)
                .map((eventMeta) => eventMeta.name),
            ]),
          ];
        }

        // includeDropped=true: for EventDropManager settings UI
        const chEventNames = new Set(events.map((e) => e.name));
        const droppedNotInCh = meta
          .filter((m) => m.droppedAt && !chEventNames.has(m.name))
          .map((m) => ({
            name: m.name,
            count: 0,
            meta: m,
            isCustomEvent: false as const,
            customEventId: undefined as string | undefined,
            isProtected: PROTECTED_EVENTS.includes(m.name),
            droppedAt: m.droppedAt,
            clearedAt: m.clearedAt,
            screenshots: screenshots.get(m.name),
          }));

        const notDropped = activeEvents.filter((e) => !e.droppedAt);
        const dropped = activeEvents.filter((e) => e.droppedAt);
        notDropped.sort((a, b) => b.count - a.count);
        dropped.sort((a, b) => b.count - a.count);

        return [
          {
            name: '*',
            count: events.reduce((acc, event) => acc + event.count, 0),
            meta: undefined,
            isCustomEvent: false as const,
            customEventId: undefined as string | undefined,
            isProtected: false,
            droppedAt: null as Date | null,
            clearedAt: null as Date | null,
            screenshots: undefined,
          },
          ...customEvents.map((ce) => ({
            name: ce.name,
            count: 0,
            meta: {
              name: ce.name,
              color: ce.color,
              icon: ce.icon,
              conversion: false,
            },
            isCustomEvent: true as const,
            customEventId: ce.id,
            isProtected: false,
            droppedAt: null as Date | null,
            clearedAt: null as Date | null,
            screenshots: screenshots.get(ce.name),
          })),
          ...notDropped,
          ...dropped,
          ...droppedNotInCh,
          ...contextOnlyEvents([
            ...customEvents.map((event) => event.name),
            ...notDropped.map((event) => event.name),
            ...dropped.map((event) => event.name),
            ...droppedNotInCh.map((event) => event.name),
          ]),
        ];
      }
    ),

  properties: protectedProcedure
    .use(cacheMiddleware(60 * 5))
    .input(
      z.object({
        event: z.string().optional(),
        projectId: z.string(),
        customEventId: z.string().optional(),
        mode: z.enum(['events', 'profile']).optional(),
      })
    )
    .query(async ({ input: { projectId, event, customEventId, mode } }) => {
      const scopes = getChartPropertiesQueryScopes(mode);
      const profileProperties: string[] = [];

      if (scopes.profileProperties) {
        const profiles = await clix(ch, 'UTC')
          .select<Pick<IServiceProfile, 'properties'>>(['properties'])
          .from(TABLE_NAMES.profiles)
          .where('project_id', '=', projectId)
          .where('is_external', '=', true)
          .limit(10_000)
          .execute();

        profileProperties.push(
          ...new Set(
            profiles.flatMap((p) =>
              Object.keys(p.properties).map((k) => `profile.properties.${k}`)
            )
          )
        );

        // Also fetch trait keys from profile_traits table (cached)
        const traitKeys = await getProfileTraitsKeysCached(projectId);
        profileProperties.push(
          ...traitKeys.map((key) => `profile.properties.${key}`)
        );
      }

      // Resolve custom event to component event names for property filtering
      let propEventNames: string[] = [];
      if (customEventId) {
        const ce = await db.customEvent.findUnique({
          where: { id: customEventId },
        });
        if (ce && Array.isArray(ce.components)) {
          propEventNames = (ce.components as { eventName: string }[]).map(
            (c) => c.eventName
          );
        }
      }
      if (propEventNames.length === 0 && event && event !== '*') {
        propEventNames = [event];
      }

      const eventProperties: string[] = [];
      if (scopes.eventProperties) {
        const query = clix(ch)
          .select<{ property_key: string; created_at: string }>([
            'distinct property_key',
            'max(created_at) as created_at',
          ])
          .from(TABLE_NAMES.event_property_values_mv)
          .where('project_id', '=', projectId)
          .groupBy(['property_key'])
          .orderBy('length(property_key)', 'ASC')
          .orderBy('created_at', 'DESC')
          .limit(10_000);

        if (propEventNames.length === 1) {
          query.where('name', '=', propEventNames[0]!);
        } else if (propEventNames.length > 1) {
          query.where('name', 'IN', propEventNames);
        }

        const res = await query.execute();
        eventProperties.push(
          ...res.map((item) => {
            const key = item.property_key
              .replace(/\.([0-9]+)\./g, '.*.')
              .replace(/\.([0-9]+)/g, '[*]');
            return `properties.${key}`;
          })
        );
      }

      const fixedProperties = [
        'duration',
        'revenue',
        'has_profile',
        'path',
        'origin',
        'referrer',
        'referrer_name',
        'created_at',
        'country',
        'city',
        'region',
        'os',
        'os_version',
        'browser',
        'browser_version',
        'device',
        'brand',
        'model',
        'app_name',
        'app_version',
        'app_namespace',
        'app_build',
        'profile.id',
        'profile.first_name',
        'profile.last_name',
        'profile.email',
      ];

      const properties = [
        ...eventProperties,
        ...(event === '*' || !event ? ['name'] : []),
        ...fixedProperties,
        ...profileProperties,
      ];

      return pipe(
        sort<string>((a, b) => a.length - b.length),
        uniq
      )(properties);
    }),

  values: protectedProcedure
    .input(
      z.object({
        event: z.string(),
        property: z.string(),
        projectId: z.string(),
        customEventId: z.string().optional(),
      })
    )
    .query(
      async ({
        input: { event, property, projectId, customEventId, ...input },
      }) => {
        if (property === 'has_profile') {
          return {
            values: ['true', 'false'],
          };
        }

        // Resolve custom event to its component event names
        let eventNames: string[] = [];
        if (customEventId) {
          const ce = await db.customEvent.findUnique({
            where: { id: customEventId },
          });
          if (ce && Array.isArray(ce.components)) {
            eventNames = (ce.components as { eventName: string }[]).map(
              (c) => c.eventName
            );
          }
        }
        if (eventNames.length === 0 && event && event !== '*') {
          eventNames = [event];
        }

        const values: string[] = [];

        // profile.properties.* — query profile_traits for distinct latest values.
        // Both user traits and device/geo keys (country, os, brand, ...) are dual-written
        // to profile_traits by profile_manager.go, so a single fast path serves both.
        // The inner subquery picks each profile's latest value first, then deduplicates
        // at the SQL level — flat SELECT DISTINCT with LIMIT can cut off before reaching
        // all distinct values.
        if (property.startsWith('profile.properties.')) {
          const traitKey = property
            .replace('profile.properties.', '')
            .split('.')[0];
          if (traitKey) {
            const traitValues = await chQuery<{ value: string }>(
              `SELECT DISTINCT val as value FROM (SELECT argMax(value, updated_at) as val FROM ${TABLE_NAMES.profile_traits} WHERE project_id = ${sqlstring.escape(projectId)} AND key = ${sqlstring.escape(traitKey)} GROUP BY profile_id HAVING val != '') ORDER BY length(value), value LIMIT 1000`
            );
            return {
              values: traitValues.map((t) => t.value),
            };
          }
        }

        if (property.startsWith('properties.')) {
          const query = clix(ch)
            .select<{
              property_value: string;
              created_at: string;
            }>(['distinct property_value', 'max(created_at) as created_at'])
            .from(TABLE_NAMES.event_property_values_mv)
            .where('project_id', '=', projectId)
            .where('property_key', '=', property.replace(/^properties\./, ''))
            .groupBy(['property_value'])
            .orderBy('created_at', 'DESC');

          if (eventNames.length === 1) {
            query.where('name', '=', eventNames[0]!);
          } else if (eventNames.length > 1) {
            query.where('name', 'IN', eventNames);
          }

          const res = await query.execute();

          values.push(...res.map((e) => e.property_value));
        } else {
          const query = clix(ch)
            // DISTINCT already collapses the value set before the safety limit.
            // Sorting by created_at is undefined for a distinct-only result and
            // forces ClickHouse to add an unnecessary sort stage.
            .select<{ values: string[] }>([
              `distinct ${getSelectPropertyKey(property)} as values`,
            ])
            .from(TABLE_NAMES.events)
            .where('project_id', '=', projectId)
            .where('created_at', '>', clix.exp('now() - INTERVAL 30 DAY'))
            .limit(100_000);

          if (eventNames.length === 1) {
            query.where('name', '=', eventNames[0]!);
          } else if (eventNames.length > 1) {
            query.where('name', 'IN', eventNames);
          }

          if (property.startsWith('profile.')) {
            query.leftAnyJoin(
              clix(ch)
                .select<IClickhouseProfile>([])
                .from(TABLE_NAMES.profiles)
                .where('project_id', '=', projectId),
              'profile.id = profile_id',
              'profile'
            );
          }

          const events = await query.execute();

          values.push(
            ...pipe(
              (data: typeof events) => map(prop('values'), data),
              flatten,
              uniq,
              sort((a, b) => a.length - b.length)
            )(events)
          );
        }

        return {
          values,
        };
      }
    ),

  funnel: chartProcedure
    .use(guardNoCohortBreakdown('funnel'))
    .use(cacher)
    .input(
      zReportInput.and(
        z.object({
          shareId: z.string().optional(),
          id: z.string().optional(),
        })
      )
    )
    .query(async ({ input, ctx }) => {
      const chartInput = ctx.report
        ? {
            ...ctx.report,
            range: input.range ?? ctx.report.range,
            startDate: input.startDate ?? ctx.report.startDate,
            endDate: input.endDate ?? ctx.report.endDate,
            interval: input.interval ?? ctx.report.interval,
          }
        : input;

      const { timezone } = await getSettingsForProject(chartInput.projectId);
      const currentPeriod = getChartStartEndDate(chartInput, timezone);
      const previousPeriod = getChartPrevStartEndDate({
        ...currentPeriod,
        range: chartInput.range,
      });

      const [current, previous] = await Promise.all([
        funnelService.getFunnel({ ...chartInput, ...currentPeriod, timezone }),
        chartInput.previous
          ? funnelService.getFunnel({
              ...chartInput,
              ...previousPeriod,
              timezone,
            })
          : Promise.resolve(null),
      ]);

      // Funnel Metric: compute property sums for the last step
      const funnelOptions =
        chartInput.options?.type === 'funnel' ? chartInput.options : undefined;
      const funnelMeasure = funnelOptions?.funnelMeasure ?? 'conversion_rate';
      const funnelProperty = funnelOptions?.funnelProperty;
      const needsPropertyStats =
        !!funnelProperty &&
        (chartInput.chartType === 'funnel_metric' ||
          funnelMeasure === 'property_sum' ||
          funnelMeasure === 'property_average');
      if (needsPropertyStats && funnelProperty) {
        const eventSeries = await resolveSeriesForFunnel(
          chartInput.series,
          chartInput.projectId
        );
        const allEventNames = uniq(
          eventSeries.flatMap((e: any) =>
            e.customEventComponents
              ? e.customEventComponents.map((c: any) => c.eventName)
              : [e.name]
          )
        );
        const stepConditions = funnelService.getFunnelConditions(
          eventSeries,
          chartInput.projectId
        );

        const funnelWindowUnit = funnelOptions.funnelWindowUnit ?? 'hour';
        const unitMultipliers: Record<string, number> = {
          second: 1,
          minute: 60,
          hour: 3600,
          day: 86_400,
          week: 604_800,
          month: 2_592_000,
        };
        const defaultWindowByUnit: Record<string, number> = {
          second: 86_400,
          minute: 1440,
          hour: 24,
          day: 1,
          week: 1,
          month: 1,
        };
        const funnelWindow =
          funnelOptions.funnelWindow ??
          defaultWindowByUnit[funnelWindowUnit] ??
          24;
        const funnelWindowSeconds =
          funnelWindow * (unitMultipliers[funnelWindowUnit] ?? 3600);
        const group = funnelService.getFunnelGroup(funnelOptions.funnelGroup);

        const [currentStats, previousStats] = await Promise.all([
          funnelService.getFunnelPropertyStats({
            projectId: chartInput.projectId,
            startDate: currentPeriod.startDate!,
            endDate: currentPeriod.endDate!,
            stepConditions,
            funnelWindowSeconds,
            groupBy: group,
            allEventNames,
            propertyKey: funnelProperty,
            breakdowns: chartInput.breakdowns,
            breakdownStep: funnelOptions.breakdownStep,
            timezone,
          }),
          previous
            ? funnelService.getFunnelPropertyStats({
                projectId: chartInput.projectId,
                startDate: previousPeriod.startDate!,
                endDate: previousPeriod.endDate!,
                stepConditions,
                funnelWindowSeconds,
                groupBy: group,
                allEventNames,
                propertyKey: funnelProperty,
                breakdowns: chartInput.breakdowns,
                breakdownStep: funnelOptions.breakdownStep,
                timezone,
              })
            : Promise.resolve(null),
        ]);

        // Attach property aggregates to the last step of each series.
        // Property Average is ARPU-style: sum divided by step-1 users.
        attachFunnelPropertyStatsToSeries(current.data, currentStats);
        if (previous) {
          attachFunnelPropertyStatsToSeries(previous.data, previousStats);
        }
      }

      return {
        current: current.data,
        previous: previous?.data ?? null,
        queries: [...current.queries, ...(previous?.queries ?? [])],
        timezone,
      };
    }),

  conversion: chartProcedure
    .use(guardNoCohortBreakdown('conversion'))
    .use(cacher)
    .input(
      zReportInput.and(
        z.object({
          shareId: z.string().optional(),
          id: z.string().optional(),
        })
      )
    )
    .query(async ({ input, ctx }) => {
      const chartInput = ctx.report
        ? {
            ...ctx.report,
            range: input.range ?? ctx.report.range,
            startDate: input.startDate ?? ctx.report.startDate,
            endDate: input.endDate ?? ctx.report.endDate,
            interval: input.interval ?? ctx.report.interval,
          }
        : input;

      const { timezone } = await getSettingsForProject(chartInput.projectId);
      const currentPeriod = getChartStartEndDate(chartInput, timezone);
      const previousPeriod = getChartPrevStartEndDate({
        ...currentPeriod,
        range: chartInput.range,
      });

      const interval = chartInput.interval;

      const [current, previous] = await Promise.all([
        conversionService.getConversion({
          ...chartInput,
          ...currentPeriod,
          interval,
          timezone,
        }),
        chartInput.previous
          ? conversionService.getConversion({
              ...chartInput,
              ...previousPeriod,
              interval,
              timezone,
            })
          : Promise.resolve(null),
      ]);

      return {
        current: current.data.map((serie, sIndex) => ({
          ...serie,
          data: serie.data.map((d, dIndex) => ({
            ...d,
            previousRate: previous?.data?.[sIndex]?.data?.[dIndex]?.rate,
          })),
        })),
        previous: previous?.data ?? null,
        queries: [...current.queries, ...(previous?.queries ?? [])],
        timezone,
      };
    }),

  sankey: protectedProcedure
    .use(guardNoCohortBreakdown('sankey'))
    .use(cacher)
    .input(zReportInput)
    .query(async ({ input }) => {
      const { timezone } = await getSettingsForProject(input.projectId);
      const currentPeriod = getChartStartEndDate(input, timezone);

      // Extract sankey options
      const options = input.options;

      if (!options || options.type !== 'sankey') {
        throw new Error('Sankey options are required');
      }

      // Extract start/end events from series based on mode
      const eventSeries = onlyReportEvents(input.series);

      if (!eventSeries[0]) {
        throw new Error('Start and end events are required');
      }

      const data = await sankeyService.getSankey({
        projectId: input.projectId,
        startDate: currentPeriod.startDate,
        endDate: currentPeriod.endDate,
        steps: options.steps,
        mode: options.mode,
        startEvent: eventSeries[0],
        endEvent: eventSeries[1],
        exclude: options.exclude || [],
        include: options.include,
        timezone,
      });

      return {
        ...data,
        timezone,
      };
    }),

  chart: chartProcedure
    .use(cacher)
    .input(
      zReportInput.and(
        z.object({
          shareId: z.string().optional(),
          id: z.string().optional(),
        })
      )
    )
    .query(async ({ input, ctx }) => {
      console.log('input', input);

      const chartInput = ctx.report
        ? {
            ...ctx.report,
            range: input.range ?? ctx.report.range,
            startDate: input.startDate ?? ctx.report.startDate,
            endDate: input.endDate ?? ctx.report.endDate,
            interval: input.interval ?? ctx.report.interval,
          }
        : input;

      return ChartEngine.execute(chartInput);
    }),

  aggregate: chartProcedure
    .use(cacher)
    .input(
      zReportInput.and(
        z.object({
          shareId: z.string().optional(),
          id: z.string().optional(),
        })
      )
    )
    .query(async ({ input, ctx }) => {
      const chartInput = ctx.report
        ? {
            ...ctx.report,
            range: input.range ?? ctx.report.range,
            startDate: input.startDate ?? ctx.report.startDate,
            endDate: input.endDate ?? ctx.report.endDate,
            interval: input.interval ?? ctx.report.interval,
          }
        : input;

      return AggregateChartEngine.execute(chartInput);
    }),

  cohort: chartProcedure
    .use(guardNoCohortBreakdown('retention'))
    .use(cacher)
    .input(
      z.object({
        projectId: z.string(),
        firstEvent: z.array(z.string()).default([]),
        secondEvent: z.array(z.string()).default([]),
        firstCustomEventId: z.string().optional(),
        secondCustomEventId: z.string().optional(),
        firstEventFilters: z.array(zChartEventFilter).default([]),
        secondEventFilters: z.array(zChartEventFilter).default([]),
        firstEventFirstTimeFilter: z.boolean().optional(),
        secondEventFirstTimeFilter: z.boolean().optional(),
        criteria: zCriteria.default('on_or_after'),
        metric: zRetentionMeasure.optional(),
        property: z.string().optional(),
        propertyAverageDenominatorStep: z
          .number()
          .int()
          .nonnegative()
          .optional(),
        retentionUnit: zRetentionTimeUnit.default('day'),
        topN: z.number().int().positive().max(20).default(20),
        breakdownSort: zRetentionBreakdownSort.default('profile_count_desc'),
        breakdowns: zChartBreakdowns.default([]),
        startDate: z.string().nullish(),
        endDate: z.string().nullish(),
        interval: zTimeInterval.default('day'),
        range: zRange,
        dateConfig: zDateConfig.nullish(),
        shareId: z.string().optional(),
        id: z.string().optional(),
        bypassCache: z.boolean().optional(),
        audience: zReportAudience.optional(),
        // Declared ONLY so the guard below can reject it. Retention builds its
        // own input schema, so an undeclared key is silently stripped by zod
        // and the request succeeds while the caller's breakdown vanishes.
        cohortBreakdown: zCohortBreakdown.optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      const projectId = ctx.report?.projectId ?? input.projectId;

      let firstEvent = input.firstEvent;
      let secondEvent = input.secondEvent;
      let firstEventFilters: IChartEventFilter[] = input.firstEventFilters;
      let secondEventFilters: IChartEventFilter[] = input.secondEventFilters;
      let firstEventFirstTimeFilter = !!input.firstEventFirstTimeFilter;
      let secondEventFirstTimeFilter = !!input.secondEventFirstTimeFilter;
      let criteria = input.criteria;
      let retentionMetric = input.metric ?? 'unique_users';
      let retentionProperty = input.property;
      let propertyAverageDenominatorStep =
        input.propertyAverageDenominatorStep ?? 0;
      let retentionUnit = input.retentionUnit;
      let topN = input.topN;
      let breakdownSort = input.breakdownSort;
      let breakdowns: IChartBreakdown[] = input.breakdowns;
      const dateRange = ctx.report
        ? (input.range ?? ctx.report.range)
        : input.range;
      const startDate = ctx.report
        ? (input.startDate ?? ctx.report.startDate)
        : input.startDate;
      const endDate = ctx.report
        ? (input.endDate ?? ctx.report.endDate)
        : input.endDate;

      // Report-level audience for retention. Applied to the INITIAL (day-0)
      // population only: a cohort is a STATIC set of profile ids, so applying it
      // to the return leg as well is identical to applying it to the first leg,
      // while applying it ONLY to the return leg would filter the numerator
      // against an unfiltered denominator — a ratio whose halves describe
      // different populations.
      //
      // Resolved AFTER the effective dates above, and from `endDate` rather
      // than `input.endDate`: a saved-report request carries only {id}, so
      // reading input.endDate (or falling back to wall-clock now) would
      // evaluate membership as of a different instant than the report's data
      // and silently shift the counts.
      const retentionAudience = await resolveAudience(
        (ctx.report as { audience?: { cohortIds?: string[] } } | undefined)
          ?.audience?.cohortIds ?? input.audience?.cohortIds,
        projectId,
        endDate ?? formatClickhouseDate(new Date()),
      );
      const retentionAudiencePredicate = retentionAudience.render('e');
      const retentionAudienceClause = retentionAudiencePredicate
        ? `AND ${retentionAudiencePredicate}`
        : '';
      const interval = ctx.report
        ? (input.interval ?? ctx.report.interval)
        : input.interval;
      const dateConfig = ctx.report
        ? (input.dateConfig ?? (ctx.report as any).dateConfig)
        : input.dateConfig;

      // Resolved custom event WHERE clauses (include per-component filters).
      // When set, these override whereEventNameIs() in the SQL template.
      let firstEventCustomWhere: string | undefined;
      let secondEventCustomWhere: string | undefined;
      // Collect all component-level filters for profile JOIN building
      let firstComponentFilters: IChartEventFilter[] = [];
      let secondComponentFilters: IChartEventFilter[] = [];

      // Extract events from report series if shared
      if (ctx.report) {
        const retentionOptions =
          ctx.report.options?.type === 'retention'
            ? ctx.report.options
            : undefined;
        criteria = retentionOptions?.criteria ?? criteria;
        retentionMetric = retentionOptions?.metric ?? retentionMetric;
        retentionProperty = retentionOptions?.property ?? retentionProperty;
        propertyAverageDenominatorStep =
          retentionOptions?.propertyAverageDenominatorStep ??
          propertyAverageDenominatorStep;
        retentionUnit = retentionOptions?.retentionUnit ?? retentionUnit;
        topN = retentionOptions?.topN ?? topN;
        breakdownSort = retentionOptions?.breakdownSort ?? breakdownSort;
        breakdowns = ctx.report.breakdowns;

        const firstItem = ctx.report.series[0];
        const secondItem = ctx.report.series[1];

        if (firstItem?.type === 'event') {
          firstEvent = (firstItem.filters?.[0]?.value ?? []).map(String);
          firstEventFilters = (firstItem.filters ?? []).slice(1);
          firstEventFirstTimeFilter = !!firstItem.firstTimeFilter;
        } else if (firstItem?.type === 'custom_event') {
          const ce = await db.customEvent.findUnique({
            where: { id: firstItem.customEventId },
          });
          if (ce?.components && ce.projectId === projectId) {
            const components = ce.components as ICustomEventComponent[];
            firstEvent = components.map((c) => c.eventName);
            firstEventCustomWhere = getCustomEventWhereClause(
              components,
              projectId
            );
            firstComponentFilters = components.flatMap((c) => c.filters);
          }
          // Preserve outer series-level filters on the custom event
          firstEventFilters = firstItem.filters ?? [];
          firstEventFirstTimeFilter = !!firstItem.firstTimeFilter;
        }

        if (secondItem?.type === 'event') {
          secondEvent = (secondItem.filters?.[0]?.value ?? []).map(String);
          secondEventFilters = (secondItem.filters ?? []).slice(1);
          secondEventFirstTimeFilter = !!secondItem.firstTimeFilter;
        } else if (secondItem?.type === 'custom_event') {
          const ce = await db.customEvent.findUnique({
            where: { id: secondItem.customEventId },
          });
          if (ce?.components && ce.projectId === projectId) {
            const components = ce.components as ICustomEventComponent[];
            secondEvent = components.map((c) => c.eventName);
            secondEventCustomWhere = getCustomEventWhereClause(
              components,
              projectId
            );
            secondComponentFilters = components.flatMap((c) => c.filters);
          }
          // Preserve outer series-level filters on the custom event
          secondEventFilters = secondItem.filters ?? [];
          secondEventFirstTimeFilter = !!secondItem.firstTimeFilter;
        }
      }

      // Resolve custom events from direct input (unsaved/edit flow)
      if (firstEvent.length === 0 && input.firstCustomEventId) {
        const ce = await db.customEvent.findUnique({
          where: { id: input.firstCustomEventId },
        });
        if (ce?.components && ce.projectId === projectId) {
          const components = ce.components as ICustomEventComponent[];
          firstEvent = components.map((c) => c.eventName);
          firstEventCustomWhere = getCustomEventWhereClause(
            components,
            projectId
          );
          firstComponentFilters = components.flatMap((c) => c.filters);
        }
      }
      if (secondEvent.length === 0 && input.secondCustomEventId) {
        const ce = await db.customEvent.findUnique({
          where: { id: input.secondCustomEventId },
        });
        if (ce?.components && ce.projectId === projectId) {
          const components = ce.components as ICustomEventComponent[];
          secondEvent = components.map((c) => c.eventName);
          secondEventCustomWhere = getCustomEventWhereClause(
            components,
            projectId
          );
          secondComponentFilters = components.flatMap((c) => c.filters);
        }
      }

      if (firstEvent.length === 0 || secondEvent.length === 0) {
        throw new Error('Start and end events are required');
      }

      const { timezone } = await getSettingsForProject(projectId);
      const dates = getChartStartEndDate(
        {
          range: dateRange,
          startDate,
          endDate,
          dateConfig: dateConfig ?? undefined,
        },
        timezone
      );
      const retentionTimeUnitConfig = getRetentionTimeUnitConfig(retentionUnit);
      const diffInterval = {
        day: () => differenceInDays(dates.endDate, dates.startDate),
        week: () => differenceInWeeks(dates.endDate, dates.startDate),
        month: () => differenceInMonths(dates.endDate, dates.startDate),
      }[retentionTimeUnitConfig.diffUnit]();
      const sqlInterval = retentionTimeUnitConfig.sqlInterval;
      const retentionWindowEndInterval = diffInterval + 1;

      // toStartOfWeek/toStartOfMonth need DateTime input for timezone arg.
      // When col is already a Date (e.g. event_date), cast to DateTime first.
      const toStartOfInterval = (col: string) => {
        switch (interval) {
          case 'week':
            return `toStartOfWeek(toDateTime(${col}), 0, '${timezone}')`;
          case 'month':
            return `toStartOfMonth(toDateTime(${col}), '${timezone}')`;
          default:
            return `toDate(${col}, '${timezone}')`;
        }
      };
      const cohortUnit =
        interval === 'day' || retentionUnit === 'day'
          ? 'day'
          : interval === 'week' || retentionUnit === 'week'
            ? 'week'
            : 'month';
      const toStartOfCohortInterval = (col: string) => {
        switch (cohortUnit) {
          case 'week':
            return `toStartOfWeek(toDateTime(${col}), 0, '${timezone}')`;
          case 'month':
            return `toStartOfMonth(toDateTime(${col}), '${timezone}')`;
          default:
            return `toDate(${col}, '${timezone}')`;
        }
      };

      const countCriteria =
        criteria === 'on_or_after'
          ? '>='
          : criteria === 'on_or_before'
            ? '<='
            : '=';
      const retentionPropertyExpr = getRetentionMeasurePropertyExpression(
        retentionMetric,
        retentionProperty
      );

      const countsSelect = range(0, diffInterval + 1)
        .map((index) =>
          buildRetentionMeasureIntervalSelect({
            index,
            criteria: countCriteria,
            measure: retentionMetric,
            propertyExpression: retentionPropertyExpr,
            propertyAverageDenominatorStep,
            maturityExpression: getRetentionIntervalMaturityExpression({
              index,
              unit: retentionUnit,
              cohortExpression: 'cs.cohort_interval',
              asOfExpression: `toDate(now('${timezone}'))`,
            }),
          })
        )
        .join(',\n');
      const propertyAverageDenominatorSelect =
        retentionMetric === 'property_average' &&
        retentionPropertyExpr &&
        propertyAverageDenominatorStep > 0
          ? `,\n${range(0, diffInterval + 1)
              .map((index) => {
                const predicate = `r.x_after_cohort ${countCriteria} ${index}`;
                return `uniqExactIf(r.profile_id, ${predicate}) AS interval_${index}_denominator_count`;
              })
              .join(',\n')}`
          : '';

      // Determine which table to use: events table when any non-profile
      // filter is present (cohort_events_mv only has project_id, name,
      // created_at, profile_id, event_count — no properties/path/country/etc).
      // Profile-only filters are handled via a JOIN, so the MV suffices.
      // Custom events with component filters also need the events table.
      const needsEventsTable = (filters: IChartEventFilter[]) =>
        filters.some(
          (f) =>
            !f.name.startsWith('profile.') &&
            f.name !== 'has_profile' &&
            f.name !== 'name'
        );

      const hasEventBreakdown = breakdowns.some(
        (breakdown) => !breakdown.name.startsWith('profile.')
      );
      // An audience forces BOTH legs onto `events`.
      //
      // Retention is retained_users / active_users: the denominator comes from
      // the first leg and the NUMERATOR from the second. cohort_events_mv's
      // coverage can lag `events` badly (measured: zero MV rows for a month
      // where events held 2.8M), so drawing the denominator from complete
      // `events` while the numerator came from the MV would understate
      // retention silently, by whatever the coverage gap happens to be.
      // Both legs must come from the same table.
      const hasAudience = Boolean(retentionAudiencePredicate);
      const useEventsFirst =
        hasAudience ||
        hasEventBreakdown ||
        firstEventFirstTimeFilter ||
        needsEventsTable(firstEventFilters) ||
        needsEventsTable(firstComponentFilters);
      const useEventsSecond =
        hasAudience ||
        secondEventFirstTimeFilter ||
        isRetentionPropertyMeasure(retentionMetric) ||
        needsEventsTable(secondEventFilters) ||
        needsEventsTable(secondComponentFilters);
      const firstEventTable = useEventsFirst
        ? TABLE_NAMES.events
        : TABLE_NAMES.cohort_events_mv;
      const secondEventTable = useEventsSecond
        ? TABLE_NAMES.events
        : TABLE_NAMES.cohort_events_mv;

      // Build profile JOIN clause (only needed for profile.* filters)
      const buildProfileJoin = (
        filters: IChartEventFilter[],
        extraProfileFields: string[] = [],
        eventAlias?: string
      ) => {
        const profileFilters = [
          ...filters
            .filter((f) => f.name.startsWith('profile.'))
            .map((f) => f.name.replace('profile.', '')),
          ...extraProfileFields,
        ];
        if (profileFilters.length === 0) {
          return '';
        }
        const columns = uniq(profileFilters.map((f) => f.split('.')[0])).join(
          ', '
        );
        const profileId = eventAlias
          ? `${eventAlias}.profile_id`
          : 'profile_id';
        return `LEFT ANY JOIN (SELECT id, ${columns} FROM ${TABLE_NAMES.profiles} FINAL WHERE project_id = ${sqlstring.escape(projectId)}) AS profile ON profile.id = ${profileId}`;
      };

      const buildFilterWhere = (
        filters: IChartEventFilter[],
        qualifyAlias?: string
      ) => {
        if (filters.length === 0) {
          return '';
        }
        const where = getEventFiltersWhereClause(filters, projectId);
        let clauses = Object.values(where);
        if (clauses.length === 0) {
          return '';
        }
        // When trait CTEs are joined in the same scope, a bare profile_id is
        // AMBIGUOUS_IDENTIFIER — qualify the outer reference only (not the
        // profile_id inside the trait IN-subquery).
        if (qualifyAlias) {
          clauses = clauses.map((clause) =>
            clause
              .replace(
                /^profile_id (IN|NOT IN) /i,
                `${qualifyAlias}.profile_id $1 `
              )
              .replace(/^profile_id (!= |= )/i, `${qualifyAlias}.profile_id $1`)
          );
        }
        return `AND ${clauses.join(' AND ')}`;
      };

      // Include both outer series filters AND component-level filters for profile JOINs
      const traitBreakdownDescriptors = Array.from(
        new Map(
          breakdowns
            .map((breakdown) => getTraitBreakdownDescriptor(breakdown.name))
            .filter(Boolean)
            .map((descriptor) => [descriptor!.key, descriptor!])
        ).values()
      );
      const scalarProfileBreakdownFields = breakdowns
        .filter(
          (breakdown) =>
            breakdown.name.startsWith('profile.') &&
            getTraitBreakdownDescriptor(breakdown.name) === null
        )
        .map((breakdown) => breakdown.name.replace('profile.', ''));
      const traitBreakdownCtes = traitBreakdownDescriptors
        .map(
          (descriptor) =>
            `${descriptor.cteName} AS (SELECT profile_id, argMax(value, updated_at) AS value FROM ${TABLE_NAMES.profile_traits} WHERE project_id = ${sqlstring.escape(projectId)} AND key = ${sqlstring.escape(descriptor.key)} GROUP BY profile_id),`
        )
        .join('\n');
      const traitBreakdownJoins = traitBreakdownDescriptors
        .map(
          (descriptor) =>
            `LEFT ANY JOIN ${descriptor.cteName} ON ${descriptor.cteName}.profile_id = e.profile_id`
        )
        .join('\n');
      const getRetentionBreakdownExpression = (name: string) => {
        const descriptor = getTraitBreakdownDescriptor(name);
        return descriptor ? descriptor.column : getSelectPropertyKey(name);
      };
      const breakdownAliases = breakdowns.map((_, index) => `b_${index}`);
      const normalizedBreakdownExpressions = breakdowns.map(
        (breakdown) =>
          `coalesce(nullIf(toString(${getRetentionBreakdownExpression(breakdown.name)}), ''), '(not set)')`
      );
      const breakdownSelects = buildRetentionBreakdownSelects(
        normalizedBreakdownExpressions
      );

      const firstEventJoin = [
        buildProfileJoin(
          [...firstEventFilters, ...firstComponentFilters],
          scalarProfileBreakdownFields,
          'e'
        ),
        traitBreakdownJoins,
      ]
        .filter(Boolean)
        .join('\n');
      const firstEventWhere = buildFilterWhere(
        firstEventFilters,
        traitBreakdownDescriptors.length > 0 ? 'e' : undefined
      );
      const secondEventJoin = buildProfileJoin([
        ...secondEventFilters,
        ...secondComponentFilters,
      ]);
      const secondEventWhere = buildFilterWhere(secondEventFilters);

      // cohort_events_mv pre-filters to identified users (profile_id != device_id).
      // When falling back to the raw events table, replicate that condition.
      const firstIdentifiedFilter = useEventsFirst
        ? 'AND e.profile_id != e.device_id'
        : '';
      const secondIdentifiedFilter = useEventsSecond
        ? 'AND profile_id != device_id'
        : '';

      // For custom events, use the pre-built WHERE clause (includes component filters).
      // For regular events, use whereEventNameIs() + separate filter clause.
      // Outer series-level filters (firstEventWhere) are always applied on top.
      const firstWhereClause = firstEventCustomWhere
        ? `${firstEventCustomWhere}`
        : `${getConcreteEventNameWhereClause(firstEvent)}`;
      const firstFilterClause = firstEventWhere;

      const secondWhereClause = secondEventCustomWhere
        ? `${secondEventCustomWhere}`
        : `${getRetentionReturnEventWhereClause(secondEvent)}`;
      const secondFilterClause = secondEventWhere;

      const firstTimeStartExpression = `toDate('${utc(dates.startDate)}', '${timezone}')`;
      const firstTimeEndExpression = `toDate('${utc(dates.endDate)}', '${timezone}')`;
      const secondTimeEndExpression = `toDate('${utc(dates.endDate)}', '${timezone}') + INTERVAL ${retentionWindowEndInterval} ${sqlInterval} - INTERVAL 1 SECOND`;
      const firstEventFirstTimeCte = firstEventFirstTimeFilter
        ? `first_event_first_time AS (${buildRetentionFirstTimeCteSql({
            projectId,
            eventPredicate: firstWhereClause,
            startExpression: firstTimeStartExpression,
            endExpression: firstTimeEndExpression,
          })}),`
        : '';
      const secondEventFirstTimeCte = secondEventFirstTimeFilter
        ? `second_event_first_time AS (${buildRetentionFirstTimeCteSql({
            projectId,
            eventPredicate: secondWhereClause,
            startExpression: firstTimeStartExpression,
            endExpression: secondTimeEndExpression,
          })}),`
        : '';
      const firstEventFirstTimeJoin = firstEventFirstTimeFilter
        ? 'INNER JOIN first_event_first_time AS first_ft ON first_ft.ft_profile_id = e.profile_id AND first_ft.first_created_at = e.created_at'
        : '';
      const secondEventFirstTimeJoin = secondEventFirstTimeFilter
        ? 'INNER JOIN second_event_first_time AS second_ft ON second_ft.ft_profile_id = profile_id AND second_ft.first_created_at = created_at'
        : '';

      const breakdownSelectClause = breakdownSelects.length
        ? `,\n            ${breakdownSelects.join(',\n            ')}`
        : '';
      const cohortUsersGroupBy = breakdownSelects.length
        ? 'GROUP BY userID, project_id, cohort_interval'
        : '';
      const cohortIntervalSelect = toStartOfCohortInterval('e.created_at');
      const displayIntervalSelect = breakdownSelects.length
        ? `any(${toStartOfInterval(cohortIntervalSelect)})`
        : toStartOfInterval('e.created_at');
      const topBreakdownsCtes = breakdownAliases.length
        ? `top_breakdowns AS (
          SELECT ${breakdownAliases.join(', ')}, count() AS breakdown_users
          FROM cohort_users
          GROUP BY ${breakdownAliases.join(', ')}
          ORDER BY breakdown_users DESC
          LIMIT ${topN}
        ),
        limited_cohort_users AS (
          SELECT cu.*
          FROM cohort_users AS cu
          INNER JOIN top_breakdowns AS tb ON ${breakdownAliases
            .map((alias) => `cu.${alias} = tb.${alias}`)
            .join(' AND ')}
        ),`
        : '';
      const cohortUsersSource = breakdownAliases.length
        ? 'limited_cohort_users'
        : 'cohort_users';
      const breakdownColumns = breakdownAliases.length
        ? `, ${breakdownAliases.join(', ')}`
        : '';
      const breakdownColumnsFromFirst = breakdownAliases.length
        ? `, ${breakdownAliases.map((alias) => `f.${alias}`).join(', ')}`
        : '';
      const breakdownColumnsFromCohortSizes = breakdownAliases.length
        ? `, ${breakdownAliases.map((alias) => `cs.${alias}`).join(', ')}`
        : '';
      const breakdownJoin = breakdownAliases.length
        ? ` AND ${breakdownAliases
            .map((alias) => `cs.${alias} = r.${alias}`)
            .join(' AND ')}`
        : '';
      const breakdownOrder = breakdownAliases.length
        ? `, ${breakdownAliases.map((alias) => `cs.${alias}`).join(', ')}`
        : '';

      const cohortQuery = `
        WITH
        ${traitBreakdownCtes}
        ${firstEventFirstTimeCte}
        ${secondEventFirstTimeCte}
        cohort_users AS (
          SELECT
            e.profile_id AS userID,
            e.project_id,
            ${displayIntervalSelect} AS display_interval,
            ${cohortIntervalSelect} AS cohort_interval
            ${breakdownSelectClause}
          FROM ${firstEventTable} AS e
          ${firstEventJoin}
          ${firstEventFirstTimeJoin}
          WHERE ${firstWhereClause}
            AND e.project_id = ${sqlstring.escape(projectId)}
            AND e.created_at BETWEEN toDate('${utc(dates.startDate)}', '${timezone}') AND toDate('${utc(dates.endDate)}', '${timezone}')
            ${firstIdentifiedFilter}
            ${firstFilterClause}
            ${retentionAudienceClause}
          ${cohortUsersGroupBy}
        ),
        ${topBreakdownsCtes}
        last_event AS
        (
            SELECT
                profile_id,
                project_id,
                toDate(created_at, '${timezone}') AS event_date
                ${retentionPropertyExpr ? `, ${retentionPropertyExpr} AS retention_property_value` : ''}
            FROM ${secondEventTable}
            ${secondEventJoin}
            ${secondEventFirstTimeJoin}
            WHERE ${secondWhereClause}
            AND project_id = ${sqlstring.escape(projectId)}
            AND created_at >= toDate('${utc(dates.startDate)}', '${timezone}')
            AND created_at < toDate('${utc(dates.endDate)}', '${timezone}') + INTERVAL ${retentionWindowEndInterval} ${sqlInterval}
            ${secondIdentifiedFilter}
            ${secondFilterClause}
        ),
        retention_matrix AS
        (
          SELECT
              f.cohort_interval,
              l.profile_id,
              ${breakdownColumnsFromFirst.replace(/^, /, '')}${breakdownColumnsFromFirst ? ',' : ''}
              ${retentionPropertyExpr ? 'l.retention_property_value,' : ''}
              ${getRetentionElapsedIntervalExpression(
                retentionUnit,
                'f.cohort_interval',
                'l.event_date'
              )} AS x_after_cohort
          FROM ${cohortUsersSource} AS f
          INNER JOIN last_event AS l ON f.userID = l.profile_id
          WHERE (l.event_date >= f.cohort_interval)
          AND (l.event_date < (f.cohort_interval + INTERVAL ${retentionWindowEndInterval} ${sqlInterval}))
        ),
        cohort_sizes AS (
          SELECT
            cohort_interval,
            any(display_interval) AS display_interval,
            COUNT(DISTINCT userID) AS total_first_event_count
            ${breakdownColumns}
          FROM ${cohortUsersSource}
          GROUP BY cohort_interval${breakdownColumns}
        )
        SELECT
          cs.display_interval,
          cs.cohort_interval,
          cs.total_first_event_count,
          ${breakdownColumnsFromCohortSizes.replace(/^, /, '')}${breakdownColumnsFromCohortSizes ? ',' : ''}
          ${countsSelect}
          ${propertyAverageDenominatorSelect}
        FROM cohort_sizes cs
        LEFT JOIN retention_matrix r ON cs.cohort_interval = r.cohort_interval${breakdownJoin}
        GROUP BY cs.display_interval, cs.cohort_interval, cs.total_first_event_count${breakdownColumnsFromCohortSizes}
        ORDER BY cs.cohort_interval ASC${breakdownOrder}
      `;

      const cohortData = await chQuery<{
        display_interval?: string;
        cohort_interval: string;
        total_first_event_count: number;
        [key: string]: any;
      }>(cohortQuery);

      return {
        data: processCohortData(
          cohortData,
          diffInterval,
          dates.startDate,
          dates.endDate,
          interval,
          retentionUnit,
          retentionMetric,
          breakdownSort
        ),
        queries: [cohortQuery],
        timezone,
      };
    }),

  getProfiles: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        date: z.string().describe('The date for the data point (ISO string)'),
        interval: zTimeInterval.default('day'),
        series: zChartSeries,
        breakdowns: z.record(z.string(), z.string()).optional(),
      })
    )
    .query(async ({ input }) => {
      const { timezone } = await getSettingsForProject(input.projectId);
      const { projectId, date, series } = input;
      const limit = 100;
      const serie = series[0];

      if (!serie) {
        throw new Error('Series not found');
      }

      if (serie.type !== 'event') {
        throw new Error('Series must be an event');
      }

      // Build the date range for the specific interval bucket
      const dateObj = new Date(date);
      // Build query to get unique profile_ids for this time bucket
      const { sb, getSql } = createSqlBuilder();

      sb.select.profile_id = 'DISTINCT profile_id';
      sb.where = getEventFiltersWhereClause(serie.filters, projectId);
      sb.where.projectId = `project_id = ${sqlstring.escape(projectId)}`;
      sb.where.dateRange = `${clix.toStartOf('created_at', input.interval)} = ${clix.toDate(sqlstring.escape(formatClickhouseDate(dateObj)), input.interval)}`;
      if (serie.name !== '*') {
        sb.where.eventName = `name = ${sqlstring.escape(serie.name)}`;
      }

      // Collect profile fields from filters and breakdowns
      const profileFields = [
        ...serie.filters
          .filter((f) => f.name.startsWith('profile.'))
          .map((f) => f.name.replace('profile.', '')),
        ...(input.breakdowns
          ? Object.keys(input.breakdowns)
              .filter((key) => key.startsWith('profile.'))
              .map((key) => key.replace('profile.', ''))
          : []),
      ];

      if (profileFields.length > 0) {
        // Extract top-level field names and select only what's needed
        const fieldsToSelect = uniq(
          profileFields.map((f) => f.split('.')[0])
        ).join(', ');
        sb.joins.profiles = `LEFT ANY JOIN (SELECT id, ${fieldsToSelect} FROM ${TABLE_NAMES.profiles} FINAL WHERE project_id = ${sqlstring.escape(projectId)}) as profile on profile.id = profile_id`;
      }

      if (input.breakdowns) {
        Object.entries(input.breakdowns).forEach(([key, value]) => {
          // Transform property keys (e.g., properties.method -> properties['method'])
          const propertyKey = getSelectPropertyKey(key);
          sb.where[`breakdown_${key}`] =
            `${propertyKey} = ${sqlstring.escape(value)}`;
        });
      }

      // Get unique profile IDs
      const profileIds = await chQuery<{ profile_id: string }>(getSql());
      if (profileIds.length === 0) {
        return [];
      }

      // Fetch profile details in batches to avoid exceeding ClickHouse max_query_size
      const ids = profileIds.map((p) => p.profile_id).filter(Boolean);
      const BATCH_SIZE = 200;
      const profiles = [];
      for (let i = 0; i < ids.length; i += BATCH_SIZE) {
        const batch = ids.slice(i, i + BATCH_SIZE);
        const batchProfiles = await getProfilesCached(batch, projectId);
        profiles.push(...batchProfiles);
      }

      return profiles;
    }),

  getFunnelProfiles: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        startDate: z.string().nullish(),
        endDate: z.string().nullish(),
        series: zChartSeries,
        stepIndex: z.number().describe('0-based index of the funnel step'),
        showDropoffs: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            'If true, show users who dropped off at this step. If false, show users who completed at least this step.'
          ),
        funnelWindow: z.number().optional(),
        funnelWindowUnit: z
          .enum(['second', 'minute', 'hour', 'day', 'week', 'month'])
          .optional(),
        funnelGroup: z.string().optional(),
        breakdowns: z.array(z.object({ name: z.string() })).optional(),
        breakdownValues: z.array(z.string()).optional(),
        breakdownStep: z.number().optional(),
        range: zRange,
        dateConfig: zDateConfig.nullish(),
      })
    )
    .query(async ({ input }) => {
      const { timezone } = await getSettingsForProject(input.projectId);
      const {
        projectId,
        series,
        stepIndex,
        showDropoffs = false,
        funnelWindow,
        funnelGroup,
      } = input;

      const { startDate, endDate } = getChartStartEndDate(input, timezone);

      // stepIndex is 0-based, but level is 1-based, so we need level >= stepIndex + 1
      const targetLevel = stepIndex + 1;

      const eventSeries = await resolveSeriesForFunnel(series, projectId);

      if (eventSeries.length === 0) {
        throw new Error('At least one event series is required');
      }

      const funnelWindowUnit = input.funnelWindowUnit ?? 'hour';
      const unitMultipliers: Record<string, number> = {
        second: 1,
        minute: 60,
        hour: 3600,
        day: 86_400,
        week: 604_800,
        month: 2_592_000,
      };
      const funnelWindowSeconds =
        (funnelWindow || 24) * (unitMultipliers[funnelWindowUnit] ?? 3600);
      const funnelWindowMilliseconds = funnelWindowSeconds * 1000;

      // Get the grouping strategy (profile_id or session_id)
      const group = funnelService.getFunnelGroup(funnelGroup);

      // Build breakdown selects if filtering by breakdown values.
      // Use the same expression builder as the funnel chart to handle
      // both event properties and profile.* breakdowns correctly.
      // When breakdownStep is set, use argMaxIf to extract from that step
      // (matching how the chart derives breakdown labels).
      const breakdownDims = input.breakdowns ?? [];
      const breakdownVals = input.breakdownValues;
      const breakdownStepIdx = input.breakdownStep;
      const stepConditions = funnelService.getFunnelConditions(
        eventSeries,
        projectId
      );

      // Collect profile-trait breakdown descriptors so buildFunnelCte can
      // register the per-trait CTEs + LEFT ANY JOIN. This mirrors the
      // service's own getFunnel path and replaces the old correlated
      // subquery helper (`getTraitBreakdownExpression`), which resolved
      // `t.profile_id = profile_id` as `t.profile_id = t.profile_id`
      // (unqualified inner-scope reference) and returned a global scalar
      // instead of a per-profile value — so the View Users drawer would
      // bucket every user into the same trait value for trait breakdowns.
      const traitDescriptors = new Map<string, TraitBreakdown>();
      for (const b of breakdownDims) {
        const desc = getTraitBreakdownDescriptor(b.name);
        if (desc && !traitDescriptors.has(desc.key)) {
          traitDescriptors.set(desc.key, desc);
        }
      }

      // Helper: return the SQL expression for a breakdown column. Trait
      // breakdowns use the fully-qualified CTE column (`trait_<key>.value`),
      // matching what buildFunnelCte injects via traitDescriptors. Non-trait
      // breakdowns fall through to the event-property expression builder.
      const breakdownExpr = (name: string): string => {
        const desc = getTraitBreakdownDescriptor(name);
        if (desc && traitDescriptors.has(desc.key)) {
          return desc.column;
        }
        return getSelectPropertyKey(name);
      };

      // Pre-compute profile-join signals before building breakdownSelects,
      // so the argMaxIf qualification trigger can account for the
      // `profiles FINAL` join that may be attached a few lines below.
      // Trait-backed profile.properties.* filters and breakdowns BOTH
      // resolve through profile_traits (filters via `profile_id IN
      // (SELECT ...)` subqueries, breakdowns via the trait CTE +
      // LEFT ANY JOIN), so neither should trigger the profiles FINAL
      // join. Mirrors FunnelService.getFunnel.
      const profileFiltersRaw = funnelService.getProfileFilters(eventSeries);
      const profileFilters = profileFiltersRaw.filter(
        (f) => getTraitBreakdownDescriptor(`profile.${f}`) === null
      );
      const breakdownProfileFields = breakdownDims
        .filter(
          (b) =>
            b.name.startsWith('profile.') &&
            getTraitBreakdownDescriptor(b.name) === null
        )
        .map((b) => b.name.replace('profile.', ''));
      const allProfileFields = [...profileFilters, ...breakdownProfileFields];
      const anyFilterOnProfile = profileFilters.length > 0;
      const anyBreakdownOnProfile = breakdownProfileFields.length > 0;

      // Any extra join attached to session_funnel (trait CTEs or
      // profiles FINAL) can expose overlapping column names, making a
      // bare event-column reference inside argMaxIf ambiguous. Mirrors
      // FunnelService.getFunnel's broader trigger.
      const needsQualify =
        traitDescriptors.size > 0 ||
        anyFilterOnProfile ||
        anyBreakdownOnProfile;
      const qualifiedCreatedAt = needsQualify
        ? 'events.created_at'
        : 'created_at';
      const qualifyStepCondition = (expr: string) =>
        needsQualify ? qualifyFunnelCondition(expr, 'events') : expr;

      const breakdownSelects =
        breakdownVals && breakdownDims.length > 0
          ? breakdownDims.map((b, i) => {
              const expr = breakdownExpr(b.name);
              if (
                breakdownStepIdx !== undefined &&
                breakdownStepIdx >= 0 &&
                breakdownStepIdx < stepConditions.length
              ) {
                const cond = qualifyStepCondition(
                  stepConditions[breakdownStepIdx]!
                );
                return `argMaxIf(${expr}, ${qualifiedCreatedAt}, ${cond}) as b_${i}`;
              }
              return `${expr} as b_${i}`;
            })
          : [];

      const breakdownGroupBy =
        breakdownVals &&
        breakdownDims.length > 0 &&
        breakdownStepIdx === undefined
          ? breakdownDims.map((_, i) => `b_${i}`)
          : [];

      // Create funnel CTE using funnel service.
      // Tell buildFunnelCte up-front whether we'll attach profiles FINAL
      // below, so it can pre-qualify its internal windowFunnel step
      // conditions before the downstream join makes them ambiguous.
      const {
        query: funnelCte,
        firstTimeCtes,
        traitCtes,
      } = funnelService.buildFunnelCte({
        projectId,
        startDate,
        endDate,
        eventSeries,
        funnelWindowMilliseconds,
        timezone,
        groupBy: group,
        additionalSelects: breakdownVals ? breakdownSelects : [],
        additionalGroupBy: breakdownVals ? breakdownGroupBy : [],
        traitDescriptors,
        expectProfilesFinalJoin: anyFilterOnProfile || anyBreakdownOnProfile,
      });

      if (allProfileFields.length > 0) {
        const profileColumns = new Set<string>(['id']);
        for (const f of allProfileFields) {
          const col = f.split('.')[0]!;
          if (col === 'properties') {
            profileColumns.add('properties');
          } else if (['email', 'first_name', 'last_name'].includes(col)) {
            profileColumns.add(col);
          }
        }
        const fieldsToSelect = Array.from(profileColumns).join(', ');
        funnelCte.leftJoin(
          `(SELECT ${fieldsToSelect} FROM ${TABLE_NAMES.profiles} FINAL WHERE project_id = ${sqlstring.escape(projectId)}) as profile`,
          'profile.id = events.profile_id'
        );
      }

      // Build main query — first-time CTEs and trait CTEs must be at the
      // top level before session_funnel. buildFunnelCte returns both so
      // the registration loop stays identical across callers.
      const query = clix(ch, timezone);
      for (const cte of firstTimeCtes) {
        query.with(cte.name, cte.sql);
      }
      for (const cte of traitCtes) {
        query.with(cte.name, cte.sql);
      }
      query.with('session_funnel', funnelCte);

      if (group === 'profile_id') {
        // For profile grouping: re-aggregate by profile_id, taking MAX level.
        // Preserve breakdown columns through regrouping when filtering by breakdown.
        const breakdownAggregates =
          breakdownVals && breakdownDims.length > 0
            ? `, ${breakdownDims.map((_, i) => `any(b_${i}) AS b_${i}`).join(', ')}`
            : '';
        query.with(
          'funnel',
          `SELECT profile_id, max(level) AS level${breakdownAggregates} FROM (SELECT * FROM session_funnel WHERE level != 0) GROUP BY profile_id`
        );
      } else {
        // For session grouping: filter out level = 0 inside the CTE
        query.with('funnel', 'SELECT * FROM session_funnel WHERE level != 0');
      }

      // Get distinct profile IDs
      // NOTE: level != 0 is already filtered inside the funnel CTE above
      query.select(['DISTINCT profile_id']).from('funnel');

      if (showDropoffs) {
        // Show users who dropped off at this step (completed this step but not the next)
        query.where('level', '=', targetLevel);
      } else {
        // Show users who completed at least this step
        query.where('level', '>=', targetLevel);
      }

      // Filter by specific breakdown values if provided
      if (breakdownVals && breakdownDims.length > 0) {
        for (
          let i = 0;
          i < breakdownVals.length && i < breakdownDims.length;
          i++
        ) {
          const val = breakdownVals[i]!;
          if (val === 'Not set') {
            query.rawWhere(`(b_${i} = '' OR b_${i} IS NULL)`);
          } else {
            query.where(`b_${i}`, '=', val);
          }
        }
      }

      // Cap the number of profiles to avoid exceeding ClickHouse max_query_size
      // when passing IDs to the next query
      query.limit(1000);

      const profileIdsResult = (await query.execute()) as {
        profile_id: string;
      }[];

      if (profileIdsResult.length === 0) {
        return [];
      }

      // The user drawer only renders identity fields plus country/city/OS/
      // browser. Avoid getProfilesCached's full profile_traits scan and fetch
      // only those display traits. Run the bounded batches concurrently too.
      // Stable ordering makes the five-minute batch cache reusable even when
      // ClickHouse returns the DISTINCT audience in a different order.
      const ids = profileIdsResult
        .map((p) => p.profile_id)
        .filter(Boolean)
        .sort();
      const BATCH_SIZE = 500;
      const profileBatches: Promise<IServiceProfile[]>[] = [];
      for (let i = 0; i < ids.length; i += BATCH_SIZE) {
        const batch = ids.slice(i, i + BATCH_SIZE);
        profileBatches.push(getProfilesForUserListCached(batch, projectId));
      }

      return (await Promise.all(profileBatches)).flat();
    }),
});

export function processCohortData(
  data: RawRetentionCohortRow[],
  diffInterval: number,
  startDate?: string,
  endDate?: string,
  interval?: string,
  retentionUnit?: string,
  retentionMetric?: string,
  breakdownSort:
    | 'profile_count_desc'
    | 'profile_count_asc' = 'profile_count_desc'
) {
  const direction = breakdownSort === 'profile_count_asc' ? 1 : -1;
  const groups = groupRetentionRowsByBreakdowns(data).sort((a, b) => {
    const aProfiles = a.rows.reduce(
      (sum, row) => sum + Number(row.total_first_event_count),
      0
    );
    const bProfiles = b.rows.reduce(
      (sum, row) => sum + Number(row.total_first_event_count),
      0
    );
    return (
      (aProfiles - bProfiles) * direction ||
      JSON.stringify(a.breakdowns).localeCompare(JSON.stringify(b.breakdowns))
    );
  });

  return groups.flatMap((group) =>
    processCohortGroupData(
      group.rows,
      diffInterval,
      startDate,
      endDate,
      interval,
      retentionUnit,
      retentionMetric
    ).map((row) => ({ ...row, breakdowns: group.breakdowns }))
  );
}

function processCohortGroupData(
  data: RawRetentionCohortRow[],
  diffInterval: number,
  startDate?: string,
  endDate?: string,
  interval?: string,
  retentionUnit?: string,
  retentionMetric?: string
) {
  let processed: Array<{
    cohort_interval: string;
    display_interval?: string;
    sum: number;
    values: Array<number | null>;
    valueWeights?: number[];
    percentages: Array<number | null>;
  }> = data.map((row) => {
    const sum = row.total_first_event_count;
    const values = range(0, diffInterval + 1).map((index) => {
      const value = row[`interval_${index}_user_count`];
      return value === null || value === undefined ? null : Number(value);
    });
    const valueWeights = range(0, diffInterval + 1).map(
      (index) =>
        (row[`interval_${index}_denominator_count`] ??
          row.total_first_event_count) as number
    );

    return {
      cohort_interval: row.cohort_interval,
      display_interval: row.display_interval,
      sum,
      values,
      valueWeights,
      percentages: values.map((value) =>
        value === null ? null : sum > 0 ? round(value / sum, 4) : 0
      ),
    };
  });

  if (interval && retentionUnit && interval !== retentionUnit) {
    processed = aggregateRetentionRowsByDisplayInterval(
      processed,
      retentionMetric === 'property_average' ? 'weighted_average' : 'sum'
    );
  }

  // Fill in missing dates with zero rows
  if (startDate && endDate) {
    const existingDates = new Set(processed.map((r) => r.cohort_interval));
    const start = new Date(startDate.slice(0, 10));
    // Handle endDate that spills into next day due to +1ms rounding
    // e.g. "2026-04-09 00:00:00" should be treated as Apr 8, not Apr 9
    const end = new Date(endDate.slice(0, 10));
    const timeStr = endDate.length > 10 ? endDate.slice(11, 19) : '';
    if (timeStr === '00:00:00') {
      end.setUTCDate(end.getUTCDate() - 1);
    }

    // Snap start to interval boundary (week = Sunday, month = 1st)
    if (interval === 'week') {
      const day = start.getUTCDay(); // 0=Sun, 6=Sat
      start.setUTCDate(start.getUTCDate() - day); // snap to Sunday
    } else if (interval === 'month') {
      start.setUTCDate(1);
    }
    const zeroValues = Array(diffInterval + 1).fill(0) as number[];

    for (let d = new Date(start); d <= end; ) {
      const dateStr = d.toISOString().slice(0, 10);
      if (!existingDates.has(dateStr)) {
        processed.push({
          cohort_interval: dateStr,
          sum: 0,
          values: [...zeroValues],
          valueWeights: [...zeroValues],
          percentages: [...zeroValues],
        });
      }
      // Increment by interval (use UTC setters consistently)
      if (interval === 'week') {
        d.setUTCDate(d.getUTCDate() + 7);
      } else if (interval === 'month') {
        d.setUTCMonth(d.getUTCMonth() + 1);
      } else {
        d.setUTCDate(d.getUTCDate() + 1);
      }
    }
    processed.sort((a, b) =>
      a.cohort_interval.localeCompare(b.cohort_interval)
    );
  }

  if (processed.length === 0) {
    return [];
  }

  const averageData: {
    totalSum: number;
    values: Array<{ sum: number; weightedSum: number }>;
    percentages: Array<{ sum: number; weightedSum: number }>;
  } = {
    totalSum: 0,
    values: range(0, diffInterval + 1).map(() => ({ sum: 0, weightedSum: 0 })),
    percentages: range(0, diffInterval + 1).map(() => ({
      sum: 0,
      weightedSum: 0,
    })),
  };

  // Aggregate data for weighted averages, excluding zero-sum rows (synthetic gap-fill rows)
  let nonZeroRowCount = 0;
  processed.forEach((row) => {
    if (row.sum === 0) {
      return; // skip synthetic zero rows
    }
    nonZeroRowCount++;
    averageData.totalSum += row.sum;
    row.values.forEach((value, index) => {
      if (value === null) {
        return;
      }
      const weight = row.valueWeights?.[index] ?? row.sum;
      averageData.values[index]!.sum += weight;
      averageData.values[index]!.weightedSum += value * weight;
    });
    row.percentages.forEach((percentage, index) => {
      if (percentage === null) {
        return;
      }
      const weight = row.valueWeights?.[index] ?? row.sum;
      averageData.percentages[index]!.sum += weight;
      averageData.percentages[index]!.weightedSum += percentage * weight;
    });
  });

  // Calculate weighted averages across every real cohort. Zero-retention cohorts
  // remain in the denominator; only synthetic gap-fill rows are excluded above.
  const valuePrecision =
    retentionMetric === 'property_sum' || retentionMetric === 'property_average'
      ? 2
      : 0;
  const averageRow = {
    cohort_interval: 'Weighted Average',
    sum:
      nonZeroRowCount > 0
        ? round(averageData.totalSum / nonZeroRowCount, 0)
        : 0,
    percentages: averageData.percentages.map(({ sum, weightedSum }) =>
      sum > 0 ? round(weightedSum / sum, 4) : null
    ),
    values: averageData.values.map(({ sum, weightedSum }) =>
      sum > 0 ? round(weightedSum / sum, valuePrecision) : null
    ),
  };

  return [averageRow, ...processed];
}
