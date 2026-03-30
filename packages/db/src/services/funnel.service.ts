import { ifNaN } from '@openpanel/common';
import type {
  IChartEvent,
  IChartEventItem,
  ICustomEventComponent,
  IReportInput,
} from '@openpanel/validation';
import { last, reverse, uniq } from 'ramda';
import sqlstring from 'sqlstring';
import { ch, chQuery } from '../clickhouse/client';
import { TABLE_NAMES } from '../clickhouse/client';
import { clix } from '../clickhouse/query-builder';
import { db } from '../prisma-client';
import { createSqlBuilder } from '../sql-builder';
import {
  getCustomEventWhereClause,
  getEventFiltersWhereClause,
  getSelectPropertyKey,
  getTraitBreakdownExpression,
} from './chart.service';

/** Display label for null/empty breakdown values (e.g. property not set). */
export const EMPTY_BREAKDOWN_LABEL = 'Not set';

function normalizeBreakdownValue(value: unknown): string {
  if (value == null || value === '') {
    return EMPTY_BREAKDOWN_LABEL;
  }
  const s = String(value).trim();
  return s === '' ? EMPTY_BREAKDOWN_LABEL : s;
}

/**
 * A resolved funnel step — either a regular event or a custom event
 * with its components resolved from PostgreSQL.
 */
export type ResolvedFunnelStep = IChartEvent & {
  customEventComponents?: ICustomEventComponent[];
};

/**
 * Resolves a series array (which may contain custom events) into
 * ResolvedFunnelStep[] that the funnel query builder can consume.
 */
export async function resolveSeriesForFunnel(
  series: IChartEventItem[],
  projectId: string,
): Promise<ResolvedFunnelStep[]> {
  const resolved: ResolvedFunnelStep[] = [];
  for (const item of series) {
    if (item.type === 'event') {
      resolved.push(item);
    } else if (item.type === 'custom_event') {
      const ce = await db.customEvent.findUnique({
        where: { id: item.customEventId },
      });
      if (!ce || ce.projectId !== projectId) {
        throw new Error(
          `Custom event "${item.displayName ?? item.customEventId}" not found or not accessible`,
        );
      }
      const components = ce.components as ICustomEventComponent[];
      if (!Array.isArray(components) || components.length === 0) {
        throw new Error(
          `Custom event "${ce.name}" has no components`,
        );
      }
      resolved.push({
        name: ce.name,
        displayName: item.displayName ?? ce.name,
        filters: item.filters ?? [],
        segment: item.segment ?? 'event',
        customEventComponents: components,
      });
    }
    // Skip 'formula' type — not relevant for funnels
  }
  return resolved;
}

export class FunnelService {
  constructor(private client: typeof ch) {}

  /**
   * Returns the grouping strategy for the funnel.
   * Note: windowFunnel is ALWAYS computed per session_id first to handle
   * identity changes mid-session (anonymous → logged-in).
   * The returned group is used for the final aggregation step.
   */
  getFunnelGroup(group?: string): 'profile_id' | 'session_id' {
    return group === 'session_id' ? 'session_id' : 'profile_id';
  }

  getFunnelConditions(events: ResolvedFunnelStep[] = [], projectId?: string): string[] {
    return events.map((event) => {
      if (event.customEventComponents) {
        // Custom event: use OR-combined component conditions
        const componentClause = getCustomEventWhereClause(
          event.customEventComponents,
          projectId,
        );
        // Also apply any outer series-level filters
        if (event.filters && event.filters.length > 0) {
          const outerWhere = getEventFiltersWhereClause(event.filters, projectId);
          const outerClauses = Object.values(outerWhere);
          if (outerClauses.length > 0) {
            return `(${componentClause} AND ${outerClauses.join(' AND ')})`;
          }
        }
        return componentClause;
      }
      // Regular event
      const { sb, getWhere } = createSqlBuilder();
      sb.where = getEventFiltersWhereClause(event.filters, projectId);
      sb.where.name = `name = ${sqlstring.escape(event.name)}`;
      return getWhere().replace('WHERE ', '');
    });
  }

  /**
   * Builds the funnel CTE.
   *
   * Session mode (default): computes windowFunnel per session_id and extracts
   * profile_id via argMax. Handles anonymous → identified transitions within
   * a single session.
   *
   * Profile mode: computes windowFunnel per profile_id directly, filtering
   * to identified users only (profile_id != device_id). Required for
   * cross-source funnels where steps come from different session_ids
   * (e.g. app SDK events + server webhook events).
   */
  buildFunnelCte({
    projectId,
    startDate,
    endDate,
    eventSeries,
    funnelWindowMilliseconds,
    timezone,
    groupBy = 'session_id',
    additionalSelects = [],
    additionalGroupBy = [],
  }: {
    projectId: string;
    startDate: string;
    endDate: string;
    eventSeries: ResolvedFunnelStep[];
    funnelWindowMilliseconds: number;
    timezone: string;
    groupBy?: 'session_id' | 'profile_id';
    additionalSelects?: string[];
    additionalGroupBy?: string[];
  }) {
    const funnels = this.getFunnelConditions(eventSeries, projectId);

    // Collect all real event names for the IN pre-filter.
    const allEventNames = uniq(
      eventSeries.flatMap((e) =>
        e.customEventComponents
          ? e.customEventComponents.map((c) => c.eventName)
          : [e.name],
      ),
    );

    const selects =
      groupBy === 'profile_id'
        ? [
            'profile_id',
            `windowFunnel(${funnelWindowMilliseconds}, 'strict_increase')(toUInt64(toUnixTimestamp64Milli(created_at)), ${funnels.join(', ')}) AS level`,
            ...additionalSelects,
          ]
        : [
            'session_id',
            `windowFunnel(${funnelWindowMilliseconds}, 'strict_increase')(toUInt64(toUnixTimestamp64Milli(created_at)), ${funnels.join(', ')}) AS level`,
            'argMax(profile_id, created_at) AS profile_id',
            ...additionalSelects,
          ];

    const query = clix(this.client, timezone)
      .select(selects)
      .from(TABLE_NAMES.events, false)
      .where('project_id', '=', projectId)
      .where('created_at', 'BETWEEN', [
        clix.datetime(startDate, 'toDateTime'),
        clix.datetime(endDate, 'toDateTime'),
      ])
      .where('name', 'IN', allEventNames)
      .groupBy([groupBy, ...additionalGroupBy]);

    // In profile mode, only include identified users to avoid
    // double-counting anonymous device_id-based profiles.
    if (groupBy === 'profile_id') {
      query.rawWhere('profile_id != device_id');
    }

    return query;
  }

  buildSessionsCte({
    projectId,
    startDate,
    endDate,
    timezone,
  }: {
    projectId: string;
    startDate: string;
    endDate: string;
    timezone: string;
  }) {
    return clix(this.client, timezone)
      .select(['profile_id as pid', 'id as sid'])
      .from(TABLE_NAMES.sessions)
      .where('project_id', '=', projectId)
      .where('created_at', 'BETWEEN', [
        clix.datetime(startDate, 'toDateTime'),
        clix.datetime(endDate, 'toDateTime'),
      ]);
  }

  private fillFunnel(
    funnel: { level: number; count: number }[],
    steps: number,
  ) {
    const filled = Array.from({ length: steps }, (_, index) => {
      const level = index + 1;
      const matchingResult = funnel.find((res) => res.level === level);
      return {
        level,
        count: matchingResult ? matchingResult.count : 0,
      };
    });

    // Accumulate counts from top to bottom of the funnel
    for (let i = filled.length - 1; i >= 0; i--) {
      const step = filled[i];
      const prevStep = filled[i + 1];
      // If there's a previous step, add the count to the current step
      if (step && prevStep) {
        step.count += prevStep.count;
      }
    }
    return filled.reverse();
  }

  toSeries(
    funnel: { level: number; count: number; [key: string]: any }[],
    breakdowns: { name: string }[] = [],
    limit: number | undefined = undefined,
  ) {
    if (!breakdowns.length) {
      return [
        funnel.map((f) => ({
          level: f.level,
          count: f.count,
          id: 'none',
          breakdowns: [],
        })),
      ];
    }

    // Group by breakdown values (normalize empty/null to "Not set")
    const series = funnel.reduce(
      (acc, f) => {
        if (limit && Object.keys(acc).length >= limit) {
          return acc;
        }

        const key = breakdowns
          .map((b, index) => normalizeBreakdownValue(f[`b_${index}`]))
          .join('|');
        if (!acc[key]) {
          acc[key] = [];
        }
        acc[key]!.push({
          id: key,
          breakdowns: breakdowns.map((b, index) =>
            normalizeBreakdownValue(f[`b_${index}`]),
          ),
          level: f.level,
          count: f.count,
        });
        return acc;
      },
      {} as Record<
        string,
        {
          id: string;
          breakdowns: string[];
          level: number;
          count: number;
        }[]
      >,
    );

    return Object.values(series);
  }

  getProfileFilters(events: ResolvedFunnelStep[]) {
    return events.flatMap((e) => {
      const outerProfileFilters = (e.filters ?? [])
        .filter((f) => f.name.startsWith('profile.'))
        .map((f) => f.name.replace('profile.', ''));
      const componentProfileFilters = (e.customEventComponents ?? [])
        .flatMap((c) => c.filters)
        .filter((f) => f.name.startsWith('profile.'))
        .map((f) => f.name.replace('profile.', ''));
      return [...outerProfileFilters, ...componentProfileFilters];
    });
  }

  async getFunnel({
    projectId,
    startDate,
    endDate,
    series,
    options,
    breakdowns = [],
    limit,
    timezone = 'UTC',
  }: IReportInput & { timezone: string; events?: IChartEvent[] }) {
    if (!startDate || !endDate) {
      throw new Error('startDate and endDate are required');
    }

    const funnelOptions = options?.type === 'funnel' ? options : undefined;
    const funnelWindowUnit = funnelOptions?.funnelWindowUnit ?? 'hour';
    // Default window is 24 hours. When unit is set but window is not,
    // convert 24 hours into the selected unit for a sensible default.
    const defaultWindowByUnit: Record<string, number> = {
      second: 86400,  // 24h in seconds
      minute: 1440,   // 24h in minutes
      hour: 24,       // 24h
      day: 1,         // 1 day
      week: 1,        // 1 week
      month: 1,       // 1 month
    };
    const funnelWindow =
      funnelOptions?.funnelWindow ?? (defaultWindowByUnit[funnelWindowUnit] ?? 24);
    const funnelGroup = funnelOptions?.funnelGroup;

    const eventSeries = await resolveSeriesForFunnel(series, projectId);

    if (eventSeries.length === 0) {
      throw new Error('events are required');
    }

    const unitMultipliers: Record<string, number> = {
      second: 1,
      minute: 60,
      hour: 3600,
      day: 86400,
      week: 604800,
      month: 2592000, // 30 days
    };
    const funnelWindowSeconds =
      funnelWindow * (unitMultipliers[funnelWindowUnit] ?? 3600);
    const funnelWindowMilliseconds = funnelWindowSeconds * 1000;
    const group = this.getFunnelGroup(funnelGroup);
    const profileFilters = this.getProfileFilters(eventSeries);
    const anyFilterOnProfile = profileFilters.length > 0;
    const anyBreakdownOnProfile = breakdowns.some((b) =>
      b.name.startsWith('profile.'),
    );

    // Breakdown step: which step's event to extract breakdown values from.
    // undefined = use GROUP BY (all steps, current behavior).
    // 0-based index = use argMaxIf to extract from that step's event only.
    const breakdownStep = funnelOptions?.breakdownStep;

    // Build breakdown selects.
    // When a specific step is selected, use argMaxIf to extract the breakdown
    // value from that step's event condition only. This prevents cross-event
    // property mismatches (e.g. app events vs webhook events with different properties).
    let breakdownSelects: string[];
    let breakdownGroupBy: string[];

    if (breakdownStep !== undefined && breakdownStep < eventSeries.length) {
      const stepConditions = this.getFunnelConditions(eventSeries, projectId);
      const stepCondition = stepConditions[breakdownStep]!;
      breakdownSelects = breakdowns.map(
        (b, index) =>
          `argMaxIf(${getTraitBreakdownExpression(b.name, projectId) ?? getSelectPropertyKey(b.name)}, created_at, ${stepCondition}) as b_${index}`,
      );
      // No GROUP BY for breakdown columns — argMaxIf aggregates them
      breakdownGroupBy = [];
    } else {
      breakdownSelects = breakdowns.map(
        (b, index) =>
          `${getTraitBreakdownExpression(b.name, projectId) ?? getSelectPropertyKey(b.name)} as b_${index}`,
      );
      breakdownGroupBy = breakdowns.map((_, index) => `b_${index}`);
    }

    const stepConditions = this.getFunnelConditions(eventSeries, projectId);

    const funnelCte = this.buildFunnelCte({
      projectId,
      startDate,
      endDate,
      eventSeries,
      funnelWindowMilliseconds,
      timezone,
      groupBy: group,
      additionalSelects: breakdownSelects,
      additionalGroupBy: breakdownGroupBy,
    });

    if (anyFilterOnProfile || anyBreakdownOnProfile) {
      // Collect profile columns needed for filters and breakdowns (same as conversion.service)
      const profileFields = new Set<string>(['id']);
      for (const f of profileFilters) {
        profileFields.add(f.split('.')[0]!);
      }
      for (const b of breakdowns.filter((x) => x.name.startsWith('profile.'))) {
        const fieldName = b.name.replace('profile.', '').split('.')[0];
        if (fieldName === 'properties') {
          profileFields.add('properties');
        } else if (['email', 'first_name', 'last_name'].includes(fieldName!)) {
          profileFields.add(fieldName!);
        }
      }
      const profileSelectColumns = Array.from(profileFields).join(', ');
      funnelCte.leftJoin(
        `(SELECT ${profileSelectColumns} FROM ${TABLE_NAMES.profiles} FINAL
          WHERE project_id = ${sqlstring.escape(projectId)}) as profile`,
        'profile.id = events.profile_id',
      );
    }

    // Base funnel query with CTEs
    const funnelQuery = clix(this.client, timezone);
    funnelQuery.with('session_funnel', funnelCte);

    if (group === 'profile_id') {
      // Profile mode: CTE already groups by profile_id, just filter level != 0.
      funnelQuery.with(
        'funnel',
        'SELECT * FROM session_funnel WHERE level != 0',
      );
    } else {
      // Session mode: filter out level = 0
      funnelQuery.with(
        'funnel',
        'SELECT * FROM session_funnel WHERE level != 0',
      );
    }

    funnelQuery
      .select<{
        level: number;
        count: number;
        [key: string]: any;
      }>([
        'level',
        ...breakdowns.map((b, index) => `b_${index}`),
        'count() as count',
      ])
      .from('funnel')
      .groupBy(['level', ...breakdowns.map((b, index) => `b_${index}`)])
      .orderBy('level', 'DESC');

    const queries = [funnelQuery.toSQL()];
    const funnelData = await funnelQuery.execute();
    const funnelSeries = this.toSeries(funnelData, breakdowns, limit);

    const data = funnelSeries
      .map((data) => {
        const maxLevel = eventSeries.length;
        const filledFunnelRes = this.fillFunnel(
          data.map((d) => ({ level: d.level, count: d.count })),
          maxLevel,
        );

        const totalSessions = last(filledFunnelRes)?.count ?? 0;
        const steps = reverse(filledFunnelRes)
          .reduce(
            (acc, item, index, list) => {
              const prev = list[index - 1] ?? { count: totalSessions };
              const next = list[index + 1];
              const event = eventSeries[item.level - 1]!;
              return [
                ...acc,
                {
                  event: {
                    ...event,
                    displayName: event.displayName || event.name,
                  },
                  count: item.count,
                  percent: (item.count / totalSessions) * 100,
                  dropoffCount: next ? item.count - next.count : null,
                  dropoffPercent: next
                    ? ((item.count - next.count) / item.count) * 100
                    : null,
                  previousCount: prev.count,
                  nextCount: next?.count ?? null,
                  medianTimeToConvertSeconds: null,
                  totalConversionCount: 0,
                  totalConversionPercent: 0,
                  stepConversionCount: 0,
                  stepConversionPercent: 0,
                },
              ];
            },
            [] as {
              event: IChartEvent & { displayName: string };
              count: number;
              percent: number;
              dropoffCount: number | null;
              dropoffPercent: number | null;
              previousCount: number;
              nextCount: number | null;
              medianTimeToConvertSeconds: number | null;
              totalConversionCount: number;
              totalConversionPercent: number;
              stepConversionCount: number;
              stepConversionPercent: number;
            }[],
          )
          .map((step, index, list) => {
            return {
              ...step,
              percent: ifNaN(step.percent, 0),
              dropoffPercent: ifNaN(step.dropoffPercent, 0),
              isHighestDropoff: (() => {
                // Skip if current step has no dropoff
                if (!step?.dropoffCount) return false;

                // Get maximum dropoff count, excluding 0s
                const maxDropoff = Math.max(
                  ...list
                    .map((s) => s.dropoffCount || 0)
                    .filter((count) => count > 0),
                );

                // Check if this is the first step with the highest dropoff
                return (
                  step.dropoffCount === maxDropoff &&
                  list.findIndex((s) => s.dropoffCount === maxDropoff) === index
                );
              })(),
            };
          });

        return {
          id: data[0]?.id ?? 'none',
          breakdowns: data[0]?.breakdowns ?? [],
          steps,
          totalSessions,
          lastStep: last(steps)!,
          mostDropoffsStep: steps.find((step) => step.isHighestDropoff)!,
        };
      })
      .sort((a, b) => {
        const aTotal = a.steps.reduce((acc, step) => acc + step.count, 0);
        const bTotal = b.steps.reduce((acc, step) => acc + step.count, 0);
        return bTotal - aTotal;
      });

    // Compute time-to-convert metrics using chained step timestamps.
    // Returns a map keyed by breakdown identity (e.g. 'none' or 'FOCUS_BADGE').
    let timingByBreakdown: Map<string, Record<string, number | null>> =
      new Map();
    if (stepConditions.length >= 2) {
      try {
        timingByBreakdown = await this.getFunnelTimingStats({
          projectId,
          startDate: startDate!,
          endDate: endDate!,
          stepConditions,
          funnelWindowSeconds,
          groupBy: group,
          allEventNames: uniq(
            eventSeries.flatMap((e) =>
              e.customEventComponents
                ? e.customEventComponents.map((c) => c.eventName)
                : [e.name],
            ),
          ),
          breakdowns,
          breakdownSelects,
          breakdownStep,
          eventSeries,
        });
      } catch {
        // Timing query failed — continue without timing data
      }
    }

    // Merge timing + conversion data into funnel steps.
    for (const series of data) {
      const lastStep = last(series.steps);
      const totalCount = lastStep?.count ?? 0;
      const firstCount = series.steps[0]?.count ?? 0;

      // Look up timing for this breakdown series
      const timingKey = series.id === 'none' ? 'none' : series.id;
      const timingData = timingByBreakdown.get(timingKey) ?? {};

      for (let i = 0; i < series.steps.length; i++) {
        const step = series.steps[i]!;
        const prevStep = i > 0 ? series.steps[i - 1] : null;

        const rawMedian = timingData[`step_${i}_median`];
        step.medianTimeToConvertSeconds =
          i === 0
            ? null
            : rawMedian != null && rawMedian >= 0
              ? Math.round(rawMedian)
              : null;
        step.totalConversionCount = totalCount;
        step.totalConversionPercent =
          firstCount > 0 ? (totalCount / firstCount) * 100 : 0;
        step.stepConversionCount = step.count;
        step.stepConversionPercent =
          i === 0
            ? 100
            : prevStep && prevStep.count > 0
              ? (step.count / prevStep.count) * 100
              : 0;
      }
    }

    return {
      data,
      queries,
    };
  }

  /**
   * Compute median time-to-convert for each funnel step using chained
   * timestamp extraction. Each step's timestamp is the earliest occurrence
   * AFTER the previous step's timestamp, within the funnel window.
   * Returns a Map keyed by breakdown identity (or 'none' if no breakdowns).
   */
  private async getFunnelTimingStats({
    projectId,
    startDate,
    endDate,
    stepConditions,
    funnelWindowSeconds,
    groupBy,
    allEventNames,
    breakdowns = [],
    breakdownSelects = [],
    breakdownStep,
    eventSeries,
  }: {
    projectId: string;
    startDate: string;
    endDate: string;
    stepConditions: string[];
    funnelWindowSeconds: number;
    groupBy: 'session_id' | 'profile_id';
    allEventNames: string[];
    breakdowns?: { name: string }[];
    breakdownSelects?: string[];
    breakdownStep?: number;
    eventSeries?: ResolvedFunnelStep[];
  }): Promise<Map<string, Record<string, number | null>>> {
    const result = new Map<string, Record<string, number | null>>();
    if (stepConditions.length < 2) {
      return result;
    }

    const entityKey = groupBy;
    const nameList = allEventNames
      .map((n) => sqlstring.escape(n))
      .join(', ');
    const identifiedFilter =
      groupBy === 'profile_id' ? 'AND profile_id != device_id' : '';

    const ctes: string[] = [];
    const hasBreakdowns = breakdowns.length > 0;

    // Step 1 CTE (no breakdown columns — timing CTEs are entity-scoped)
    ctes.push(`step_1 AS (
      SELECT ${entityKey},
        min(created_at) as step_1_ts
      FROM ${TABLE_NAMES.events}
      WHERE project_id = ${sqlstring.escape(projectId)}
        AND created_at BETWEEN toDateTime(${sqlstring.escape(startDate)}) AND toDateTime(${sqlstring.escape(endDate)})
        AND name IN (${nameList})
        ${identifiedFilter}
        AND (${stepConditions[0]})
      GROUP BY ${entityKey}
    )`);

    // Steps 2..N
    for (let i = 1; i < stepConditions.length; i++) {
      const prevCte = `step_${i}`;
      const currCte = `step_${i + 1}`;
      ctes.push(`${currCte} AS (
        SELECT prev.${entityKey} as ${entityKey},
          min(e.created_at) as ${currCte}_ts
        FROM ${prevCte} prev
        JOIN ${TABLE_NAMES.events} e ON e.${entityKey} = prev.${entityKey}
        JOIN step_1 s1 ON s1.${entityKey} = prev.${entityKey}
        WHERE e.project_id = ${sqlstring.escape(projectId)}
          AND e.created_at BETWEEN toDateTime(${sqlstring.escape(startDate)}) AND toDateTime(${sqlstring.escape(endDate)})
          AND e.name IN (${nameList})
          ${groupBy === 'profile_id' ? 'AND e.profile_id != e.device_id' : ''}
          AND (${stepConditions[i]})
          AND e.created_at > prev.${prevCte}_ts
          AND dateDiff('second', s1.step_1_ts, e.created_at) <= ${funnelWindowSeconds}
        GROUP BY prev.${entityKey}
      )`);
    }

    // If breakdowns exist, add a separate CTE that extracts breakdown values
    // from the correct step's events (determined by breakdownStep).
    // This avoids the bug where argMaxIf for step 2 would be applied inside
    // the step_1 CTE which only has step 1 events.
    //
    // Known limitations:
    // - profile.* breakdowns are not supported in timing queries (no profiles
    //   JOIN here). If used, the timing query will fail silently and medians
    //   will show as "—". The main funnel counts still work correctly.
    // - When breakdownStep is unset, timing_bd scans all events per entity,
    //   so if a user's breakdown value changes between steps, the same
    //   conversion time may appear in multiple groups. Use breakdownStep
    //   for precise segmented timing.
    if (hasBreakdowns) {
      const bdStepIdx = breakdownStep ?? 0;
      const bdStepCondition = stepConditions[bdStepIdx] ?? stepConditions[0]!;

      // Build breakdown expressions for the breakdown CTE.
      // For GROUP BY mode (breakdownStep undefined): use raw property + GROUP BY
      // For argMaxIf mode (breakdownStep set): use argMaxIf tied to the step condition
      let bdExprs: string[];
      let bdGroup: string[];
      if (breakdownStep !== undefined) {
        bdExprs = breakdowns.map(
          (b, i) =>
            `argMaxIf(${getTraitBreakdownExpression(b.name, projectId) ?? getSelectPropertyKey(b.name)}, created_at, ${bdStepCondition}) as b_${i}`,
        );
        bdGroup = [];
      } else {
        bdExprs = breakdowns.map(
          (b, i) =>
            `${getTraitBreakdownExpression(b.name, projectId) ?? getSelectPropertyKey(b.name)} as b_${i}`,
        );
        bdGroup = breakdowns.map((_, i) => `b_${i}`);
      }

      ctes.push(`timing_bd AS (
        SELECT ${entityKey}
          ${bdExprs.length > 0 ? `, ${bdExprs.join(', ')}` : ''}
        FROM ${TABLE_NAMES.events}
        WHERE project_id = ${sqlstring.escape(projectId)}
          AND created_at BETWEEN toDateTime(${sqlstring.escape(startDate)}) AND toDateTime(${sqlstring.escape(endDate)})
          AND name IN (${nameList})
          ${identifiedFilter}
        GROUP BY ${entityKey}${bdGroup.length > 0 ? `, ${bdGroup.join(', ')}` : ''}
      )`);
    }

    // Final aggregation
    const stepJoins: string[] = [];
    const medianSelects: string[] = [];

    for (let i = 1; i < stepConditions.length; i++) {
      const stepCte = `step_${i + 1}`;
      const tsCol = `${stepCte}.${stepCte}_ts`;
      const nullableTs = `nullIf(${tsCol}, toDateTime64(0, 3))`;
      stepJoins.push(
        `LEFT JOIN ${stepCte} ON s1.${entityKey} = ${stepCte}.${entityKey}`,
      );
      medianSelects.push(
        `quantileTDigestIf(0.5)(dateDiff('second', s1.step_1_ts, ${nullableTs}), isNotNull(${nullableTs})) as step_${i}_median`,
      );
    }

    // Join breakdown CTE if breakdowns exist
    let bdSelectsInFinal = '';
    let bdGroupByInFinal = '';
    if (hasBreakdowns) {
      stepJoins.push(
        `LEFT JOIN timing_bd bd ON s1.${entityKey} = bd.${entityKey}`,
      );
      bdSelectsInFinal =
        breakdowns.map((_, i) => `bd.b_${i}`).join(', ') + ',';
      bdGroupByInFinal =
        `GROUP BY ${breakdowns.map((_, i) => `bd.b_${i}`).join(', ')}`;
    }

    const sql = `
      WITH ${ctes.join(',\n')}
      SELECT
        ${bdSelectsInFinal}
        ${medianSelects.join(',\n')}
      FROM step_1 s1
      ${stepJoins.join('\n')}
      ${bdGroupByInFinal}
    `;

    const rows = await chQuery<Record<string, any>>(sql);

    if (breakdowns.length === 0) {
      result.set('none', rows[0] ?? {});
    } else {
      for (const row of rows) {
        const key = breakdowns
          .map((_, i) => normalizeBreakdownValue(row[`b_${i}`]))
          .join('|');
        result.set(key, row);
      }
    }

    return result;
  }
}

export const funnelService = new FunnelService(ch);
