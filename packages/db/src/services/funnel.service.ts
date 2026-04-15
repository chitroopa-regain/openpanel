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
  getTraitBreakdownDescriptor,
  type TraitBreakdown,
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
 * Qualify bare event-table column references with an alias when a trait CTE
 * (or other sibling alias) is joined into a funnel CTE. Required to prevent
 * AMBIGUOUS_IDENTIFIER errors and silently wrong resolution once the main
 * events source has multiple sibling tables that expose `profile_id`.
 *
 * Conservative: walks the string and only qualifies identifiers at the outer
 * scope. It explicitly:
 *   - skips the contents of `'...'` string literals (so event names with
 *     spaces, reserved words, etc. pass through unchanged)
 *   - skips the contents of `IN (...)` / `NOT IN (...)` subqueries (the
 *     inner `profile_id FROM profile_traits` stays bare, bound to the
 *     subquery's own FROM)
 *   - leaves already-qualified references alone (anything preceded by `.`)
 *
 * Covers the event columns that funnel condition builders actually emit:
 * profile_id, device_id, created_at, name, properties. Other columns pass
 * through untouched.
 */
function qualifyFunnelCondition(expr: string, alias = 'events'): string {
  const columnPattern = /^\b(profile_id|device_id|created_at|name|properties)\b/;
  let result = '';
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i]!;

    // String literal — emit verbatim up to the closing quote
    if (ch === "'") {
      result += ch;
      i++;
      while (i < expr.length && expr[i] !== "'") {
        if (expr[i] === '\\' && i + 1 < expr.length) {
          result += expr[i]! + expr[i + 1]!;
          i += 2;
        } else {
          result += expr[i]!;
          i++;
        }
      }
      if (i < expr.length) {
        result += expr[i]!;
        i++;
      }
      continue;
    }

    // `IN (...)` / `NOT IN (...)` subquery — skip its contents so inner
    // profile_id references stay bound to the subquery's own FROM.
    const inMatch = expr.slice(i).match(/^(\s+(?:NOT\s+)?IN\s*)\(/i);
    if (inMatch) {
      result += inMatch[0];
      i += inMatch[0].length;
      let depth = 1;
      while (i < expr.length && depth > 0) {
        const cc = expr[i]!;
        if (cc === "'") {
          // Pass through inner string literals untouched
          result += cc;
          i++;
          while (i < expr.length && expr[i] !== "'") {
            if (expr[i] === '\\' && i + 1 < expr.length) {
              result += expr[i]! + expr[i + 1]!;
              i += 2;
            } else {
              result += expr[i]!;
              i++;
            }
          }
          if (i < expr.length) {
            result += expr[i]!;
            i++;
          }
          continue;
        }
        if (cc === '(') depth++;
        else if (cc === ')') depth--;
        result += cc;
        i++;
      }
      continue;
    }

    // Bare column identifier at a word boundary — qualify unless already prefixed
    const colMatch = expr.slice(i).match(columnPattern);
    if (colMatch) {
      const prevChar = i > 0 ? expr[i - 1]! : '';
      if (prevChar === '.') {
        // Already qualified — pass through unchanged
        result += colMatch[1]!;
      } else {
        result += `${alias}.${colMatch[1]!}`;
      }
      i += colMatch[1]!.length;
      continue;
    }

    result += ch;
    i++;
  }
  return result;
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
        id: item.id,
        name: ce.name,
        displayName: item.displayName ?? ce.name,
        filters: item.filters ?? [],
        segment: item.segment ?? 'event',
        firstTimeFilter: item.firstTimeFilter,
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

  /**
   * @param firstTimeCteAliases — per-step CTE join alias (e.g. 'ft_0') when
   *   firstTimeFilter is enabled, or empty string when not. The alias is used
   *   to append `AND ft_0.ft_profile_id != ''` to the step condition.
   */
  getFunnelConditions(
    events: ResolvedFunnelStep[] = [],
    projectId?: string,
    firstTimeCteAliases: string[] = [],
  ): string[] {
    return events.map((event, index) => {
      let condition: string;
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
            condition = `(${componentClause} AND ${outerClauses.join(' AND ')})`;
          } else {
            condition = componentClause;
          }
        } else {
          condition = componentClause;
        }
      } else {
        // Regular event
        const { sb, getWhere } = createSqlBuilder();
        sb.where = getEventFiltersWhereClause(event.filters, projectId);
        sb.where.name = `name = ${sqlstring.escape(event.name)}`;
        condition = getWhere().replace('WHERE ', '');
      }

      // Append first-time-ever check if CTE alias is provided
      const ftAlias = firstTimeCteAliases[index];
      if (ftAlias) {
        condition = `(${condition} AND ${ftAlias}.ft_profile_id != '')`;
      }

      return condition;
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
    traitDescriptors = new Map(),
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
    traitDescriptors?: Map<string, TraitBreakdown>;
  }) {
    // Build first-time-ever CTEs and JOIN aliases for steps that have firstTimeFilter
    const firstTimeCteAliases: string[] = [];
    const firstTimeCtes: { name: string; sql: string }[] = [];
    const escapedProject = sqlstring.escape(projectId);
    const escapedStart = sqlstring.escape(startDate);
    const escapedEnd = sqlstring.escape(endDate);

    for (let i = 0; i < eventSeries.length; i++) {
      const step = eventSeries[i]!;
      if (step.firstTimeFilter) {
        const alias = `ft_${i}`;
        firstTimeCteAliases.push(alias);
        // Build the step predicate for the CTE (same logic as getFunnelConditions)
        let stepPredicate: string;
        if (step.customEventComponents) {
          stepPredicate = getCustomEventWhereClause(step.customEventComponents, projectId);
        } else {
          stepPredicate = `name = ${sqlstring.escape(step.name)}`;
        }
        firstTimeCtes.push({
          name: `first_time_step_${i}`,
          sql: `SELECT profile_id as ft_profile_id FROM ${TABLE_NAMES.events} WHERE project_id = ${escapedProject} AND ${stepPredicate} GROUP BY ft_profile_id HAVING min(created_at) >= toDateTime(${escapedStart}) AND min(created_at) <= toDateTime(${escapedEnd})`,
        });
      } else {
        firstTimeCteAliases.push('');
      }
    }

    const rawFunnels = this.getFunnelConditions(eventSeries, projectId, firstTimeCteAliases);

    // Once a trait CTE is joined, every bare event-column reference in this
    // query becomes ambiguous. Qualify step conditions and static column refs
    // with the `events.` alias (the bare table name, since clix's .from() does
    // not apply an explicit alias). Subqueries inside `profile_id IN (...)`
    // are preserved by qualifyFunnelCondition's subquery skip logic.
    const needsQualify = traitDescriptors.size > 0;
    const qualify = (expr: string) =>
      needsQualify ? qualifyFunnelCondition(expr, 'events') : expr;
    const col = (c: string) => (needsQualify ? `events.${c}` : c);

    const funnels = needsQualify ? rawFunnels.map((c) => qualify(c)) : rawFunnels;

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
            `${col('profile_id')} AS profile_id`,
            `windowFunnel(${funnelWindowMilliseconds}, 'strict_increase')(toUInt64(toUnixTimestamp64Milli(${col('created_at')})), ${funnels.join(', ')}) AS level`,
            ...additionalSelects,
          ]
        : [
            `${col('session_id')} AS session_id`,
            `windowFunnel(${funnelWindowMilliseconds}, 'strict_increase')(toUInt64(toUnixTimestamp64Milli(${col('created_at')})), ${funnels.join(', ')}) AS level`,
            `argMax(${col('profile_id')}, ${col('created_at')}) AS profile_id`,
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
      // When trait CTEs are joined, group by the qualified column (the select
      // aliases it back to the bare name, so downstream refs still work).
      .groupBy([
        needsQualify && (groupBy === 'profile_id' || groupBy === 'session_id')
          ? `events.${groupBy}`
          : groupBy,
        ...additionalGroupBy,
      ]);

    // Add first-time LEFT JOINs (CTEs are returned separately for the outer query)
    for (let i = 0; i < firstTimeCteAliases.length; i++) {
      const alias = firstTimeCteAliases[i];
      if (alias) {
        query.leftJoin(
          `first_time_step_${i}`,
          `${alias}.ft_profile_id = events.profile_id`,
          alias,
        );
      }
    }

    // Add trait LEFT ANY JOINs for profile trait breakdowns.
    // Each trait CTE is registered at the outer query level; the JOIN here
    // is inside the session_funnel CTE so trait_<key>.profile_id joins
    // unambiguously against events.profile_id.
    for (const desc of traitDescriptors.values()) {
      query.leftAnyJoin(
        desc.cteName,
        `${desc.cteName}.profile_id = events.profile_id`,
      );
    }

    // In profile mode, only include identified users to avoid
    // double-counting anonymous device_id-based profiles.
    if (groupBy === 'profile_id') {
      query.rawWhere(
        needsQualify
          ? 'events.profile_id != events.device_id'
          : 'profile_id != device_id',
      );
    }

    return { query, firstTimeCtes };
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
    // profile.properties.* breakdowns use profile_traits CTE (traitDescriptors);
    // only profile.<scalar> breakdowns like profile.email still need the profiles CTE.
    const anyBreakdownOnProfile = breakdowns.some(
      (b) =>
        b.name.startsWith('profile.') &&
        getTraitBreakdownDescriptor(b.name) === null,
    );

    // Breakdown step: which step's event to extract breakdown values from.
    // undefined = use GROUP BY (all steps, current behavior).
    // 0-based index = use argMaxIf to extract from that step's event only.
    const breakdownStep = funnelOptions?.breakdownStep;

    // Build trait CTE descriptors for all profile.properties.* breakdowns.
    // The old path used getTraitBreakdownExpression() which emitted a correlated
    // subquery where the unqualified profile_id resolved to the inner table alias,
    // producing a global scalar (same value for every row) instead of per-profile
    // values. Replace with a CTE + LEFT ANY JOIN approach (same fix as d4f4e544
    // for chart.service.ts).
    const traitDescriptors = new Map<string, TraitBreakdown>();
    for (const b of breakdowns) {
      const desc = getTraitBreakdownDescriptor(b.name);
      if (desc && !traitDescriptors.has(desc.key)) {
        traitDescriptors.set(desc.key, desc);
      }
    }

    // Helper: return the correct SQL expression for a breakdown column.
    // Trait breakdowns use the CTE column reference; event-property breakdowns
    // fall back to getSelectPropertyKey (unchanged behaviour).
    const breakdownExpr = (name: string): string => {
      const desc = getTraitBreakdownDescriptor(name);
      if (desc && traitDescriptors.has(desc.key)) {
        return desc.column; // fully-qualified: trait_<key>.value
      }
      return getSelectPropertyKey(name);
    };

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
          `argMaxIf(${breakdownExpr(b.name)}, created_at, ${stepCondition}) as b_${index}`,
      );
      // No GROUP BY for breakdown columns — argMaxIf aggregates them
      breakdownGroupBy = [];
    } else {
      breakdownSelects = breakdowns.map(
        (b, index) => `${breakdownExpr(b.name)} as b_${index}`,
      );
      breakdownGroupBy = breakdowns.map((_, index) => `b_${index}`);
    }

    const stepConditions = this.getFunnelConditions(eventSeries, projectId);

    const { query: funnelCte, firstTimeCtes } = this.buildFunnelCte({
      projectId,
      startDate: startDate!,
      endDate: endDate!,
      eventSeries,
      funnelWindowMilliseconds,
      timezone,
      groupBy: group,
      additionalSelects: breakdownSelects,
      additionalGroupBy: breakdownGroupBy,
      traitDescriptors,
    });

    if (anyFilterOnProfile || anyBreakdownOnProfile) {
      // Collect profile columns needed for filters and breakdowns (same as conversion.service)
      const profileFields = new Set<string>(['id']);
      for (const f of profileFilters) {
        profileFields.add(f.split('.')[0]!);
      }
      // Only scalar profile.<field> breakdowns need columns from profiles FINAL.
      // Trait breakdowns (profile.properties.*) resolve via the trait CTE.
      for (const b of breakdowns.filter(
        (x) =>
          x.name.startsWith('profile.') &&
          getTraitBreakdownDescriptor(x.name) === null,
      )) {
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

    // Add first-time CTEs at the top level (NOT nested inside session_funnel)
    for (const cte of firstTimeCtes) {
      funnelQuery.with(cte.name, cte.sql);
    }

    // Register trait CTEs at the top level so they are visible inside
    // session_funnel. The LEFT ANY JOIN on events.profile_id is added inside
    // buildFunnelCte (via traitDescriptors) — these CTEs must precede
    // session_funnel in the WITH clause.
    for (const desc of traitDescriptors.values()) {
      funnelQuery.with(
        desc.cteName,
        `SELECT profile_id, argMax(value, updated_at) AS value FROM ${TABLE_NAMES.profile_traits} WHERE project_id = ${sqlstring.escape(projectId)} AND key = ${sqlstring.escape(desc.key)} GROUP BY profile_id`,
      );
    }

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
    // - When breakdownStep is unset, timing_bd scans all events per entity,
    //   so if a user's breakdown value changes between steps, the same
    //   conversion time may appear in multiple groups. Use breakdownStep
    //   for precise segmented timing.
    // - In session_id groupBy mode, the trait CTE joins on raw events.profile_id
    //   (per-event), so sessions that transition from anonymous to identified
    //   may pick the trait from either profile.
    if (hasBreakdowns) {
      const bdStepIdx = breakdownStep ?? 0;
      const rawBdStepCondition = stepConditions[bdStepIdx] ?? stepConditions[0]!;

      // Build trait CTE descriptors + LEFT ANY JOINs for profile trait
      // breakdowns (same fix as d4f4e544 for chart.service.ts). Trait values
      // come from the pre-aggregated CTE via a qualified join on
      // trait_<key>.profile_id = e.profile_id, replacing the buggy correlated
      // subquery path that resolved to a global scalar.
      const traitDescriptors = new Map<string, TraitBreakdown>();
      for (const b of breakdowns) {
        const desc = getTraitBreakdownDescriptor(b.name);
        if (desc && !traitDescriptors.has(desc.key)) {
          traitDescriptors.set(desc.key, desc);
        }
      }
      // Register trait CTEs BEFORE timing_bd (CTEs must precede their refs)
      for (const desc of traitDescriptors.values()) {
        ctes.push(
          `${desc.cteName} AS (SELECT profile_id, argMax(value, updated_at) AS value FROM ${TABLE_NAMES.profile_traits} WHERE project_id = ${sqlstring.escape(projectId)} AND key = ${sqlstring.escape(desc.key)} GROUP BY profile_id)`,
        );
      }
      const traitJoins = Array.from(traitDescriptors.values())
        .map(
          (desc) =>
            `LEFT ANY JOIN ${desc.cteName} ON ${desc.cteName}.profile_id = e.profile_id`,
        )
        .join('\n          ');

      // Once a trait CTE is joined, bare column references in bdStepCondition
      // (profile_id, device_id, etc.) become ambiguous. Qualify with the `e`
      // alias; subqueries and string literals are preserved.
      const needsQualify = traitDescriptors.size > 0;
      const bdStepCondition = needsQualify
        ? qualifyFunnelCondition(rawBdStepCondition, 'e')
        : rawBdStepCondition;

      // Helper: return the correct SQL expression for each breakdown column.
      // Trait breakdowns use the fully-qualified CTE column; other breakdowns
      // fall back to getSelectPropertyKey (event property expression).
      const breakdownExpr = (name: string): string => {
        const desc = getTraitBreakdownDescriptor(name);
        if (desc && traitDescriptors.has(desc.key)) {
          return desc.column;
        }
        return getSelectPropertyKey(name);
      };

      // Build breakdown expressions for the breakdown CTE.
      // For GROUP BY mode (breakdownStep undefined): use raw property + GROUP BY
      // For argMaxIf mode (breakdownStep set): use argMaxIf tied to the step condition
      let bdExprs: string[];
      let bdGroup: string[];
      if (breakdownStep !== undefined) {
        bdExprs = breakdowns.map(
          (b, i) =>
            `argMaxIf(${breakdownExpr(b.name)}, e.created_at, ${bdStepCondition}) as b_${i}`,
        );
        bdGroup = [];
      } else {
        bdExprs = breakdowns.map(
          (b, i) => `${breakdownExpr(b.name)} as b_${i}`,
        );
        bdGroup = breakdowns.map((_, i) => `b_${i}`);
      }

      const timingIdentifiedFilter =
        groupBy === 'profile_id' ? 'AND e.profile_id != e.device_id' : '';

      ctes.push(`timing_bd AS (
        SELECT e.${entityKey} AS ${entityKey}
          ${bdExprs.length > 0 ? `, ${bdExprs.join(', ')}` : ''}
        FROM ${TABLE_NAMES.events} AS e
          ${traitJoins}
        WHERE e.project_id = ${sqlstring.escape(projectId)}
          AND e.created_at BETWEEN toDateTime(${sqlstring.escape(startDate)}) AND toDateTime(${sqlstring.escape(endDate)})
          AND e.name IN (${nameList})
          ${timingIdentifiedFilter}
        GROUP BY e.${entityKey}${bdGroup.length > 0 ? `, ${bdGroup.join(', ')}` : ''}
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

  /**
   * Compute the SUM of a numeric property for entities that completed the
   * entire funnel. Uses chained CTEs (same pattern as getFunnelTimingStats)
   * to pin the exact last-step timestamp per entity, then extracts the
   * property value at that timestamp.
   *
   * Returns a Map keyed by breakdown identity (or 'none' if no breakdowns).
   */
  async getFunnelPropertySums({
    projectId,
    startDate,
    endDate,
    stepConditions,
    funnelWindowSeconds,
    groupBy,
    allEventNames,
    propertyKey,
    breakdowns = [],
    breakdownStep,
  }: {
    projectId: string;
    startDate: string;
    endDate: string;
    stepConditions: string[];
    funnelWindowSeconds: number;
    groupBy: 'session_id' | 'profile_id';
    allEventNames: string[];
    propertyKey: string;
    breakdowns?: { name: string }[];
    breakdownStep?: number;
  }): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (stepConditions.length < 1) {
      return result;
    }

    const entityKey = groupBy;
    const nameList = allEventNames
      .map((n) => sqlstring.escape(n))
      .join(', ');
    const identifiedFilter =
      groupBy === 'profile_id' ? 'AND profile_id != device_id' : '';

    const ctes: string[] = [];
    const lastStepIdx = stepConditions.length; // 1-based
    const hasBreakdowns = breakdowns.length > 0;

    // Step 1 CTE
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

    // Breakdown CTE (same pattern as timing). Uses trait CTE + LEFT ANY JOIN
    // instead of the buggy correlated subquery path (see d4f4e544).
    if (hasBreakdowns) {
      const bdStepIdx = breakdownStep ?? 0;
      const rawBdStepCondition = stepConditions[bdStepIdx] ?? stepConditions[0]!;

      // Build trait CTE descriptors for profile trait breakdowns
      const traitDescriptors = new Map<string, TraitBreakdown>();
      for (const b of breakdowns) {
        const desc = getTraitBreakdownDescriptor(b.name);
        if (desc && !traitDescriptors.has(desc.key)) {
          traitDescriptors.set(desc.key, desc);
        }
      }
      // Register trait CTEs BEFORE prop_bd (CTEs must precede their refs)
      for (const desc of traitDescriptors.values()) {
        ctes.push(
          `${desc.cteName} AS (SELECT profile_id, argMax(value, updated_at) AS value FROM ${TABLE_NAMES.profile_traits} WHERE project_id = ${sqlstring.escape(projectId)} AND key = ${sqlstring.escape(desc.key)} GROUP BY profile_id)`,
        );
      }
      const traitJoins = Array.from(traitDescriptors.values())
        .map(
          (desc) =>
            `LEFT ANY JOIN ${desc.cteName} ON ${desc.cteName}.profile_id = e.profile_id`,
        )
        .join('\n          ');

      // Qualify bdStepCondition when trait CTEs are joined — bare profile_id
      // / device_id / name / properties references become ambiguous otherwise.
      const needsQualify = traitDescriptors.size > 0;
      const bdStepCondition = needsQualify
        ? qualifyFunnelCondition(rawBdStepCondition, 'e')
        : rawBdStepCondition;

      const breakdownExpr = (name: string): string => {
        const desc = getTraitBreakdownDescriptor(name);
        if (desc && traitDescriptors.has(desc.key)) {
          return desc.column;
        }
        return getSelectPropertyKey(name);
      };

      let bdExprs: string[];
      let bdGroup: string[];
      if (breakdownStep !== undefined) {
        bdExprs = breakdowns.map(
          (b, i) =>
            `argMaxIf(${breakdownExpr(b.name)}, e.created_at, ${bdStepCondition}) as b_${i}`,
        );
        bdGroup = [];
      } else {
        bdExprs = breakdowns.map(
          (b, i) => `${breakdownExpr(b.name)} as b_${i}`,
        );
        bdGroup = breakdowns.map((_, i) => `b_${i}`);
      }

      const propIdentifiedFilter =
        groupBy === 'profile_id' ? 'AND e.profile_id != e.device_id' : '';

      ctes.push(`prop_bd AS (
        SELECT e.${entityKey} AS ${entityKey}
          ${bdExprs.length > 0 ? `, ${bdExprs.join(', ')}` : ''}
        FROM ${TABLE_NAMES.events} AS e
          ${traitJoins}
        WHERE e.project_id = ${sqlstring.escape(projectId)}
          AND e.created_at BETWEEN toDateTime(${sqlstring.escape(startDate)}) AND toDateTime(${sqlstring.escape(endDate)})
          AND e.name IN (${nameList})
          ${propIdentifiedFilter}
        GROUP BY e.${entityKey}${bdGroup.length > 0 ? `, ${bdGroup.join(', ')}` : ''}
      )`);
    }

    // Property extraction CTE: get the property value at the last step timestamp
    const lastStepCte = `step_${lastStepIdx}`;
    const lastStepCondition = stepConditions[stepConditions.length - 1]!;
    const propExpr = getSelectPropertyKey(propertyKey);

    ctes.push(`prop_vals AS (
      SELECT ls.${entityKey} as ${entityKey},
        anyIf(
          toFloat64OrNull(toString(e.${propExpr})),
          e.created_at = ls.${lastStepCte}_ts AND (${lastStepCondition})
        ) as prop_value
      FROM ${lastStepCte} ls
      JOIN ${TABLE_NAMES.events} e ON e.${entityKey} = ls.${entityKey}
      WHERE e.project_id = ${sqlstring.escape(projectId)}
        AND e.created_at BETWEEN toDateTime(${sqlstring.escape(startDate)}) AND toDateTime(${sqlstring.escape(endDate)})
        AND e.name IN (${nameList})
        ${groupBy === 'profile_id' ? 'AND e.profile_id != e.device_id' : ''}
      GROUP BY ls.${entityKey}
    )`);

    // Final aggregation
    const joins: string[] = [];
    let bdSelectsInFinal = '';
    let bdGroupByInFinal = '';

    if (hasBreakdowns) {
      joins.push(
        `LEFT JOIN prop_bd bd ON pv.${entityKey} = bd.${entityKey}`,
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
        sum(pv.prop_value) as total_sum
      FROM prop_vals pv
      ${joins.join('\n')}
      ${bdGroupByInFinal}
    `;

    const rows = await chQuery<Record<string, any>>(sql);

    if (breakdowns.length === 0) {
      const val = rows[0]?.total_sum;
      result.set('none', typeof val === 'number' ? val : 0);
    } else {
      for (const row of rows) {
        const key = breakdowns
          .map((_, i) => normalizeBreakdownValue(row[`b_${i}`]))
          .join('|');
        result.set(key, typeof row.total_sum === 'number' ? row.total_sum : 0);
      }
    }

    return result;
  }
}

export const funnelService = new FunnelService(ch);
