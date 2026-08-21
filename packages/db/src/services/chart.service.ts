import sqlstring from 'sqlstring';

import { DateTime, stripLeadingAndTrailingSlashes } from '@openpanel/common';
import type {
  IChartEventFilter,
  ICustomEventComponent,
  IDateConfig,
  IReportInput,
  IChartRange,
  IGetChartDataInput,
} from '@openpanel/validation';

import { TABLE_NAMES, formatClickhouseDate } from '../clickhouse/client';
import { createSqlBuilder } from '../sql-builder';

// As of 2026-04-15, ALL profile.properties.* keys are stored in profile_traits.
// Device/geo keys (country, os, brand, region, city, ...) are dual-written there
// by jitsu-fork profile_manager.go — see the companion fix. Filters and breakdowns
// on any profile property should route through the profile_traits fast path
// (avoids the expensive `profiles FINAL` merge).
// DEVICE_GEO_KEYS is kept as an empty set for backward-compat re-export — any
// remaining callers will get `false` from `.has(key)` and behave as if the key
// is a trait, which is now correct.
export const DEVICE_GEO_KEYS = new Set<string>([]);

// Check if a profile.properties.X filter is on a trait (now: all of them).
function isProfileTrait(filterName: string): boolean {
  if (!filterName.startsWith('profile.properties.')) return false;
  const key = filterName.replace('profile.properties.', '').split('.')[0];
  return Boolean(key);
}

// Generate a profile_traits IN-subquery for a trait filter.
function traitSubquery(
  projectId: string,
  traitKey: string,
  operator: string,
  values: (string | number | boolean | null)[]
): string {
  const escapedProject = sqlstring.escape(projectId);
  const escapedKey = sqlstring.escape(traitKey);

  switch (operator) {
    case 'is': {
      if (values.length === 1) {
        return `profile_id IN (SELECT profile_id FROM ${TABLE_NAMES.profile_traits} WHERE project_id = ${escapedProject} AND key = ${escapedKey} GROUP BY profile_id HAVING argMax(value, updated_at) = ${sqlstring.escape(String(values[0]).trim())})`;
      }
      const inList = values
        .map((v) => sqlstring.escape(String(v).trim()))
        .join(', ');
      return `profile_id IN (SELECT profile_id FROM ${TABLE_NAMES.profile_traits} WHERE project_id = ${escapedProject} AND key = ${escapedKey} GROUP BY profile_id HAVING argMax(value, updated_at) IN (${inList}))`;
    }
    case 'isNot': {
      if (values.length === 1) {
        return `profile_id NOT IN (SELECT profile_id FROM ${TABLE_NAMES.profile_traits} WHERE project_id = ${escapedProject} AND key = ${escapedKey} GROUP BY profile_id HAVING argMax(value, updated_at) = ${sqlstring.escape(String(values[0]).trim())})`;
      }
      const inList = values
        .map((v) => sqlstring.escape(String(v).trim()))
        .join(', ');
      return `profile_id NOT IN (SELECT profile_id FROM ${TABLE_NAMES.profile_traits} WHERE project_id = ${escapedProject} AND key = ${escapedKey} GROUP BY profile_id HAVING argMax(value, updated_at) IN (${inList}))`;
    }
    case 'contains': {
      const likeExprs = values
        .map(
          (v) =>
            `argMax(value, updated_at) LIKE ${sqlstring.escape(`%${String(v).trim()}%`)}`
        )
        .join(' OR ');
      return `profile_id IN (SELECT profile_id FROM ${TABLE_NAMES.profile_traits} WHERE project_id = ${escapedProject} AND key = ${escapedKey} GROUP BY profile_id HAVING ${likeExprs})`;
    }
    case 'doesNotContain': {
      const likeExprs = values
        .map(
          (v) =>
            `argMax(value, updated_at) NOT LIKE ${sqlstring.escape(`%${String(v).trim()}%`)}`
        )
        .join(' AND ');
      return `profile_id IN (SELECT profile_id FROM ${TABLE_NAMES.profile_traits} WHERE project_id = ${escapedProject} AND key = ${escapedKey} GROUP BY profile_id HAVING ${likeExprs})`;
    }
    case 'isNull': {
      return `profile_id NOT IN (SELECT profile_id FROM ${TABLE_NAMES.profile_traits} WHERE project_id = ${escapedProject} AND key = ${escapedKey} GROUP BY profile_id HAVING argMax(value, updated_at) != '')`;
    }
    case 'isNotNull': {
      return `profile_id IN (SELECT profile_id FROM ${TABLE_NAMES.profile_traits} WHERE project_id = ${escapedProject} AND key = ${escapedKey} GROUP BY profile_id HAVING argMax(value, updated_at) != '')`;
    }
    default: {
      // Fallback for gt, lt, gte, lte, startsWith, endsWith, regex — use argMax with the operator
      const argMaxExpr = 'argMax(value, updated_at)';
      const valExprs = values
        .map((v) => {
          const escaped = sqlstring.escape(String(v).trim());
          switch (operator) {
            case 'gt':
              return `toFloat64OrZero(${argMaxExpr}) > toFloat64(${escaped})`;
            case 'lt':
              return `toFloat64OrZero(${argMaxExpr}) < toFloat64(${escaped})`;
            case 'gte':
              return `toFloat64OrZero(${argMaxExpr}) >= toFloat64(${escaped})`;
            case 'lte':
              return `toFloat64OrZero(${argMaxExpr}) <= toFloat64(${escaped})`;
            case 'startsWith':
              return `${argMaxExpr} LIKE ${sqlstring.escape(`${String(v).trim()}%`)}`;
            case 'endsWith':
              return `${argMaxExpr} LIKE ${sqlstring.escape(`%${String(v).trim()}`)}`;
            case 'regex':
              return `match(${argMaxExpr}, ${escaped})`;
            default:
              return `${argMaxExpr} = ${escaped}`;
          }
        })
        .join(' OR ');
      return `profile_id IN (SELECT profile_id FROM ${TABLE_NAMES.profile_traits} WHERE project_id = ${escapedProject} AND key = ${escapedKey} GROUP BY profile_id HAVING ${valExprs})`;
    }
  }
}

export function transformPropertyKey(property: string) {
  const propertyPatterns = ['properties', 'profile.properties'];
  const match = propertyPatterns.find((pattern) =>
    property.startsWith(`${pattern}.`)
  );

  if (!match) {
    return property;
  }

  if (property.includes('*')) {
    return property
      .replace(/^properties\./, '')
      .replace('.*.', '.%.')
      .replace(/\[\*\]$/, '.%')
      .replace(/\[\*\].?/, '.%.');
  }

  return `${match}['${property.replace(new RegExp(`^${match}.`), '')}']`;
}

// Descriptor for a trait-based breakdown: CTE name + column reference.
// Replaces the old correlated subquery which ClickHouse silently mis-evaluated
// (unqualified profile_id resolved to the inner table → always-true predicate
//  → global scalar → every event bucketed into a single value).
export type TraitBreakdown = { key: string; cteName: string; column: string };

export function getTraitBreakdownDescriptor(
  property: string
): TraitBreakdown | null {
  if (!property.startsWith('profile.properties.')) return null;
  const key = property.replace('profile.properties.', '').split('.')[0];
  if (!key) return null;
  const safe = key.replace(/[^a-zA-Z0-9_]/g, '_');
  const cteName = `trait_${safe}`;
  return { key, cteName, column: `${cteName}.value` };
}

// Register trait CTEs and joins for all trait-based breakdowns.
function registerTraitBreakdowns(
  breakdowns: { name: string }[],
  projectId: string,
  addCte: (name: string, query: string) => void,
  sbJoins: Record<string, string>
): { traitJoinsRef: string; descriptors: Map<string, TraitBreakdown> } {
  const descriptors = new Map<string, TraitBreakdown>();
  for (const b of breakdowns) {
    const desc = getTraitBreakdownDescriptor(b.name);
    if (desc && !descriptors.has(desc.key)) {
      descriptors.set(desc.key, desc);
      addCte(
        desc.cteName,
        `SELECT profile_id, argMax(value, updated_at) AS value FROM ${TABLE_NAMES.profile_traits} WHERE project_id = ${sqlstring.escape(projectId)} AND key = ${sqlstring.escape(desc.key)} GROUP BY profile_id`
      );
      sbJoins[desc.cteName] =
        `LEFT ANY JOIN ${desc.cteName} ON ${desc.cteName}.profile_id = e.profile_id`;
    }
  }
  const traitJoinsRef = Array.from(descriptors.values())
    .map(
      (d) =>
        `LEFT ANY JOIN ${d.cteName} ON ${d.cteName}.profile_id = e.profile_id`
    )
    .join(' ');
  return { traitJoinsRef, descriptors };
}

// Build trait join string for a given events alias (e.g., 'e2' for subqueries).
function buildTraitJoinsFor(
  descriptors: Map<string, TraitBreakdown>,
  eventsAlias: string
): string {
  return Array.from(descriptors.values())
    .map(
      (d) =>
        `LEFT ANY JOIN ${d.cteName} ON ${d.cteName}.profile_id = ${eventsAlias}.profile_id`
    )
    .join(' ');
}

// Get the SQL expression for a breakdown column.
function getBreakdownExpr(
  breakdownName: string,
  descriptors: Map<string, TraitBreakdown>
): string {
  const desc = getTraitBreakdownDescriptor(breakdownName);
  if (desc && descriptors.has(desc.key)) {
    return desc.column;
  }
  return getSelectPropertyKey(breakdownName);
}

// Qualify profile_id as e.profile_id when trait CTEs are joined (prevents AMBIGUOUS_IDENTIFIER).
function qualifyProfileId(
  expr: string,
  descriptors: Map<string, TraitBreakdown>,
  alias = 'e'
): string {
  if (descriptors.size === 0) return expr;
  return expr.replace(/\bprofile_id\b/g, `${alias}.profile_id`);
}

// Compat shim: old correlated subquery form used by funnel.service.ts, conversion.service.ts,
// and chart.ts TRPC router. Those callers will be migrated to CTE-based approach separately.
export function getTraitBreakdownExpression(
  property: string,
  projectId: string
): string | null {
  const desc = getTraitBreakdownDescriptor(property);
  if (!desc) return null;
  return `(SELECT argMax(t.value, t.updated_at) FROM ${TABLE_NAMES.profile_traits} t WHERE t.project_id = ${sqlstring.escape(projectId)} AND t.key = ${sqlstring.escape(desc.key)} AND t.profile_id = profile_id)`;
}

export function getSelectPropertyKey(property: string) {
  if (property === 'has_profile') {
    return `if(profile_id != device_id, 'true', 'false')`;
  }

  const propertyPatterns = ['properties', 'profile.properties'];

  const match = propertyPatterns.find((pattern) =>
    property.startsWith(`${pattern}.`)
  );
  if (!match) {
    // Anything not matching a known map prefix is emitted as a bare SQL
    // expression (a column name like `name` or `country`). Breakdown and metric
    // property names are client-controlled, so restrict this passthrough to a
    // plain identifier instead of letting arbitrary text become SQL.
    if (!/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(property)) {
      throw new Error(`Unsupported property name: ${property}`);
    }
    return property;
  }

  if (property.includes('*')) {
    return `arrayMap(x -> trim(x), mapValues(mapExtractKeyLike(${match}, ${sqlstring.escape(
      transformPropertyKey(property)
    )})))`;
  }

  // The map key is client-controlled (filter and breakdown names come from
  // report input and from cohort criteria) so it MUST be escaped. Interpolating
  // it raw made `properties.a'] ) OR 1=1 --` a SQL-injection vector.
  const key = property.replace(new RegExp(`^${match}\\.`), '');
  return `${match}[${sqlstring.escape(key)}]`;
}

export function getCustomEventWhereClause(
  components: ICustomEventComponent[],
  projectId?: string
): string {
  const clauses = components.map((c) => {
    const namePart = `name = ${sqlstring.escape(c.eventName)}`;
    if (c.filters.length === 0) return namePart;
    const filterWhere = getEventFiltersWhereClause(c.filters, projectId);
    const parts = Object.values(filterWhere);
    return parts.length > 0
      ? `(${namePart} AND ${parts.join(' AND ')})`
      : namePart;
  });
  return `(${clauses.join(' OR ')})`;
}

/**
 * Builds a first-time-ever IN-subquery. Scans ALL time (no date filter on
 * the events scan) to find each profile's min(created_at), then checks if
 * that timestamp falls within [startDate, endDate].
 *
 * Used in regular charts (WHERE clause). For funnels, use the CTE + LEFT JOIN
 * approach instead (windowFunnel doesn't allow aggregate subqueries).
 */
export function buildFirstTimeSubquery(
  projectId: string,
  stepPredicate: string,
  startDate: string,
  endDate: string
): string {
  const escapedProject = sqlstring.escape(projectId);
  const escapedStart = sqlstring.escape(startDate);
  const escapedEnd = sqlstring.escape(endDate);
  return `profile_id IN (
    SELECT profile_id FROM ${TABLE_NAMES.events}
    WHERE project_id = ${escapedProject} AND ${stepPredicate}
    GROUP BY profile_id
    HAVING min(created_at) >= toDateTime(${escapedStart}) AND min(created_at) <= toDateTime(${escapedEnd})
  )`;
}

export function getChartSql({
  event,
  breakdowns,
  interval,
  startDate,
  endDate,
  projectId,
  limit,
  timezone,
  chartType,
  customEventComponents,
  audiencePredicate,
}: IGetChartDataInput & {
  timezone: string;
  customEventComponents?: ICustomEventComponent[];
  /**
   * Server-compiled cohort membership predicate. Always produced by
   * custom-cohort.service from a cohort id — never accepted from client input.
   */
  audiencePredicate?: string | null;
}) {
  const {
    sb,
    join,
    getWhere,
    getFrom,
    getJoins,
    getSelect,
    getOrderBy,
    getGroupBy,
    getFill,
    getWith,
    with: addCte,
  } = createSqlBuilder();

  sb.where = getEventFiltersWhereClause(event.filters, projectId);
  sb.where.projectId = `project_id = ${sqlstring.escape(projectId)}`;
  if (audiencePredicate) {
    sb.where.audience = audiencePredicate;
  }

  if (customEventComponents && customEventComponents.length > 0) {
    const displayName = event.displayName ?? event.name;
    sb.select.label_0 = `${sqlstring.escape(displayName)} as label_0`;
    sb.where.eventName = getCustomEventWhereClause(
      customEventComponents,
      projectId
    );
  } else if (event.name !== '*') {
    sb.select.label_0 = `${sqlstring.escape(event.name)} as label_0`;
    sb.where.eventName = `name = ${sqlstring.escape(event.name)}`;
  } else {
    sb.select.label_0 = `'*' as label_0`;
  }

  // First-time-ever filter: only include users whose first-ever occurrence
  // of this event falls within the query date range
  if (event.firstTimeFilter && startDate && endDate && event.name !== '*') {
    const stepPredicate =
      customEventComponents && customEventComponents.length > 0
        ? getCustomEventWhereClause(customEventComponents, projectId)
        : `name = ${sqlstring.escape(event.name)}`;
    sb.where.firstTimeFilter = buildFirstTimeSubquery(
      projectId,
      stepPredicate,
      startDate,
      endDate
    );
  }

  // Trait filters on profile.properties.X (non-device/geo) are now IN-subqueries
  // on profile_id — they don't need the profile CTE JOIN.
  // Only device/geo filters and breakdowns still need the profile CTE.
  const anyFilterOnProfile = event.filters.some(
    (filter) =>
      filter.name.startsWith('profile.') && !isProfileTrait(filter.name)
  );
  // profile.properties.* breakdowns use profile_traits CTE (see registerTraitBreakdowns);
  // only profile.<scalar> breakdowns like profile.email still need the profile CTE.
  const anyBreakdownOnProfile = breakdowns.some(
    (breakdown) =>
      breakdown.name.startsWith('profile.') &&
      getTraitBreakdownDescriptor(breakdown.name) === null
  );

  // Build WHERE clause without the bar filter (for use in subqueries and CTEs)
  // Define this early so we can use it in CTE definitions
  const getWhereWithoutBar = () => {
    const whereWithoutBar = { ...sb.where };
    delete whereWithoutBar.bar;
    return Object.keys(whereWithoutBar).length
      ? `WHERE ${join(whereWithoutBar, ' AND ')}`
      : '';
  };

  // Collect all profile fields used in filters and breakdowns
  // Extract top-level field names (e.g., 'properties' from 'profile.properties.os')
  const getProfileFields = () => {
    const fields = new Set<string>();

    // Always need id for the join
    fields.add('id');

    // Collect from filters (only device/geo — trait filters use profile_traits table)
    event.filters
      .filter((f) => f.name.startsWith('profile.') && !isProfileTrait(f.name))
      .forEach((f) => {
        const fieldName = f.name.replace('profile.', '').split('.')[0];
        if (fieldName && fieldName === 'properties') {
          fields.add('properties');
        } else if (
          fieldName &&
          ['email', 'first_name', 'last_name'].includes(fieldName)
        ) {
          fields.add(fieldName);
        }
      });

    // Collect from breakdowns (only profile.<scalar> — trait breakdowns use profile_traits CTE)
    breakdowns
      .filter(
        (b) =>
          b.name.startsWith('profile.') &&
          getTraitBreakdownDescriptor(b.name) === null
      )
      .forEach((b) => {
        const fieldName = b.name.replace('profile.', '').split('.')[0];
        if (fieldName && fieldName === 'properties') {
          fields.add('properties');
        } else if (
          fieldName &&
          ['email', 'first_name', 'last_name'].includes(fieldName)
        ) {
          fields.add(fieldName);
        }
      });

    return Array.from(fields);
  };

  // Create profiles CTE if profiles are needed (to avoid duplicating the heavy profile join)
  // Only select the fields that are actually used
  const profilesJoinRef =
    anyFilterOnProfile || anyBreakdownOnProfile
      ? 'LEFT ANY JOIN profile ON profile.id = e.profile_id'
      : '';

  if (anyFilterOnProfile || anyBreakdownOnProfile) {
    const profileFields = getProfileFields();
    const selectFields = profileFields.map((field) => {
      if (field === 'id') {
        return 'id as "profile.id"';
      }
      if (field === 'properties') {
        return 'properties as "profile.properties"';
      }
      if (field === 'email') {
        return 'email as "profile.email"';
      }
      if (field === 'first_name') {
        return 'first_name as "profile.first_name"';
      }
      if (field === 'last_name') {
        return 'last_name as "profile.last_name"';
      }
      return field;
    });

    // Add profiles CTE using the builder
    addCte(
      'profile',
      `SELECT ${selectFields.join(', ')}
      FROM ${TABLE_NAMES.profiles} FINAL 
      WHERE project_id = ${sqlstring.escape(projectId)}`
    );

    // Use the CTE reference in the main query
    sb.joins.profiles = profilesJoinRef;
  }

  // Register trait CTEs for trait-based breakdowns (e.g., profile.properties.show_monthly_back_press_offer).
  // Each trait gets a pre-aggregated CTE joined to events, replacing the old broken correlated subquery.
  const { traitJoinsRef, descriptors: traitDescriptors } =
    registerTraitBreakdowns(breakdowns, projectId, addCte, sb.joins);

  // When trait CTEs are joined, qualify bare profile_id in WHERE clauses to avoid ambiguity.
  // Only replace the OUTER profile_id (before IN/NOT IN), not inner subquery references.
  if (traitDescriptors.size > 0) {
    for (const key of Object.keys(sb.where)) {
      sb.where[key] = sb.where[key]!.replace(
        /^profile_id (IN|NOT IN) /i,
        'e.profile_id $1 '
      ).replace(/^profile_id (!= |= )/i, 'e.profile_id $1');
    }
  }

  sb.select.count = 'count(*) as count';
  switch (interval) {
    case 'minute': {
      sb.fill = `FROM toStartOfMinute(toDateTime('${startDate}')) TO toStartOfMinute(toDateTime('${endDate}')) STEP toIntervalMinute(1)`;
      sb.select.date = 'toStartOfMinute(created_at) as date';
      break;
    }
    case 'hour': {
      sb.fill = `FROM toStartOfHour(toDateTime('${startDate}')) TO toStartOfHour(toDateTime('${endDate}')) STEP toIntervalHour(1)`;
      sb.select.date = 'toStartOfHour(created_at) as date';
      break;
    }
    case 'day': {
      sb.fill = `FROM toStartOfDay(toDateTime('${startDate}')) TO toStartOfDay(toDateTime('${endDate}')) STEP toIntervalDay(1)`;
      sb.select.date = 'toStartOfDay(created_at) as date';
      break;
    }
    case 'week': {
      sb.fill = `FROM toStartOfWeek(toDateTime('${startDate}'), 1, '${timezone}') TO toStartOfWeek(toDateTime('${endDate}'), 1, '${timezone}') STEP toIntervalWeek(1)`;
      sb.select.date = `toStartOfWeek(created_at, 1, '${timezone}') as date`;
      break;
    }
    case 'month': {
      sb.fill = `FROM toStartOfMonth(toDateTime('${startDate}'), '${timezone}') TO toStartOfMonth(toDateTime('${endDate}'), '${timezone}') STEP toIntervalMonth(1)`;
      sb.select.date = `toStartOfMonth(created_at, '${timezone}') as date`;
      break;
    }
  }
  sb.groupBy.date = 'date';
  sb.orderBy.date = 'date ASC';

  if (startDate) {
    sb.where.startDate = `created_at >= toDateTime('${formatClickhouseDate(startDate)}')`;
  }

  if (endDate) {
    sb.where.endDate = `created_at <= toDateTime('${formatClickhouseDate(endDate)}')`;
  }

  // Frequency distribution ignores breakdowns — it IS the breakdown
  const effectiveBreakdowns =
    event.segment === 'frequency_distribution' ? [] : breakdowns;

  // Skip top_breakdowns CTE for time-series charts with breakdowns.
  // ClickHouse CTEs are not materialized — IN (SELECT * FROM cte) fails with
  // "correlated subqueries not supported" for trait columns, Map access expressions
  // (properties['X']), and other non-trivial expressions.
  // Apply LIMIT to bound result set for high-cardinality breakdowns.
  if (effectiveBreakdowns.length > 0 && limit) {
    sb.limit = limit;
  }

  effectiveBreakdowns.forEach((breakdown, index) => {
    // Breakdowns start at label_1 (label_0 is reserved for event name)
    const key = `label_${index + 1}`;
    sb.select[key] =
      `${getBreakdownExpr(breakdown.name, traitDescriptors)} as ${key}`;
    sb.groupBy[key] = `${key}`;
  });

  // Build aggregate expression based on segment type (used for both count and total_count)
  const segmentAggregate = buildAggregateExpression(
    event.segment ?? 'event',
    event.property,
    true
  );
  sb.select.count = `${qualifyProfileId(segmentAggregate.expression, traitDescriptors)} as count`;
  if (segmentAggregate.whereClause) {
    sb.where.property = qualifyProfileId(
      segmentAggregate.whereClause,
      traitDescriptors
    );
  }

  if (event.segment === 'one_event_per_user') {
    sb.from = `(
      SELECT DISTINCT ON (e.profile_id) * from ${TABLE_NAMES.events} e ${getJoins()} WHERE ${join(
        sb.where,
        ' AND '
      )}
        ORDER BY e.profile_id, created_at DESC
      ) as subQuery`;
    sb.joins = {};

    const sql = `${getWith()}${getSelect()} ${getFrom()} ${getJoins()} ${getWhere()} ${getGroupBy()} ${getOrderBy()} ${getFill()}`;
    console.log('-- Report --');
    console.log(sql.replaceAll(/[\n\r]/g, ' '));
    console.log('-- End --');
    return sql;
  }

  // Build global aggregate for total_count (uses approximate functions for performance)
  const globalAggregate = buildAggregateExpression(
    event.segment ?? 'event',
    event.property,
    false
  );

  // Note: The profile CTE (if it exists) is available in subqueries, so we can reference it directly
  if (effectiveBreakdowns.length > 0) {
    // Match breakdown properties in subquery with outer query's grouped values
    const breakdownMatches = effectiveBreakdowns
      .map((b, index) => {
        const propertyKey = getBreakdownExpr(b.name, traitDescriptors);
        return `${propertyKey} = label_${index + 1}`;
      })
      .join(' AND ');

    // Build WHERE clause for subquery - replace table alias and keep profile CTE reference
    const subqueryWhere = getWhereWithoutBar()
      .replace(/\be\./g, 'e2.')
      .replace(/\bprofile\./g, 'profile.');

    const subqueryTraitJoins = buildTraitJoinsFor(traitDescriptors, 'e2');
    // Rewrite profilesJoinRef for e2 alias (it references e.profile_id)
    const subqueryProfilesJoin = profilesJoinRef.replace(
      /\be\.profile_id\b/g,
      'e2.profile_id'
    );
    // Qualify profile_id in aggregate expression for the subquery scope
    const subqueryAggregate = qualifyProfileId(
      globalAggregate.expression,
      traitDescriptors,
      'e2'
    );
    sb.select.total_unique_count = `(
        SELECT ${subqueryAggregate}
        FROM ${TABLE_NAMES.events} e2
        ${subqueryProfilesJoin ? `${subqueryProfilesJoin} ` : ''}${subqueryTraitJoins ? `${subqueryTraitJoins} ` : ''}${subqueryWhere}
        AND ${breakdownMatches}
      ) as total_count`;
  } else {
    // No breakdowns: calculate aggregate across all data
    const subqueryWhere = getWhereWithoutBar()
      .replace(/\be\./g, 'e2.')
      .replace(/\bprofile\./g, 'profile.');

    const subqueryProfilesJoin = profilesJoinRef.replace(
      /\be\.profile_id\b/g,
      'e2.profile_id'
    );
    sb.select.total_unique_count = `(
        SELECT ${globalAggregate.expression}
        FROM ${TABLE_NAMES.events} e2
        ${subqueryProfilesJoin ? `${subqueryProfilesJoin} ` : ''}${subqueryWhere}
      ) as total_count`;
  }

  const getLimit = () => (sb.limit ? `LIMIT ${sb.limit}` : '');
  const sql = `${getWith()}${getSelect()} ${getFrom()} ${getJoins()} ${getWhere()} ${getGroupBy()} ${getOrderBy()} ${getLimit()} ${getFill()}`;
  console.log('-- Report --');
  console.log(sql.replaceAll(/[\n\r]/g, ' '));
  console.log('-- End --');
  return sql;
}

export function getAggregateChartSql({
  event,
  breakdowns,
  startDate,
  endDate,
  projectId,
  limit,
  customEventComponents,
  audiencePredicate,
}: Omit<IGetChartDataInput, 'interval' | 'chartType'> & {
  timezone: string;
  customEventComponents?: ICustomEventComponent[];
  audiencePredicate?: string | null;
}) {
  const { sb, join, getJoins, with: addCte, getSql } = createSqlBuilder();

  sb.where = getEventFiltersWhereClause(event.filters, projectId);
  if (audiencePredicate) {
    sb.where.audience = audiencePredicate;
  }
  sb.where.projectId = `project_id = ${sqlstring.escape(projectId)}`;

  if (customEventComponents && customEventComponents.length > 0) {
    const displayName = event.displayName ?? event.name;
    sb.select.label_0 = `${sqlstring.escape(displayName)} as label_0`;
    sb.where.eventName = getCustomEventWhereClause(
      customEventComponents,
      projectId
    );
  } else if (event.name !== '*') {
    sb.select.label_0 = `${sqlstring.escape(event.name)} as label_0`;
    sb.where.eventName = `name = ${sqlstring.escape(event.name)}`;
  } else {
    sb.select.label_0 = `'*' as label_0`;
  }

  // First-time-ever filter
  if (event.firstTimeFilter && startDate && endDate && event.name !== '*') {
    const stepPredicate =
      customEventComponents && customEventComponents.length > 0
        ? getCustomEventWhereClause(customEventComponents, projectId)
        : `name = ${sqlstring.escape(event.name)}`;
    sb.where.firstTimeFilter = buildFirstTimeSubquery(
      projectId,
      stepPredicate,
      startDate,
      endDate
    );
  }

  // Trait filters are now IN-subqueries — only device/geo filters need profile CTE
  const anyFilterOnProfile = event.filters.some(
    (filter) =>
      filter.name.startsWith('profile.') && !isProfileTrait(filter.name)
  );
  // profile.properties.* breakdowns use profile_traits CTE (see registerTraitBreakdowns);
  // only profile.<scalar> breakdowns like profile.email still need the profile CTE.
  const anyBreakdownOnProfile = breakdowns.some(
    (breakdown) =>
      breakdown.name.startsWith('profile.') &&
      getTraitBreakdownDescriptor(breakdown.name) === null
  );

  // Build WHERE clause without the bar filter (for use in subqueries and CTEs)
  const getWhereWithoutBar = () => {
    const whereWithoutBar = { ...sb.where };
    delete whereWithoutBar.bar;
    return Object.keys(whereWithoutBar).length
      ? `WHERE ${join(whereWithoutBar, ' AND ')}`
      : '';
  };

  // Collect all profile fields used in filters and breakdowns
  const getProfileFields = () => {
    const fields = new Set<string>();

    // Always need id for the join
    fields.add('id');

    // Collect from filters (only device/geo — traits use profile_traits table)
    event.filters
      .filter((f) => f.name.startsWith('profile.') && !isProfileTrait(f.name))
      .forEach((f) => {
        const fieldName = f.name.replace('profile.', '').split('.')[0];
        if (fieldName && fieldName === 'properties') {
          fields.add('properties');
        } else if (
          fieldName &&
          ['email', 'first_name', 'last_name'].includes(fieldName)
        ) {
          fields.add(fieldName);
        }
      });

    // Collect from breakdowns (only profile.<scalar> — trait breakdowns use profile_traits CTE)
    breakdowns
      .filter(
        (b) =>
          b.name.startsWith('profile.') &&
          getTraitBreakdownDescriptor(b.name) === null
      )
      .forEach((b) => {
        const fieldName = b.name.replace('profile.', '').split('.')[0];
        if (fieldName && fieldName === 'properties') {
          fields.add('properties');
        } else if (
          fieldName &&
          ['email', 'first_name', 'last_name'].includes(fieldName)
        ) {
          fields.add(fieldName);
        }
      });

    return Array.from(fields);
  };

  // Create profiles CTE if profiles are needed
  const profilesJoinRef =
    anyFilterOnProfile || anyBreakdownOnProfile
      ? 'LEFT ANY JOIN profile ON profile.id = e.profile_id'
      : '';

  if (anyFilterOnProfile || anyBreakdownOnProfile) {
    const profileFields = getProfileFields();
    const selectFields = profileFields.map((field) => {
      if (field === 'id') {
        return 'id as "profile.id"';
      }
      if (field === 'properties') {
        return 'properties as "profile.properties"';
      }
      if (field === 'email') {
        return 'email as "profile.email"';
      }
      if (field === 'first_name') {
        return 'first_name as "profile.first_name"';
      }
      if (field === 'last_name') {
        return 'last_name as "profile.last_name"';
      }
      return field;
    });

    addCte(
      'profile',
      `SELECT ${selectFields.join(', ')}
      FROM ${TABLE_NAMES.profiles} FINAL 
      WHERE project_id = ${sqlstring.escape(projectId)}`
    );

    sb.joins.profiles = profilesJoinRef;
  }

  // Register trait CTEs for trait-based breakdowns (aggregate chart path).
  const { traitJoinsRef: aggTraitJoinsRef, descriptors: aggTraitDescriptors } =
    registerTraitBreakdowns(breakdowns, projectId, addCte, sb.joins);

  // Qualify bare profile_id in WHERE clauses when trait CTEs introduce ambiguity.
  if (aggTraitDescriptors.size > 0) {
    for (const key of Object.keys(sb.where)) {
      sb.where[key] = sb.where[key]!.replace(
        /^profile_id (IN|NOT IN) /i,
        'e.profile_id $1 '
      ).replace(/^profile_id (!= |= )/i, 'e.profile_id $1');
    }
  }

  // Date range filters
  if (startDate) {
    sb.where.startDate = `created_at >= toDateTime('${formatClickhouseDate(startDate)}')`;
  }

  if (endDate) {
    sb.where.endDate = `created_at <= toDateTime('${formatClickhouseDate(endDate)}')`;
  }

  // Add a constant date field for aggregate charts (groupByLabels expects it)
  // Use startDate as the date value since we're aggregating across the entire range
  sb.select.date = `${sqlstring.escape(startDate)} as date`;

  // Build aggregate expression based on segment type
  const segmentAggregate = buildAggregateExpression(
    event.segment ?? 'event',
    event.property,
    true
  );
  if (segmentAggregate.whereClause) {
    sb.where.property = qualifyProfileId(
      segmentAggregate.whereClause,
      aggTraitDescriptors
    );
  }

  // Skip top_breakdowns CTE for aggregate/pie charts entirely.
  // ClickHouse CTEs are not materialized — IN (SELECT * FROM cte) fails with
  // "correlated subqueries not supported" for both trait columns and Map access
  // expressions like properties['paywallVariant']. The outer ORDER BY + LIMIT
  // already restricts the result set to the top N breakdown values.

  // Add breakdowns to SELECT and GROUP BY
  breakdowns.forEach((breakdown, index) => {
    // Breakdowns start at label_1 (label_0 is reserved for event name)
    const key = `label_${index + 1}`;
    sb.select[key] =
      `${getBreakdownExpr(breakdown.name, aggTraitDescriptors)} as ${key}`;
    sb.groupBy[key] = `${key}`;
  });

  // Always group by label_0 (event name) for aggregate charts
  sb.groupBy.label_0 = 'label_0';

  sb.select.count = `${qualifyProfileId(segmentAggregate.expression, aggTraitDescriptors)} as count`;

  if (event.segment === 'one_event_per_user') {
    sb.from = `(
      SELECT DISTINCT ON (e.profile_id) * from ${TABLE_NAMES.events} e ${getJoins()} WHERE ${join(
        sb.where,
        ' AND '
      )}
        ORDER BY e.profile_id, created_at DESC
      ) as subQuery`;
    sb.joins = {};

    const sql = getSql();
    console.log('-- Aggregate Chart --');
    console.log(sql.replaceAll(/[\n\r]/g, ' '));
    console.log('-- End --');
    return sql;
  }

  if (event.segment === 'frequency_distribution') {
    // Frequency distribution: count how many users performed the event N times
    // Inner CTE groups events by profile_id to get per-user counts
    // Outer query buckets those counts: "1 time", "2 times", ..., ">= 7 times"

    // Remove breakdown artifacts — frequency distribution IS the breakdown
    delete sb.where.bar;
    delete sb.ctes.top_breakdowns;

    const whereClause = Object.keys(sb.where).length
      ? `WHERE ${join(sb.where, ' AND ')}`
      : '';

    const eventLabel = customEventComponents
      ? sqlstring.escape(event.displayName ?? event.name)
      : event.name !== '*'
        ? sqlstring.escape(event.name)
        : "'*'";

    // Add user_counts as a CTE (profile CTE may already exist from filters above)
    addCte(
      'user_counts',
      `SELECT profile_id, count(*) as event_count
      FROM ${TABLE_NAMES.events} e
      ${profilesJoinRef ? `${profilesJoinRef} ` : ''}${whereClause}
      GROUP BY profile_id`
    );

    // Reset builder state for outer query that reads from user_counts
    sb.from = 'user_counts';
    sb.joins = {};
    sb.where = {};
    sb.select = {};
    sb.groupBy = {};
    sb.orderBy = {};

    // Dynamic buckets: use quantile to find a natural cutoff point
    // Individual buckets for 1..N, overflow bucket for >= N+1
    // ClickHouse computes this in a single pass using least(max, 10)
    addCte(
      'freq_stats',
      `SELECT least(max(event_count), 10) as max_bucket FROM user_counts`
    );

    sb.select.label_0 = `${eventLabel} as label_0`;
    // Dynamic label: individual counts up to max_bucket, overflow for the rest
    sb.select.label_1 = `if(
          event_count >= (SELECT max_bucket FROM freq_stats),
          '>= ' || toString((SELECT max_bucket FROM freq_stats)) || ' times',
          toString(event_count) || if(event_count = 1, ' time', ' times')
        ) as label_1`;
    // bucket_order for sorting: individual counts sort by their value, overflow sorts last
    sb.select.bucket_order = `if(
          event_count >= (SELECT max_bucket FROM freq_stats),
          999,
          event_count
        ) as bucket_order`;
    sb.select.count = 'count(*) as count';
    sb.select.date = `${sqlstring.escape(startDate)} as date`;
    sb.groupBy.label_0 = 'label_0';
    sb.groupBy.label_1 = 'label_1';
    sb.groupBy.bucket_order = 'bucket_order';
    sb.orderBy.bucket = 'min(bucket_order) ASC';

    const sql = getSql();
    console.log('-- Aggregate Chart (Frequency Distribution) --');
    console.log(sql.replaceAll(/[\n\r]/g, ' '));
    console.log('-- End --');
    return sql;
  }

  // Order by count DESC (biggest first) for aggregate charts
  sb.orderBy.count = 'count DESC';

  // Apply limit if specified
  if (limit) {
    sb.limit = limit;
  }

  const sql = getSql();
  console.log('-- Aggregate Chart --');
  console.log(sql.replaceAll(/[\n\r]/g, ' '));
  console.log('-- End --');
  return sql;
}

function isNumericColumn(columnName: string): boolean {
  const numericColumns = ['duration', 'revenue', 'longitude', 'latitude'];
  return numericColumns.includes(columnName);
}

/**
 * Build the SQL aggregate expression for a given segment type.
 * Used for both per-bucket `count` and global `total_count` to keep them in sync.
 *
 * @param useExact - When true, use exact functions (countDistinct). When false, use approximate (uniq).
 *                   Per-bucket queries use exact; global subqueries use approximate for performance.
 */
function buildAggregateExpression(
  segment: string,
  property: string | undefined,
  useExact: boolean
): { expression: string; whereClause?: string } {
  const distinctFn = useExact ? 'countDistinct' : 'uniq';

  switch (segment) {
    case 'event':
      return { expression: 'count(*)' };
    case 'user':
      return { expression: `${distinctFn}(profile_id)` };
    case 'session':
      return { expression: `${distinctFn}(session_id)` };
    case 'user_average':
      return useExact
        ? { expression: 'COUNT(*)::float / COUNT(DISTINCT profile_id)::float' }
        : { expression: 'count(*)::Float64 / uniq(profile_id)::Float64' };
    case 'frequency_distribution':
      // Frequency distribution is handled as a special case in getAggregateChartSql
      // For time-series fallback, just count unique users
      return { expression: `${distinctFn}(profile_id)` };
    case 'property_sum':
    case 'property_average':
    case 'property_max':
    case 'property_min': {
      const mathFunction = {
        property_sum: 'sum',
        property_average: 'avg',
        property_max: 'max',
        property_min: 'min',
      }[segment]!;

      if (property) {
        const propertyKey = getSelectPropertyKey(property);
        if (isNumericColumn(property)) {
          return {
            expression: `${mathFunction}(${propertyKey})`,
            whereClause: `${propertyKey} IS NOT NULL`,
          };
        }
        return {
          expression: `${mathFunction}(toFloat64OrNull(${propertyKey}))`,
          whereClause: `${propertyKey} IS NOT NULL AND notEmpty(${propertyKey})`,
        };
      }
      // Fallback: no property selected, use event count
      return { expression: 'count(*)' };
    }
    default:
      return { expression: 'count(*)' };
  }
}

export function getEventFiltersWhereClause(
  filters: IChartEventFilter[],
  projectId?: string
) {
  const where: Record<string, string> = {};
  filters.forEach((filter, index) => {
    const id = `f${index}`;
    const { name, value, operator } = filter;

    if (
      value.length === 0 &&
      operator !== 'isNull' &&
      operator !== 'isNotNull'
    ) {
      return;
    }

    if (name === 'has_profile') {
      if (value.includes('true')) {
        where[id] = 'profile_id != device_id';
      } else {
        where[id] = 'profile_id = device_id';
      }
      return;
    }

    // Route user trait filters to profile_traits table
    if (projectId && isProfileTrait(name)) {
      const traitKey = name.replace('profile.properties.', '').split('.')[0]!;
      where[id] = traitSubquery(projectId, traitKey, operator, value);
      return;
    }

    if (
      name.startsWith('properties.') ||
      name.startsWith('profile.properties.')
    ) {
      const propertyKey = getSelectPropertyKey(name);
      const isWildcard = propertyKey.includes('%');
      const whereFrom = getSelectPropertyKey(name);

      switch (operator) {
        case 'is': {
          if (isWildcard) {
            where[id] = `arrayExists(x -> ${value
              .map((val) => `x = ${sqlstring.escape(String(val).trim())}`)
              .join(' OR ')}, ${whereFrom})`;
          } else {
            if (value.length === 1) {
              where[id] =
                `${whereFrom} = ${sqlstring.escape(String(value[0]).trim())}`;
            } else {
              where[id] = `${whereFrom} IN (${value
                .map((val) => sqlstring.escape(String(val).trim()))
                .join(', ')})`;
            }
          }
          break;
        }
        case 'isNot': {
          if (isWildcard) {
            where[id] = `arrayExists(x -> ${value
              .map((val) => `x != ${sqlstring.escape(String(val).trim())}`)
              .join(' OR ')}, ${whereFrom})`;
          } else {
            if (value.length === 1) {
              where[id] =
                `${whereFrom} != ${sqlstring.escape(String(value[0]).trim())}`;
            } else {
              where[id] = `${whereFrom} NOT IN (${value
                .map((val) => sqlstring.escape(String(val).trim()))
                .join(', ')})`;
            }
          }
          break;
        }
        case 'contains': {
          if (isWildcard) {
            where[id] = `arrayExists(x -> ${value
              .map(
                (val) => `x LIKE ${sqlstring.escape(`%${String(val).trim()}%`)}`
              )
              .join(' OR ')}, ${whereFrom})`;
          } else {
            where[id] = `(${value
              .map(
                (val) =>
                  `${whereFrom} LIKE ${sqlstring.escape(`%${String(val).trim()}%`)}`
              )
              .join(' OR ')})`;
          }
          break;
        }
        case 'doesNotContain': {
          if (isWildcard) {
            where[id] = `arrayExists(x -> ${value
              .map(
                (val) =>
                  `x NOT LIKE ${sqlstring.escape(`%${String(val).trim()}%`)}`
              )
              .join(' OR ')}, ${whereFrom})`;
          } else {
            where[id] = `(${value
              .map(
                (val) =>
                  `${whereFrom} NOT LIKE ${sqlstring.escape(`%${String(val).trim()}%`)}`
              )
              .join(' OR ')})`;
          }
          break;
        }
        case 'startsWith': {
          if (isWildcard) {
            where[id] = `arrayExists(x -> ${value
              .map(
                (val) => `x LIKE ${sqlstring.escape(`${String(val).trim()}%`)}`
              )
              .join(' OR ')}, ${whereFrom})`;
          } else {
            where[id] = `(${value
              .map(
                (val) =>
                  `${whereFrom} LIKE ${sqlstring.escape(`${String(val).trim()}%`)}`
              )
              .join(' OR ')})`;
          }
          break;
        }
        case 'endsWith': {
          if (isWildcard) {
            where[id] = `arrayExists(x -> ${value
              .map(
                (val) => `x LIKE ${sqlstring.escape(`%${String(val).trim()}`)}`
              )
              .join(' OR ')}, ${whereFrom})`;
          } else {
            where[id] = `(${value
              .map(
                (val) =>
                  `${whereFrom} LIKE ${sqlstring.escape(`%${String(val).trim()}`)}`
              )
              .join(' OR ')})`;
          }
          break;
        }
        case 'regex': {
          if (isWildcard) {
            where[id] = `arrayExists(x -> ${value
              .map((val) => `match(x, ${sqlstring.escape(String(val).trim())})`)
              .join(' OR ')}, ${whereFrom})`;
          } else {
            where[id] = `(${value
              .map(
                (val) =>
                  `match(${whereFrom}, ${sqlstring.escape(String(val).trim())})`
              )
              .join(' OR ')})`;
          }
          break;
        }
        case 'isNull': {
          if (isWildcard) {
            where[id] = `arrayExists(x -> x = '' OR x IS NULL, ${whereFrom})`;
          } else {
            where[id] = `(${whereFrom} = '' OR ${whereFrom} IS NULL)`;
          }
          break;
        }
        case 'isNotNull': {
          if (isWildcard) {
            where[id] =
              `arrayExists(x -> x != '' AND x IS NOT NULL, ${whereFrom})`;
          } else {
            where[id] = `(${whereFrom} != '' AND ${whereFrom} IS NOT NULL)`;
          }
          break;
        }
        case 'gt': {
          if (isWildcard) {
            where[id] = `arrayExists(x -> ${value
              .map(
                (val) =>
                  `toFloat64OrZero(x) > toFloat64(${sqlstring.escape(String(val).trim())})`
              )
              .join(' OR ')}, ${whereFrom})`;
          } else {
            where[id] = `(${value
              .map(
                (val) =>
                  `toFloat64OrZero(${whereFrom}) > toFloat64(${sqlstring.escape(String(val).trim())})`
              )
              .join(' OR ')})`;
          }
          break;
        }
        case 'lt': {
          if (isWildcard) {
            where[id] = `arrayExists(x -> ${value
              .map(
                (val) =>
                  `toFloat64OrZero(x) < toFloat64(${sqlstring.escape(String(val).trim())})`
              )
              .join(' OR ')}, ${whereFrom})`;
          } else {
            where[id] = `(${value
              .map(
                (val) =>
                  `toFloat64OrZero(${whereFrom}) < toFloat64(${sqlstring.escape(String(val).trim())})`
              )
              .join(' OR ')})`;
          }
          break;
        }
        case 'gte': {
          if (isWildcard) {
            where[id] = `arrayExists(x -> ${value
              .map(
                (val) =>
                  `toFloat64OrZero(x) >= toFloat64(${sqlstring.escape(String(val).trim())})`
              )
              .join(' OR ')}, ${whereFrom})`;
          } else {
            where[id] = `(${value
              .map(
                (val) =>
                  `toFloat64OrZero(${whereFrom}) >= toFloat64(${sqlstring.escape(String(val).trim())})`
              )
              .join(' OR ')})`;
          }
          break;
        }
        case 'lte': {
          if (isWildcard) {
            where[id] = `arrayExists(x -> ${value
              .map(
                (val) =>
                  `toFloat64OrZero(x) <= toFloat64(${sqlstring.escape(String(val).trim())})`
              )
              .join(' OR ')}, ${whereFrom})`;
          } else {
            where[id] = `(${value
              .map(
                (val) =>
                  `toFloat64OrZero(${whereFrom}) <= toFloat64(${sqlstring.escape(String(val).trim())})`
              )
              .join(' OR ')})`;
          }
          break;
        }
      }
    } else {
      switch (operator) {
        case 'is': {
          if (value.length === 1) {
            where[id] =
              `${name} = ${sqlstring.escape(String(value[0]).trim())}`;
          } else {
            where[id] = `${name} IN (${value
              .map((val) => sqlstring.escape(String(val).trim()))
              .join(', ')})`;
          }
          break;
        }
        case 'isNull': {
          where[id] = `(${name} = '' OR ${name} IS NULL)`;
          break;
        }
        case 'isNotNull': {
          where[id] = `(${name} != '' AND ${name} IS NOT NULL)`;
          break;
        }
        case 'isNot': {
          if (value.length === 1) {
            where[id] =
              `${name} != ${sqlstring.escape(String(value[0]).trim())}`;
          } else {
            where[id] = `${name} NOT IN (${value
              .map((val) => sqlstring.escape(String(val).trim()))
              .join(', ')})`;
          }
          break;
        }
        case 'contains': {
          where[id] = `(${value
            .map(
              (val) =>
                `${name} LIKE ${sqlstring.escape(`%${String(val).trim()}%`)}`
            )
            .join(' OR ')})`;
          break;
        }
        case 'doesNotContain': {
          where[id] = `(${value
            .map(
              (val) =>
                `${name} NOT LIKE ${sqlstring.escape(`%${String(val).trim()}%`)}`
            )
            .join(' OR ')})`;
          break;
        }
        case 'startsWith': {
          where[id] = `(${value
            .map(
              (val) =>
                `${name} LIKE ${sqlstring.escape(`${String(val).trim()}%`)}`
            )
            .join(' OR ')})`;
          break;
        }
        case 'endsWith': {
          where[id] = `(${value
            .map(
              (val) =>
                `${name} LIKE ${sqlstring.escape(`%${String(val).trim()}`)}`
            )
            .join(' OR ')})`;
          break;
        }
        case 'regex': {
          where[id] = `(${value
            .map(
              (val) =>
                `match(${name}, ${sqlstring.escape(stripLeadingAndTrailingSlashes(String(val)).trim())})`
            )
            .join(' OR ')})`;
          break;
        }
        case 'gt': {
          if (isNumericColumn(name)) {
            where[id] = `(${value
              .map(
                (val) =>
                  `toFloat64(${name}) > toFloat64(${sqlstring.escape(String(val).trim())})`
              )
              .join(' OR ')})`;
          } else {
            where[id] = `(${value
              .map((val) => `${name} > ${sqlstring.escape(String(val).trim())}`)
              .join(' OR ')})`;
          }
          break;
        }
        case 'lt': {
          if (isNumericColumn(name)) {
            where[id] = `(${value
              .map(
                (val) =>
                  `toFloat64(${name}) < toFloat64(${sqlstring.escape(String(val).trim())})`
              )
              .join(' OR ')})`;
          } else {
            where[id] = `(${value
              .map((val) => `${name} < ${sqlstring.escape(String(val).trim())}`)
              .join(' OR ')})`;
          }
          break;
        }
        case 'gte': {
          if (isNumericColumn(name)) {
            where[id] = `(${value
              .map(
                (val) =>
                  `toFloat64(${name}) >= toFloat64(${sqlstring.escape(String(val).trim())})`
              )
              .join(' OR ')})`;
          } else {
            where[id] = `(${value
              .map(
                (val) => `${name} >= ${sqlstring.escape(String(val).trim())}`
              )
              .join(' OR ')})`;
          }
          break;
        }
        case 'lte': {
          if (isNumericColumn(name)) {
            where[id] = `(${value
              .map(
                (val) =>
                  `toFloat64(${name}) <= toFloat64(${sqlstring.escape(String(val).trim())})`
              )
              .join(' OR ')})`;
          } else {
            where[id] = `(${value
              .map(
                (val) => `${name} <= ${sqlstring.escape(String(val).trim())}`
              )
              .join(' OR ')})`;
          }
          break;
        }
      }
    }
  });

  return where;
}

export function getChartStartEndDate(
  input: Pick<IReportInput, 'endDate' | 'startDate' | 'range'> & {
    dateConfig?: IDateConfig | null;
  },
  timezone: string
) {
  const { startDate, endDate, range, dateConfig } = input;

  // Explicit startDate/endDate always take precedence (ad-hoc overrides)
  if (startDate && endDate) {
    return { startDate, endDate };
  }

  // If dateConfig exists and no explicit override, resolve dynamically
  if (dateConfig && range === 'custom') {
    const now = DateTime.now().setZone(timezone);
    switch (dateConfig.dateMode) {
      case 'fixed':
        if (dateConfig.fixedStartDate && dateConfig.fixedEndDate) {
          const startDt = DateTime.fromISO(dateConfig.fixedStartDate, {
            zone: timezone,
          });
          const endDt = DateTime.fromISO(dateConfig.fixedEndDate, {
            zone: timezone,
          });
          return {
            startDate: (dateConfig.enableTimeRanges
              ? startDt
              : startDt.startOf('day')
            ).toFormat('yyyy-MM-dd HH:mm:ss'),
            endDate: (dateConfig.enableTimeRanges
              ? endDt
              : endDt.endOf('day')
            ).toFormat('yyyy-MM-dd HH:mm:ss'),
          };
        }
        break;
      case 'last': {
        const amount = dateConfig.lastAmount ?? 7;
        const unit = dateConfig.lastUnit ?? 'day';
        const endingDaysAgo = dateConfig.lastEndingDaysAgo ?? 0;
        const end = now.minus({ day: endingDaysAgo }).endOf('day');
        // Months are variable-length — subtract calendar months, not
        // a flat 30-day approximation, so "Last 12 months" is a year.
        const delta =
          unit === 'week'
            ? { week: amount }
            : unit === 'month'
              ? { month: amount }
              : { day: amount };
        const start = end.minus(delta).startOf('day');
        return {
          startDate: start.toFormat('yyyy-MM-dd HH:mm:ss'),
          endDate: end.toFormat('yyyy-MM-dd HH:mm:ss'),
        };
      }
      case 'since':
        if (dateConfig.sinceDate) {
          const sinceDt = DateTime.fromISO(dateConfig.sinceDate, {
            zone: timezone,
          });
          return {
            startDate: (dateConfig.enableTimeRanges
              ? sinceDt
              : sinceDt.startOf('day')
            ).toFormat('yyyy-MM-dd HH:mm:ss'),
            endDate: now.endOf('day').toFormat('yyyy-MM-dd HH:mm:ss'),
          };
        }
        break;
      case 'period_to_date': {
        const periodUnit = dateConfig.periodToDateUnit ?? 'month';
        const unitMap: Record<string, 'week' | 'month' | 'quarter' | 'year'> = {
          week: 'week',
          month: 'month',
          quarter: 'quarter',
          year: 'year',
        };
        const luxonUnit = unitMap[periodUnit] ?? 'month';
        return {
          startDate: now.startOf(luxonUnit).toFormat('yyyy-MM-dd HH:mm:ss'),
          endDate: now.endOf('day').toFormat('yyyy-MM-dd HH:mm:ss'),
        };
      }
    }
  }

  const ranges = getDatesFromRange(range, timezone);
  if (!startDate && endDate) {
    return { startDate: ranges.startDate, endDate };
  }

  return ranges;
}

export function getDatesFromRange(range: IChartRange, timezone: string) {
  if (range === '30min' || range === 'lastHour') {
    const minutes = range === '30min' ? 30 : 60;
    const startDate = DateTime.now()
      .minus({ minute: minutes })
      .startOf('minute')
      .setZone(timezone)
      .toFormat('yyyy-MM-dd HH:mm:ss');
    const endDate = DateTime.now()
      .setZone(timezone)
      .endOf('minute')
      .toFormat('yyyy-MM-dd HH:mm:ss');

    return {
      startDate: startDate,
      endDate: endDate,
    };
  }

  if (range === 'today') {
    // Clip endDate to now (not end-of-day) so the count reflects elapsed
    // time only. This makes "compare to previous period" line up with the
    // same wall-clock window yesterday (Mixpanel-style); without it we'd
    // compare today's partial data to yesterday's full 24h.
    const startDate = DateTime.now()
      .setZone(timezone)
      .startOf('day')
      .toFormat('yyyy-MM-dd HH:mm:ss');
    const endDate = DateTime.now()
      .setZone(timezone)
      .toFormat('yyyy-MM-dd HH:mm:ss');

    return {
      startDate: startDate,
      endDate: endDate,
    };
  }

  if (range === 'yesterday') {
    const startDate = DateTime.now()
      .minus({ day: 1 })
      .setZone(timezone)
      .startOf('day')
      .toFormat('yyyy-MM-dd HH:mm:ss');
    const endDate = DateTime.now()
      .minus({ day: 1 })
      .setZone(timezone)
      .endOf('day')
      .toFormat('yyyy-MM-dd HH:mm:ss');
    return {
      startDate: startDate,
      endDate: endDate,
    };
  }

  if (range === '7d') {
    const startDate = DateTime.now()
      .minus({ day: 7 })
      .setZone(timezone)
      .startOf('day')
      .toFormat('yyyy-MM-dd HH:mm:ss');
    const endDate = DateTime.now()
      .setZone(timezone)
      .endOf('day')
      .plus({ millisecond: 1 })
      .toFormat('yyyy-MM-dd HH:mm:ss');

    return {
      startDate: startDate,
      endDate: endDate,
    };
  }

  if (range === '3m' || range === '6m') {
    const startDate = DateTime.now()
      .minus({ month: range === '3m' ? 3 : 6 })
      .setZone(timezone)
      .startOf('day')
      .toFormat('yyyy-MM-dd HH:mm:ss');
    const endDate = DateTime.now()
      .setZone(timezone)
      .endOf('day')
      .plus({ millisecond: 1 })
      .toFormat('yyyy-MM-dd HH:mm:ss');

    return {
      startDate: startDate,
      endDate: endDate,
    };
  }

  if (range === '12m') {
    const startDate = DateTime.now()
      .minus({ month: 12 })
      .setZone(timezone)
      .startOf('month')
      .toFormat('yyyy-MM-dd HH:mm:ss');
    const endDate = DateTime.now()
      .setZone(timezone)
      .endOf('month')
      .plus({ millisecond: 1 })
      .toFormat('yyyy-MM-dd HH:mm:ss');

    return {
      startDate: startDate,
      endDate: endDate,
    };
  }

  if (range === 'monthToDate') {
    // Clip endDate to now so previous-month comparison uses the matching
    // partial-month window (Mixpanel-style).
    const startDate = DateTime.now()
      .setZone(timezone)
      .startOf('month')
      .toFormat('yyyy-MM-dd HH:mm:ss');
    const endDate = DateTime.now()
      .setZone(timezone)
      .toFormat('yyyy-MM-dd HH:mm:ss');

    return {
      startDate: startDate,
      endDate: endDate,
    };
  }

  if (range === 'lastMonth') {
    const month = DateTime.now()
      .minus({ month: 1 })
      .setZone(timezone)
      .startOf('month');

    const startDate = month.toFormat('yyyy-MM-dd HH:mm:ss');
    const endDate = month
      .endOf('month')
      .plus({ millisecond: 1 })
      .toFormat('yyyy-MM-dd HH:mm:ss');

    return {
      startDate: startDate,
      endDate: endDate,
    };
  }

  if (range === 'yearToDate') {
    // Clip endDate to now so previous-year comparison uses the matching
    // partial-year window (Mixpanel-style).
    const startDate = DateTime.now()
      .setZone(timezone)
      .startOf('year')
      .toFormat('yyyy-MM-dd HH:mm:ss');
    const endDate = DateTime.now()
      .setZone(timezone)
      .toFormat('yyyy-MM-dd HH:mm:ss');

    return {
      startDate: startDate,
      endDate: endDate,
    };
  }

  if (range === 'lastYear') {
    const year = DateTime.now().minus({ year: 1 }).setZone(timezone);
    const startDate = year.startOf('year').toFormat('yyyy-MM-dd HH:mm:ss');
    const endDate = year.endOf('year').toFormat('yyyy-MM-dd HH:mm:ss');

    return {
      startDate: startDate,
      endDate: endDate,
    };
  }

  // range === '30d'
  const startDate = DateTime.now()
    .minus({ day: 30 })
    .setZone(timezone)
    .startOf('day')
    .toFormat('yyyy-MM-dd HH:mm:ss');
  const endDate = DateTime.now()
    .setZone(timezone)
    .endOf('day')
    .plus({ millisecond: 1 })
    .toFormat('yyyy-MM-dd HH:mm:ss');

  return {
    startDate: startDate,
    endDate: endDate,
  };
}

export function getChartPrevStartEndDate({
  startDate,
  endDate,
  range,
}: {
  startDate: string;
  endDate: string;
  range?: IChartRange;
}) {
  const start = DateTime.fromFormat(startDate, 'yyyy-MM-dd HH:mm:ss');
  const end = DateTime.fromFormat(endDate, 'yyyy-MM-dd HH:mm:ss');

  // For "partial period" ranges (today/lastHour/monthToDate/yearToDate)
  // the window is shorter than the natural calendar unit, so the legacy
  // "subtract diff" comparison ends up comparing today-morning vs
  // yesterday-evening. Instead shift one calendar unit back so we compare
  // the same wall-clock window a period earlier (Mixpanel-style).
  const calendarShift = (() => {
    switch (range) {
      case 'today':
        return { days: 1 } as const;
      case 'lastHour':
        return { hours: 1 } as const;
      case 'monthToDate':
        return { months: 1 } as const;
      case 'yearToDate':
        return { years: 1 } as const;
      default:
        return null;
    }
  })();

  if (calendarShift) {
    return {
      startDate: start.minus(calendarShift).toFormat('yyyy-MM-dd HH:mm:ss'),
      endDate: end.minus(calendarShift).toFormat('yyyy-MM-dd HH:mm:ss'),
    };
  }

  let diff = end.diff(start);

  // this will make sure our start and end date's are correct
  // otherwise if a day ends with 23:59:59.999 and starts with 00:00:00.000
  // the diff will be 23:59:59.999 and that will make the start date wrong
  // so we add 1 millisecond to the diff
  if ((diff.milliseconds / 1000) % 2 !== 0) {
    diff = diff.plus({ millisecond: 1 });
  }

  return {
    startDate: start
      .minus({ millisecond: diff.milliseconds })
      .toFormat('yyyy-MM-dd HH:mm:ss'),
    endDate: end
      .minus({ millisecond: diff.milliseconds })
      .toFormat('yyyy-MM-dd HH:mm:ss'),
  };
}
