import { NOT_SET_VALUE } from '@openpanel/constants';
import type { IReportInput } from '@openpanel/validation';
import { omit } from 'ramda';
import sqlstring from 'sqlstring';
import { TABLE_NAMES, ch } from '../clickhouse/client';
import { clix } from '../clickhouse/query-builder';
import {
  getEventFiltersWhereClause,
  getSelectPropertyKey,
  getTraitBreakdownExpression,
} from './chart.service';
import { resolveSeriesForFunnel, funnelService } from './funnel.service';

export class ConversionService {
  constructor(private client: typeof ch) {}

  async getConversion({
    projectId,
    startDate,
    endDate,
    options,
    series,
    breakdowns = [],
    limit,
    interval,
    timezone,
  }: Omit<IReportInput, 'range' | 'previous' | 'metric' | 'chartType'> & {
    timezone: string;
  }) {
    if (options?.type === 'retention') {
      return this.getRetentionTrend({
        projectId,
        startDate,
        endDate,
        options,
        series,
        breakdowns,
        limit,
        interval,
        timezone,
      });
    }

    const funnelOptions = options?.type === 'funnel' ? options : undefined;
    const funnelGroup = options?.funnelGroup;
    const funnelWindowUnit = funnelOptions?.funnelWindowUnit ?? 'hour';
    const defaultWindowByUnit: Record<string, number> = {
      second: 86400, minute: 1440, hour: 24, day: 1, week: 1, month: 1,
    };
    const funnelWindow =
      funnelOptions?.funnelWindow ?? (defaultWindowByUnit[funnelWindowUnit] ?? 24);
    const group = funnelGroup
      ? (funnelGroup === 'profile_id' ? 'profile_id' : 'session_id')
      : (options?.type === 'retention' ? 'profile_id' : 'session_id');
    const breakdownExpressions = breakdowns.map(
      (b) => getTraitBreakdownExpression(b.name, projectId) ?? getSelectPropertyKey(b.name),
    );
    const breakdownSelects = breakdownExpressions.map(
      (expr, index) => `${expr} as b_${index}`,
    );
    const breakdownGroupBy = breakdowns.map((_, index) => `b_${index}`);

    // Check if any breakdown uses profile fields and build profile JOIN if needed
    const profileBreakdowns = breakdowns.filter((b) =>
      b.name.startsWith('profile.'),
    );
    const needsProfileJoin = profileBreakdowns.length > 0;

    // Build profile JOIN clause if needed
    let profileJoin = '';
    if (needsProfileJoin) {
      const profileFields = new Set<string>();
      profileFields.add('id');

      for (const b of profileBreakdowns) {
        const fieldName = b.name.replace('profile.', '').split('.')[0];
        if (fieldName === 'properties') {
          profileFields.add('properties');
        } else if (['email', 'first_name', 'last_name'].includes(fieldName!)) {
          profileFields.add(fieldName!);
        }
      }

      // Use simple column names (not aliased) so profile.properties works directly
      const selectFields = Array.from(profileFields);

      profileJoin = `LEFT ANY JOIN (
        SELECT ${selectFields.join(', ')}
        FROM ${TABLE_NAMES.profiles} FINAL
        WHERE project_id = ${sqlstring.escape(projectId)}
      ) as profile ON profile.id = profile_id`;
    }

    const resolvedEvents = await resolveSeriesForFunnel(series, projectId);

    if (resolvedEvents.length !== 2) {
      throw new Error('events must be an array of two events');
    }

    if (!startDate || !endDate) {
      throw new Error('startDate and endDate are required');
    }

    const conditions = funnelService.getFunnelConditions(resolvedEvents, projectId);
    const conditionA = conditions[0]!;
    const conditionB = conditions[1]!;

    const allEventNames = Array.from(
      new Set(
        resolvedEvents.flatMap((event) =>
          event.customEventComponents
            ? event.customEventComponents.map((c) => c.eventName)
            : [event.name]
        )
      )
    );
    const escapedNames = allEventNames.map((name) => sqlstring.escape(name)).join(', ');

    const unitMultipliers: Record<string, number> = {
      second: 1,
      minute: 60,
      hour: 3600,
      day: 86400,
      week: 604800,
      month: 2592000,
    };
    const funnelWindowSeconds =
      funnelWindow * (unitMultipliers[funnelWindowUnit] ?? 3600);

    // Use windowFunnel approach - single scan, no JOIN
    const query = clix(this.client, timezone)
      .select<{
        event_day: string;
        total_first: number;
        conversions: number;
        conversion_rate_percentage: number;
        [key: string]: string | number;
      }>([
        'event_day',
        ...breakdownGroupBy,
        `uniqExact(${group}) AS total_first`,
        'countIf(steps >= 2) AS conversions',
        `round(100.0 * countIf(steps >= 2) / uniqExact(${group}), 2) AS conversion_rate_percentage`,
      ])
      .from(
        clix.exp(`
        (SELECT
          ${group},
          any(${clix.toStartOf('created_at', interval)}) as event_day,
          ${breakdownSelects.length ? `${breakdownSelects.join(', ')},` : ''}
          windowFunnel(${funnelWindowSeconds})(
            toDateTime(created_at),
            ${conditionA},
            ${conditionB}
          ) as steps
        FROM ${TABLE_NAMES.events}
        ${profileJoin}
        WHERE project_id = '${projectId}'
          AND name IN (${escapedNames})
          AND created_at BETWEEN toDateTime('${startDate}') AND toDateTime('${endDate}')
        GROUP BY ${group}${breakdownExpressions.length ? `, ${breakdownExpressions.join(', ')}` : ''})
      `),
      )
      .where('steps', '>', 0)
      .groupBy(['event_day', ...breakdownGroupBy]);

    for (const order of ['event_day', ...breakdownGroupBy]) {
      query.orderBy(order);
    }

    const queries = [query.toSQL()];
    const results = await query.execute();
    const data = this.toSeries(results, breakdowns, limit).map(
      (serie, serieIndex) => {
        return {
          ...serie,
          data: serie.data.map((d, index) => ({
            ...d,
            timestamp: new Date(d.date).getTime(),
            serieIndex,
            index,
            serie: omit(['data'], serie),
          })),
        };
      },
    );

    return {
      data,
      queries,
    };
  }

  async getRetentionTrend({
    projectId,
    startDate,
    endDate,
    options,
    series,
    timezone,
  }: Omit<IReportInput, 'range' | 'previous' | 'metric' | 'chartType'> & {
    timezone: string;
  }) {
    const resolvedEvents = await resolveSeriesForFunnel(series, projectId);

    if (resolvedEvents.length !== 2) {
      throw new Error('events must be an array of two events');
    }

    if (!startDate || !endDate) {
      throw new Error('startDate and endDate are required');
    }

    const conditions = funnelService.getFunnelConditions(resolvedEvents, projectId);
    const conditionA = conditions[0]!;
    const conditionB = conditions[1]!;

    const retentionDay = options?.day ?? 1;

    const needsEventsTable = (filters: any[]) =>
      filters.some((f) => !f.name.startsWith('profile.') && f.name !== 'has_profile');

    const firstItem = series[0];
    const firstCustomEventComponents = resolvedEvents[0]?.customEventComponents;
    const firstEventFilters = firstItem?.filters ?? [];

    const useEventsFirst =
      firstItem?.type === 'custom_event' ||
      (firstCustomEventComponents && firstCustomEventComponents.length > 0) ||
      needsEventsTable(firstEventFilters);

    const firstEventTable = useEventsFirst ? TABLE_NAMES.events : TABLE_NAMES.cohort_events_mv;
    const firstIdentifiedFilter = useEventsFirst ? 'AND profile_id != device_id' : '';

    const query = clix(this.client, timezone)
      .select<{
        event_day: string;
        total_first: number;
        conversions: number;
        conversion_rate_percentage: number;
      }>([
        'cohort_interval AS event_day',
        'uniqExact(userID) AS total_first',
        `uniqExactIf(userID, dateDiff('day', cohort_interval, event_date) = ${retentionDay}) AS conversions`,
        `round(100.0 * conversions / total_first, 2) AS conversion_rate_percentage`,
      ])
      .from(
        clix.exp(`
        (
          WITH cohort_users AS (
            SELECT
              profile_id AS userID,
              toDate(created_at, '${timezone}') AS cohort_interval
            FROM ${firstEventTable}
            WHERE ${conditionA}
              AND project_id = ${sqlstring.escape(projectId)}
              AND created_at BETWEEN toDate('${startDate}', '${timezone}') AND toDate('${endDate}', '${timezone}')
              ${firstIdentifiedFilter}
          ),
          last_event AS (
            SELECT
              profile_id,
              toDate(created_at, '${timezone}') AS event_date
            FROM ${TABLE_NAMES.events}
            WHERE ${conditionB}
              AND project_id = ${sqlstring.escape(projectId)}
              AND created_at BETWEEN toDate('${startDate}', '${timezone}') AND toDate('${endDate}', '${timezone}') + INTERVAL ${retentionDay + 7} DAY
              AND profile_id != device_id
            GROUP BY profile_id, event_date
          )
          SELECT
            cohort_interval,
            userID,
            event_date
          FROM cohort_users
          LEFT JOIN last_event ON cohort_users.userID = last_event.profile_id
        )
        `)
      )
      .groupBy(['event_day'])
      .orderBy('event_day');

    const queries = [query.toSQL()];
    const results = await query.execute();

    const data = [
      {
        id: 'conversion',
        breakdowns: [],
        data: results.map((d, index) => {
          const fullDateStr = `${d.event_day} 00:00:00`;
          const timestamp = new Date(fullDateStr).getTime();
          return {
            date: fullDateStr,
            total: Number(d.total_first),
            conversions: Number(d.conversions),
            rate: Number(d.conversion_rate_percentage),
            timestamp,
            serieIndex: 0,
            index,
            serie: {
              id: 'conversion',
              breakdowns: [],
            },
          };
        }),
      },
    ];

    return {
      data,
      queries,
    };
  }

  private toSeries(
    data: {
      event_day: string;
      total_first: number;
      conversions: number;
      conversion_rate_percentage: number;
      [key: string]: string | number;
    }[],
    breakdowns: { name: string }[] = [],
    limit: number | undefined = undefined,
  ) {
    if (!breakdowns.length) {
      return [
        {
          id: 'conversion',
          breakdowns: [],
          data: data.map((d) => ({
            date: d.event_day,
            total: d.total_first,
            conversions: d.conversions,
            rate: d.conversion_rate_percentage,
          })),
        },
      ];
    }

    // Group by breakdown values
    const series = data.reduce(
      (acc, d) => {
        if (limit && Object.keys(acc).length >= limit) {
          return acc;
        }

        const key =
          breakdowns.map((b, index) => d[`b_${index}`]).join('|') ||
          NOT_SET_VALUE;
        if (!acc[key]) {
          acc[key] = {
            id: key,
            breakdowns: breakdowns.map(
              (b, index) => (d[`b_${index}`] || NOT_SET_VALUE) as string,
            ),
            data: [],
          };
        }
        acc[key]!.data.push({
          date: d.event_day,
          total: d.total_first,
          conversions: d.conversions,
          rate: d.conversion_rate_percentage,
        });
        return acc;
      },
      {} as Record<
        string,
        {
          id: string;
          breakdowns: string[];
          data: {
            date: string;
            total: number;
            conversions: number;
            rate: number;
          }[];
        }
      >,
    );

    return Object.values(series).map((serie, serieIndex) => ({
      ...serie,
      data: serie.data.map((item, dataIndex) => ({
        ...item,
        dataIndex,
        serieIndex,
      })),
    }));
  }
}

export const conversionService = new ConversionService(ch);
