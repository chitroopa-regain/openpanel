import type { ISerieDataItem } from '@openpanel/common';
import { groupByLabels } from '@openpanel/common';
import { alphabetIds } from '@openpanel/constants';
import type {
  IChartCustomEvent,
  ICustomEventComponent,
  IGetChartDataInput,
} from '@openpanel/validation';
import { chQuery } from '../clickhouse/client';
import { db } from '../prisma-client';
import { getChartSql } from '../services/chart.service';
import {
  resolveAudience,
  resolveCohortsForBreakdown,
} from '../services/custom-cohort.service';
import type { ConcreteSeries, Plan } from './types';

/**
 * Fetch data for all event series in the plan
 * This handles breakdown expansion automatically via groupByLabels
 */
export type FetchResult = {
  series: ConcreteSeries[];
  queries: string[];
};

export async function fetch(plan: Plan): Promise<FetchResult> {
  const results: ConcreteSeries[] = [];
  const queries: string[] = [];

  // Resolve the report-level audience ONCE, not per series. Compiled
  // server-side from cohort ids; `endDate` is the canonical asOf so every
  // series in the report sees the same membership.
  const audience = await resolveAudience(
    plan.input.audience?.cohortIds,
    plan.input.projectId,
    plan.membershipAsOf ?? plan.input.endDate,
  );
  const audiencePredicate = audience.render(null);

  // Breakdown by cohort: one series per cohort, resolved once in the REQUESTED
  // order. Kept separate from the audience — the audience narrows the
  // population, the breakdown splits what remains, so each series is
  // `audience ∩ cohort_i`.
  const breakdownCohorts = await resolveCohortsForBreakdown(
    plan.input.cohortBreakdown?.cohortIds,
    plan.input.projectId,
    plan.membershipAsOf ?? plan.input.endDate,
  );

  // Cohorts OVERLAP: a profile can belong to several. A GROUP BY would assign
  // each row to exactly one bucket and silently drop overlapping members from
  // all but one series, so each cohort gets its OWN query instead and overlap
  // falls out correctly by construction. Bounded concurrency keeps an
  // S x K report from firing every scan at once.
  const runWithLimit = async <T>(
    items: T[],
    limit: number,
    fn: (item: T, index: number) => Promise<void>,
  ) => {
    let cursor = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        await fn(items[index]!, index);
      }
    });
    await Promise.all(workers);
  };

  // Process each event definition
  for (let i = 0; i < plan.definitions.length; i++) {
    const definition = plan.definitions[i]!;

    if (definition.type !== 'event' && definition.type !== 'custom_event') {
      // Skip formulas - they'll be handled in compute stage
      continue;
    }

    // Find the corresponding concrete series placeholder
    const placeholder = plan.concreteSeries.find(
      (cs) => cs.definitionId === definition.id
    );

    if (!placeholder) {
      continue;
    }

    // Resolve custom event components from PostgreSQL
    let customEventComponents: ICustomEventComponent[] | undefined;
    let eventName: string;
    let eventSegment: string;
    let eventFilters: IGetChartDataInput['event']['filters'] = [];
    let eventDisplayName: string | undefined;
    let eventProperty: string | undefined;

    if (definition.type === 'custom_event') {
      const customDef = definition as IChartCustomEvent;
      const customEvent = await db.customEvent.findUnique({
        where: { id: customDef.customEventId },
      });
      // Skip if custom event was deleted
      if (
        !customEvent ||
        !Array.isArray(customEvent.components) ||
        (customEvent.components as ICustomEventComponent[]).length === 0
      ) {
        continue;
      }
      customEventComponents = customEvent.components as ICustomEventComponent[];
      eventName = customEvent.name;
      eventSegment = customDef.segment;
      eventFilters = customDef.filters ?? [];
      eventDisplayName = customDef.displayName ?? eventName;
      eventProperty = customDef.property;
    } else {
      const event = definition as typeof definition & { type: 'event' };
      eventName = event.name;
      eventSegment = event.segment;
      eventFilters = event.filters;
      eventDisplayName = event.displayName;
      eventProperty = event.property;
    }

    // Extract firstTimeFilter from the series definition
    const eventFirstTimeFilter =
      definition.type === 'custom_event'
        ? (definition as IChartCustomEvent).firstTimeFilter
        : definition.type === 'event'
          ? (definition as typeof definition & { type: 'event' }).firstTimeFilter
          : undefined;

    // Build query input
    const queryInput: IGetChartDataInput = {
      event: {
        id: definition.id,
        name: eventName,
        segment: eventSegment as any,
        filters: eventFilters,
        displayName: eventDisplayName,
        property: eventProperty,
        firstTimeFilter: eventFirstTimeFilter,
      },
      projectId: plan.input.projectId,
      startDate: plan.input.startDate,
      endDate: plan.input.endDate,
      breakdowns: plan.input.breakdowns,
      interval: plan.input.interval,
      chartType: plan.input.chartType,
      metric: plan.input.metric,
      previous: plan.input.previous ?? false,
      limit: plan.input.limit,
      offset: plan.input.offset,
    };

    // Cohort breakdown: one query per cohort, one series per cohort.
    //
    // Attribution is by cohort ID, assigned here in JS — never read back out of
    // the result. That is not merely defensive: ClickHouse's WITH FILL emits
    // zero-buckets with an EMPTY label, so a cohort matching nobody would
    // otherwise be attributed to '' instead of to itself. Those filled buckets
    // are also why an empty cohort still renders as a flat-zero line rather
    // than vanishing — the bucket domain comes from the same WITH FILL the
    // ordinary path uses, so it cannot drift from it on timezone or DST edges.
    if (breakdownCohorts.length > 0) {
      const perCohort: ConcreteSeries[] = new Array(breakdownCohorts.length);
      await runWithLimit(breakdownCohorts, 4, async (cohort, cohortIndex) => {
        const cohortSql = getChartSql({
          ...queryInput,
          timezone: plan.timezone,
          customEventComponents,
          audiencePredicate: [audiencePredicate, cohort.render(null)]
            .filter(Boolean)
            .join(' AND '),
        });
        queries.push(cohortSql);
        const rows = await chQuery<ISerieDataItem>(cohortSql, {
          session_timezone: plan.timezone,
        });
        perCohort[cohortIndex] = {
          // Structural identity: derived from (definition, cohort), not from
          // the label, so two cohorts sharing a NAME stay distinct and a
          // rename relabels without moving data.
          id: `${placeholder.id}-cohort-${cohort.cohortId}`,
          definitionId: definition.id ?? alphabetIds[i] ?? `series-${i}`,
          definitionIndex: i,
          name: [eventDisplayName ?? eventName, cohort.name],
          context: {
            event: eventName,
            filters: eventFilters,
            cohortId: cohort.cohortId,
          },
          data: rows.map((item) => ({
            date: item.date,
            count: Number(item.count ?? 0),
            total_count: item.total_count ? Number(item.total_count) : undefined,
            label: item.label_0,
          })),
          definition,
        } as ConcreteSeries;
      });
      results.push(...perCohort);
      continue;
    }

    // Execute query
    const sql = getChartSql({
      ...queryInput,
      timezone: plan.timezone,
      customEventComponents,
      audiencePredicate,
    });
    queries.push(sql);
    let queryResult = await chQuery<ISerieDataItem>(sql, {
      session_timezone: plan.timezone,
    });

    // Fallback: if no results with breakdowns, try without breakdowns
    if (queryResult.length === 0 && plan.input.breakdowns.length > 0) {
      const fallbackSql = getChartSql({
        ...queryInput,
        breakdowns: [],
        timezone: plan.timezone,
        customEventComponents,
      });
      queries.push(fallbackSql);
      queryResult = await chQuery<ISerieDataItem>(fallbackSql, {
        session_timezone: plan.timezone,
      });
    }

    // Group by labels (handles breakdown expansion)
    const groupedSeries = groupByLabels(queryResult);

    // Create concrete series for each grouped result
    groupedSeries.forEach((grouped) => {
      // Extract breakdown value from name array
      // If breakdowns exist, name[0] is event name, name[1+] are breakdown values
      const breakdownValue =
        plan.input.breakdowns.length > 0 && grouped.name.length > 1
          ? grouped.name.slice(1).join(' - ')
          : undefined;

      // Build breakdowns object: { country: 'SE', path: '/ewoqmepwq' }
      const breakdowns: Record<string, string> | undefined =
        plan.input.breakdowns.length > 0 && grouped.name.length > 1
          ? {}
          : undefined;

      if (breakdowns) {
        plan.input.breakdowns.forEach((breakdown, idx) => {
          const breakdownNamePart = grouped.name[idx + 1];
          if (breakdownNamePart) {
            breakdowns[breakdown.name] = breakdownNamePart;
          }
        });
      }

      // Build filters including breakdown value
      const filters = [...eventFilters];
      if (breakdownValue && plan.input.breakdowns.length > 0) {
        // Add breakdown filter
        plan.input.breakdowns.forEach((breakdown, idx) => {
          const breakdownNamePart = grouped.name[idx + 1];
          if (breakdownNamePart) {
            filters.push({
              id: `breakdown-${idx}`,
              name: breakdown.name,
              operator: 'is',
              value: [breakdownNamePart],
            });
          }
        });
      }

      const concrete: ConcreteSeries = {
        id: `${placeholder.id}-${grouped.name.join('-')}`,
        definitionId: definition.id ?? alphabetIds[i] ?? `series-${i}`,
        definitionIndex: i,
        name: grouped.name,
        context: {
          event: eventName,
          filters,
          breakdownValue,
          breakdowns,
        },
        data: grouped.data.map((item) => ({
          date: item.date,
          count: item.count,
          total_count: item.total_count,
        })),
        definition,
      };

      results.push(concrete);
    });
  }

  return { series: results, queries };
}
