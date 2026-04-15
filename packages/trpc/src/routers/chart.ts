import { flatten, map, pipe, prop, range, sort, uniq } from 'ramda';
import sqlstring from 'sqlstring';
import { z } from 'zod';

import {
  type IClickhouseProfile,
  type IServiceProfile,
  TABLE_NAMES,
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
  getTraitBreakdownDescriptor,
  qualifyFunnelCondition,
  type TraitBreakdown,
  getEventMetasCached,
  getProfilesCached,
  getReportById,
  getSelectPropertyKey,
  getSettingsForProject,
  onlyReportEvents,
  resolveSeriesForFunnel,
  sankeyService,
  validateShareAccess,
} from '@openpanel/db';
import {
  type IChartEvent,
  type IChartEventFilter,
  type ICustomEventComponent,
  zChartEventFilter,
  zChartSeries,
  zCriteria,
  zDateConfig,
  zRange,
  zReportInput,
  zTimeInterval,
} from '@openpanel/validation';

import { round } from '@openpanel/common';
import { AggregateChartEngine, ChartEngine } from '@openpanel/db';
import {
  differenceInDays,
  differenceInMonths,
  differenceInWeeks,
  formatISO,
} from 'date-fns';
import {
  getConcreteEventNameWhereClause,
  getRetentionReturnEventWhereClause,
} from './chart-retention.utils';
import { getProjectAccess } from '../access';
import { TRPCAccessError } from '../errors';
import {
  cacheMiddleware,
  createTRPCRouter,
  protectedProcedure,
  publicProcedure,
} from '../trpc';

function utc(date: string | Date) {
  if (typeof date === 'string') {
    return date.replace('T', ' ').slice(0, 19);
  }
  return formatISO(date).replace('T', ' ').slice(0, 19);
}

const cacher = cacheMiddleware(60);

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

  events: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        includeDropped: z.boolean().default(false),
      })
    )
    .query(async ({ input: { projectId, includeDropped } }) => {
      const PROTECTED_EVENTS = ['session_start', 'session_end', 'screen_view'];

      const [events, meta, customEvents] = await Promise.all([
        chQuery<{ name: string; count: number }>(
          `SELECT name, count(name) as count FROM ${TABLE_NAMES.event_names_mv} WHERE project_id = ${sqlstring.escape(projectId)} GROUP BY name ORDER BY count DESC, name ASC`
        ),
        getEventMetasCached(projectId),
        db.customEvent.findMany({ where: { projectId } }).catch((error) => {
          console.warn(
            'chart.events: failed to load custom events, falling back to event_names_mv only',
            error,
          );
          return [];
        }),
      ]);

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
          })),
          ...activeOnly,
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
        })),
        ...notDropped,
        ...dropped,
        ...droppedNotInCh,
      ];
    }),

  properties: protectedProcedure
    .input(
      z.object({
        event: z.string().optional(),
        projectId: z.string(),
        customEventId: z.string().optional(),
      })
    )
    .query(async ({ input: { projectId, event, customEventId } }) => {
      const profiles = await clix(ch, 'UTC')
        .select<Pick<IServiceProfile, 'properties'>>(['properties'])
        .from(TABLE_NAMES.profiles)
        .where('project_id', '=', projectId)
        .where('is_external', '=', true)
        .limit(10_000)
        .execute();

      const profileProperties = [
        ...new Set(
          profiles.flatMap((p) =>
            Object.keys(p.properties).map((k) => `profile.properties.${k}`)
          )
        ),
      ];

      // Also fetch trait keys from profile_traits table
      const traitKeys = await chQuery<{ key: string }>(
        `SELECT DISTINCT key FROM ${TABLE_NAMES.profile_traits} WHERE project_id = ${sqlstring.escape(projectId)} LIMIT 1000`
      );
      const traitProperties = traitKeys.map((t) => `profile.properties.${t.key}`);
      profileProperties.push(...traitProperties);

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

      // Resolve custom event to component event names for property filtering
      let propEventNames: string[] = [];
      if (customEventId) {
        const ce = await db.customEvent.findUnique({
          where: { id: customEventId },
        });
        if (ce && Array.isArray(ce.components)) {
          propEventNames = (ce.components as { eventName: string }[]).map(
            (c) => c.eventName,
          );
        }
      }
      if (propEventNames.length === 0 && event && event !== '*') {
        propEventNames = [event];
      }

      if (propEventNames.length === 1) {
        query.where('name', '=', propEventNames[0]!);
      } else if (propEventNames.length > 1) {
        query.where('name', 'IN', propEventNames);
      }

      const res = await query.execute();

      const eventProperties = res.map((item) => {
        const key = item.property_key
          .replace(/\.([0-9]+)\./g, '.*.')
          .replace(/\.([0-9]+)/g, '[*]');
        return `properties.${key}`;
      });

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
    .query(async ({ input: { event, property, projectId, customEventId, ...input } }) => {
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
            (c) => c.eventName,
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
        const traitKey = property.replace('profile.properties.', '').split('.')[0];
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
          .select<{ values: string[] }>([
            `distinct ${getSelectPropertyKey(property)} as values`,
          ])
          .from(TABLE_NAMES.events)
          .where('project_id', '=', projectId)
          .where('created_at', '>', clix.exp('now() - INTERVAL 30 DAY'))
          .orderBy('created_at', 'DESC')
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
    }),

  funnel: chartProcedure
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
      const previousPeriod = getChartPrevStartEndDate(currentPeriod);

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
      if (
        chartInput.chartType === 'funnel_metric' &&
        funnelOptions?.funnelProperty
      ) {
        const eventSeries = await resolveSeriesForFunnel(
          chartInput.series,
          chartInput.projectId,
        );
        const allEventNames = uniq(
          eventSeries.flatMap((e: any) =>
            e.customEventComponents
              ? e.customEventComponents.map((c: any) => c.eventName)
              : [e.name],
          ),
        );
        const stepConditions = funnelService.getFunnelConditions(
          eventSeries,
          chartInput.projectId,
        );

        const funnelWindowUnit = funnelOptions.funnelWindowUnit ?? 'hour';
        const unitMultipliers: Record<string, number> = {
          second: 1,
          minute: 60,
          hour: 3600,
          day: 86400,
          week: 604800,
          month: 2592000,
        };
        const defaultWindowByUnit: Record<string, number> = {
          second: 86400,
          minute: 1440,
          hour: 24,
          day: 1,
          week: 1,
          month: 1,
        };
        const funnelWindow =
          funnelOptions.funnelWindow ??
          (defaultWindowByUnit[funnelWindowUnit] ?? 24);
        const funnelWindowSeconds =
          funnelWindow * (unitMultipliers[funnelWindowUnit] ?? 3600);
        const group = funnelService.getFunnelGroup(funnelOptions.funnelGroup);

        const [currentSums, previousSums] = await Promise.all([
          funnelService.getFunnelPropertySums({
            projectId: chartInput.projectId,
            startDate: currentPeriod.startDate!,
            endDate: currentPeriod.endDate!,
            stepConditions,
            funnelWindowSeconds,
            groupBy: group,
            allEventNames,
            propertyKey: funnelOptions.funnelProperty,
            breakdowns: chartInput.breakdowns,
            breakdownStep: funnelOptions.breakdownStep,
            timezone,
          }),
          previous
            ? funnelService.getFunnelPropertySums({
                projectId: chartInput.projectId,
                startDate: previousPeriod.startDate!,
                endDate: previousPeriod.endDate!,
                stepConditions,
                funnelWindowSeconds,
                groupBy: group,
                allEventNames,
                propertyKey: funnelOptions.funnelProperty,
                breakdowns: chartInput.breakdowns,
                breakdownStep: funnelOptions.breakdownStep,
                timezone,
              })
            : Promise.resolve(null),
        ]);

        // Attach propertySum to the last step of each series
        for (const series of current.data) {
          const key = series.id === 'none' ? 'none' : series.id;
          const sum = currentSums.get(key) ?? 0;
          (series.lastStep as any).propertySum = sum;
        }
        if (previous) {
          for (const series of previous.data) {
            const key = series.id === 'none' ? 'none' : series.id;
            const sum = previousSums?.get(key) ?? 0;
            (series.lastStep as any).propertySum = sum;
          }
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
      const previousPeriod = getChartPrevStartEndDate(currentPeriod);

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

  sankey: protectedProcedure.input(zReportInput).query(async ({ input }) => {
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
        criteria: zCriteria.default('on_or_after'),
        startDate: z.string().nullish(),
        endDate: z.string().nullish(),
        interval: zTimeInterval.default('day'),
        range: zRange,
        dateConfig: zDateConfig.nullish(),
        shareId: z.string().optional(),
        id: z.string().optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      const projectId = ctx.report?.projectId ?? input.projectId;
      let firstEvent = input.firstEvent;
      let secondEvent = input.secondEvent;
      let firstEventFilters: IChartEventFilter[] = input.firstEventFilters;
      let secondEventFilters: IChartEventFilter[] = input.secondEventFilters;
      let criteria = input.criteria;
      const dateRange = ctx.report
        ? (input.range ?? ctx.report.range)
        : input.range;
      const startDate = ctx.report
        ? (input.startDate ?? ctx.report.startDate)
        : input.startDate;
      const endDate = ctx.report
        ? (input.endDate ?? ctx.report.endDate)
        : input.endDate;
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

        const firstItem = ctx.report.series[0];
        const secondItem = ctx.report.series[1];

        if (firstItem?.type === 'event') {
          firstEvent = (firstItem.filters?.[0]?.value ?? []).map(String);
          firstEventFilters = (firstItem.filters ?? []).slice(1);
        } else if (firstItem?.type === 'custom_event') {
          const ce = await db.customEvent.findUnique({
            where: { id: firstItem.customEventId },
          });
          if (ce?.components && ce.projectId === projectId) {
            const components = ce.components as ICustomEventComponent[];
            firstEvent = components.map((c) => c.eventName);
            firstEventCustomWhere = getCustomEventWhereClause(
              components,
              projectId,
            );
            firstComponentFilters = components.flatMap((c) => c.filters);
          }
          // Preserve outer series-level filters on the custom event
          firstEventFilters = (firstItem.filters ?? []);
        }

        if (secondItem?.type === 'event') {
          secondEvent = (secondItem.filters?.[0]?.value ?? []).map(String);
          secondEventFilters = (secondItem.filters ?? []).slice(1);
        } else if (secondItem?.type === 'custom_event') {
          const ce = await db.customEvent.findUnique({
            where: { id: secondItem.customEventId },
          });
          if (ce?.components && ce.projectId === projectId) {
            const components = ce.components as ICustomEventComponent[];
            secondEvent = components.map((c) => c.eventName);
            secondEventCustomWhere = getCustomEventWhereClause(
              components,
              projectId,
            );
            secondComponentFilters = components.flatMap((c) => c.filters);
          }
          // Preserve outer series-level filters on the custom event
          secondEventFilters = (secondItem.filters ?? []);
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
            projectId,
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
            projectId,
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
      const diffInterval = {
        minute: () => differenceInDays(dates.endDate, dates.startDate),
        hour: () => differenceInDays(dates.endDate, dates.startDate),
        day: () => differenceInDays(dates.endDate, dates.startDate),
        week: () => differenceInWeeks(dates.endDate, dates.startDate),
        month: () => differenceInMonths(dates.endDate, dates.startDate),
      }[interval]();
      const sqlInterval = {
        minute: 'DAY',
        hour: 'DAY',
        day: 'DAY',
        week: 'WEEK',
        month: 'MONTH',
      }[interval];

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

      const countCriteria = criteria === 'on_or_after' ? '>=' : '=';

      const usersSelect = range(0, diffInterval + 1)
        .map(
          (index) =>
            `groupUniqArrayIf(profile_id, x_after_cohort ${countCriteria} ${index}) AS interval_${index}_users`
        )
        .join(',\n');

      const countsSelect = range(0, diffInterval + 1)
        .map(
          (index) =>
            `length(interval_${index}_users) AS interval_${index}_user_count`
        )
        .join(',\n');

      // Determine which table to use: events table when any non-profile
      // filter is present (cohort_events_mv only has project_id, name,
      // created_at, profile_id, event_count — no properties/path/country/etc).
      // Profile-only filters are handled via a JOIN, so the MV suffices.
      // Custom events with component filters also need the events table.
      const needsEventsTable = (filters: IChartEventFilter[]) =>
        filters.some((f) => !f.name.startsWith('profile.') && f.name !== 'has_profile');

      const useEventsFirst =
        !!firstEventCustomWhere ||
        needsEventsTable(firstEventFilters) ||
        needsEventsTable(firstComponentFilters);
      const useEventsSecond =
        !!secondEventCustomWhere ||
        needsEventsTable(secondEventFilters) ||
        needsEventsTable(secondComponentFilters);
      const firstEventTable = useEventsFirst
        ? TABLE_NAMES.events
        : TABLE_NAMES.cohort_events_mv;
      const secondEventTable = useEventsSecond
        ? TABLE_NAMES.events
        : TABLE_NAMES.cohort_events_mv;

      // Build profile JOIN clause (only needed for profile.* filters)
      const buildProfileJoin = (filters: IChartEventFilter[]) => {
        const profileFilters = filters
          .filter((f) => f.name.startsWith('profile.'))
          .map((f) => f.name.replace('profile.', ''));
        if (profileFilters.length === 0) return '';
        const columns = uniq(profileFilters.map((f) => f.split('.')[0])).join(', ');
        return `LEFT ANY JOIN (SELECT id, ${columns} FROM ${TABLE_NAMES.profiles} FINAL WHERE project_id = ${sqlstring.escape(projectId)}) AS profile ON profile.id = profile_id`;
      };

      const buildFilterWhere = (filters: IChartEventFilter[]) => {
        if (filters.length === 0) return '';
        const where = getEventFiltersWhereClause(filters, projectId);
        const clauses = Object.values(where);
        if (clauses.length === 0) return '';
        return `AND ${clauses.join(' AND ')}`;
      };

      // Include both outer series filters AND component-level filters for profile JOINs
      const firstEventJoin = buildProfileJoin([
        ...firstEventFilters,
        ...firstComponentFilters,
      ]);
      const firstEventWhere = buildFilterWhere(firstEventFilters);
      const secondEventJoin = buildProfileJoin([
        ...secondEventFilters,
        ...secondComponentFilters,
      ]);
      const secondEventWhere = buildFilterWhere(secondEventFilters);

      // cohort_events_mv pre-filters to identified users (profile_id != device_id).
      // When falling back to the raw events table, replicate that condition.
      const firstIdentifiedFilter = useEventsFirst ? 'AND profile_id != device_id' : '';
      const secondIdentifiedFilter = useEventsSecond ? 'AND profile_id != device_id' : '';

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

      const cohortQuery = `
        WITH
        cohort_users AS (
          SELECT
            profile_id AS userID,
            project_id,
            ${toStartOfInterval('created_at')} AS cohort_interval
          FROM ${firstEventTable}
          ${firstEventJoin}
          WHERE ${firstWhereClause}
            AND project_id = ${sqlstring.escape(projectId)}
            AND created_at BETWEEN toDate('${utc(dates.startDate)}', '${timezone}') AND toDate('${utc(dates.endDate)}', '${timezone}')
            ${firstIdentifiedFilter}
            ${firstFilterClause}
        ),
        last_event AS
        (
            SELECT
                profile_id,
                project_id,
                toDate(created_at, '${timezone}') AS event_date
            FROM ${secondEventTable}
            ${secondEventJoin}
            WHERE ${secondWhereClause}
            AND project_id = ${sqlstring.escape(projectId)}
            AND created_at BETWEEN toDate('${utc(dates.startDate)}', '${timezone}') AND toDate('${utc(dates.endDate)}', '${timezone}') + INTERVAL ${diffInterval} ${sqlInterval}
            ${secondIdentifiedFilter}
            ${secondFilterClause}
        ),
        retention_matrix AS
        (
          SELECT
              f.cohort_interval,
              l.profile_id,
              dateDiff('${sqlInterval}', f.cohort_interval, ${toStartOfInterval('l.event_date')}) AS x_after_cohort
          FROM cohort_users AS f
          INNER JOIN last_event AS l ON f.userID = l.profile_id
          WHERE (l.event_date >= f.cohort_interval)
          AND (l.event_date <= (f.cohort_interval + INTERVAL ${diffInterval} ${sqlInterval}))
        ),
        interval_users AS (
          SELECT
            cohort_interval,
            ${usersSelect}
          FROM retention_matrix
          GROUP BY cohort_interval
        ),
        cohort_sizes AS (
          SELECT
            cohort_interval,
            COUNT(DISTINCT userID) AS total_first_event_count
          FROM cohort_users
          GROUP BY cohort_interval
        )
        SELECT
          cohort_interval,
          cohort_sizes.total_first_event_count,
          ${countsSelect}
        FROM interval_users
        LEFT JOIN cohort_sizes AS cs ON cohort_interval = cs.cohort_interval
        ORDER BY cohort_interval ASC
      `;

      const cohortData = await chQuery<{
        cohort_interval: string;
        total_first_event_count: number;
        [key: string]: any;
      }>(cohortQuery);

      return {
        data: processCohortData(cohortData, diffInterval, dates.startDate, dates.endDate, interval),
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
        funnelWindowUnit: z.enum(['second', 'minute', 'hour', 'day', 'week', 'month']).optional(),
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
        day: 86400,
        week: 604800,
        month: 2592000,
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
        projectId,
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
        (f) => getTraitBreakdownDescriptor(`profile.${f}`) === null,
      );
      const breakdownProfileFields = breakdownDims
        .filter(
          (b) =>
            b.name.startsWith('profile.') &&
            getTraitBreakdownDescriptor(b.name) === null,
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
                  stepConditions[breakdownStepIdx]!,
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
        expectProfilesFinalJoin:
          anyFilterOnProfile || anyBreakdownOnProfile,
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
        for (let i = 0; i < breakdownVals.length && i < breakdownDims.length; i++) {
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

      // Fetch profile details in batches to avoid exceeding ClickHouse max_query_size
      // when there are many profile IDs to pass in the IN(...) clause
      const ids = profileIdsResult.map((p) => p.profile_id).filter(Boolean);
      const BATCH_SIZE = 500;
      const profiles = [];
      for (let i = 0; i < ids.length; i += BATCH_SIZE) {
        const batch = ids.slice(i, i + BATCH_SIZE);
        const batchProfiles = await getProfilesCached(batch, projectId);
        profiles.push(...batchProfiles);
      }

      return profiles;
    }),
});

function processCohortData(
  data: Array<{
    cohort_interval: string;
    total_first_event_count: number;
    [key: string]: any;
  }>,
  diffInterval: number,
  startDate?: string,
  endDate?: string,
  interval?: string,
) {
  const processed = data.map((row) => {
    const sum = row.total_first_event_count;
    const values = range(0, diffInterval + 1).map(
      (index) => (row[`interval_${index}_user_count`] || 0) as number
    );

    return {
      cohort_interval: row.cohort_interval,
      sum,
      values: values,
      percentages: values.map((value) => (sum > 0 ? round(value / sum, 4) : 0)),
    };
  });

  // Fill in missing dates with zero rows
  if (startDate && endDate) {
    const existingDates = new Set(processed.map((r) => r.cohort_interval));
    let start = new Date(startDate.slice(0, 10));
    // Handle endDate that spills into next day due to +1ms rounding
    // e.g. "2026-04-09 00:00:00" should be treated as Apr 8, not Apr 9
    let end = new Date(endDate.slice(0, 10));
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
    processed.sort((a, b) => a.cohort_interval.localeCompare(b.cohort_interval));
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
    if (row.sum === 0) return; // skip synthetic zero rows
    nonZeroRowCount++;
    averageData.totalSum += row.sum;
    row.values.forEach((value, index) => {
      if (value !== 0) {
        averageData.values[index]!.sum += row.sum;
        averageData.values[index]!.weightedSum += value * row.sum;
      }
    });
    row.percentages.forEach((percentage, index) => {
      if (percentage !== 0) {
        averageData.percentages[index]!.sum += row.sum;
        averageData.percentages[index]!.weightedSum += percentage * row.sum;
      }
    });
  });

  // Calculate weighted average values, excluding zeros
  const averageRow = {
    cohort_interval: 'Weighted Average',
    sum: nonZeroRowCount > 0 ? round(averageData.totalSum / nonZeroRowCount, 0) : 0,
    percentages: averageData.percentages.map(({ sum, weightedSum }) =>
      sum > 0 ? round(weightedSum / sum, 4) : 0
    ),
    values: averageData.values.map(({ sum, weightedSum }) =>
      sum > 0 ? round(weightedSum / sum, 0) : 0
    ),
  };

  return [averageRow, ...processed];
}
