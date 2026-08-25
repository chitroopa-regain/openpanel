import type {
  ICustomCohortCriterion,
  ICustomCohortDefinition,
  ICustomCohortGroup,
  ICustomCohortWindow,
} from '@openpanel/validation';
import sqlstring from 'sqlstring';
import { TABLE_NAMES } from '../clickhouse/client';
import { getCustomEventWhereClause, getEventFiltersWhereClause } from './chart.service';

/**
 * Aliases a compiled cohort predicate may be rendered against. Closed union on
 * purpose: the alias is never a string taken from client input.
 */
export type CohortAlias = 'e' | 'e2' | 'base' | 'sessions' | 'profiles' | null;

/**
 * A compiled cohort. `render` produces the SQL for a given alias; the AST is
 * never serialised into report input, a zod schema, or structured logging.
 */
export interface CompiledCohort {
  cohortId: string;
  name: string;
  version: number;
  render: (alias: CohortAlias) => string;
}

/**
 * Resolve cohorts for a BREAKDOWN: each one stays separate (one series per
 * cohort) rather than being AND-combined into a single audience predicate.
 * Returned in the REQUESTED id order — never the order Postgres happened to
 * return rows in — and keyed by id so a rename cannot move data between series.
 */
export async function resolveCohortsForBreakdown(
  cohortIds: string[] | undefined,
  projectId: string,
  asOf: string,
): Promise<CompiledCohort[]> {
  if (!cohortIds?.length) return [];
  const resolved = await resolveAudience(cohortIds, projectId, asOf);
  const byId = new Map(resolved.cohorts.map((c) => [c.cohortId, c]));
  return cohortIds.map((id) => {
    const c = byId.get(id);
    if (!c) throw new Error(`Custom cohort not found: ${id}`);
    return c;
  });
}

export interface ResolvedAudience {
  cohorts: CompiledCohort[];
  /** AND-combined predicate for every cohort, or null when there is no audience. */
  render: (alias: CohortAlias) => string | null;
  /** Max cohort version — folded into cache keys so an edit invalidates. */
  effectiveVersion: number;
}

function qualify(alias: CohortAlias, column = 'profile_id') {
  return alias ? `${alias}.${column}` : column;
}

/**
 * Resolve a cohort window to half-open [start, end) ClickHouse expressions.
 *
 * `last N <unit>` means CALENDAR units in the project timezone, not rolling
 * 24h multiples — matching how the rest of the product and cohort_events_mv
 * bucket. A `fixed` window uses its own explicit end and ignores asOf.
 */
export function resolveCohortWindow(
  window: ICustomCohortWindow,
  asOf: string,
  timezone: string,
): { start: string; end: string } {
  const tz = sqlstring.escape(timezone);
  const at = `toDateTime(${sqlstring.escape(asOf)}, ${tz})`;

  if (window.type === 'ever') {
    // No lower bound. toDateTime(0) is the epoch.
    return { start: 'toDateTime(0)', end: at };
  }

  if (window.type === 'fixed') {
    return {
      start: `toDateTime(${sqlstring.escape(`${window.start} 00:00:00`)}, ${tz})`,
      // half-open: end date is inclusive to the user, so add a day
      end: `toDateTime(${sqlstring.escape(`${window.end} 00:00:00`)}, ${tz}) + INTERVAL 1 DAY`,
    };
  }

  const n = window.amount;
  switch (window.unit) {
    case 'day':
      return { start: `toStartOfDay(${at}, ${tz}) - INTERVAL ${n - 1} DAY`, end: at };
    case 'week':
      // mode 1 = weeks start on Monday
      return { start: `toStartOfWeek(${at}, 1, ${tz}) - INTERVAL ${n - 1} WEEK`, end: at };
    case 'month':
      // `last 1 month` = from the first day of the CURRENT calendar month
      return {
        start: `toStartOfMonth(subtractMonths(${at}, ${n - 1}), ${tz})`,
        end: at,
      };
  }
}

export type CustomEventComponents = { eventName: string; filters: any[] }[];
/** customEventId -> its resolved components, loaded once per compile. */
export type ComponentsById = Map<string, CustomEventComponents>;

function eventPredicate(
  criterion: ICustomCohortCriterion,
  projectId: string,
  componentsById: ComponentsById,
): string {
  if (typeof criterion.event !== 'string') {
    const components = componentsById.get(criterion.event.customEventId);
    if (!components?.length) {
      // Fail loudly. Casting the object to a string here would silently compile
      // a predicate that matches nothing — the exact 0-users failure mode this
      // feature exists to avoid.
      throw new Error(
        `Custom event "${criterion.event.customEventId}" referenced by this cohort was not found`,
      );
    }
    return getCustomEventWhereClause(components as any, projectId);
  }
  return `name = ${sqlstring.escape(criterion.event)}`;
}

/** Collect every customEventId referenced anywhere in a definition. */
export function collectCustomEventIds(
  definition: ICustomCohortDefinition,
): string[] {
  const ids = new Set<string>();
  for (const group of definition.groups) {
    for (const criterion of group.criteria) {
      if (typeof criterion.event !== 'string') {
        ids.add(criterion.event.customEventId);
      }
    }
  }
  return [...ids];
}

/** Load referenced custom events in ONE query and index them by id. */
export async function loadComponentsById(
  definition: ICustomCohortDefinition,
  projectId: string,
): Promise<ComponentsById> {
  const ids = collectCustomEventIds(definition);
  if (!ids.length) return new Map();

  // Imported lazily so the pure SQL compiler in this file stays importable
  // (and unit-testable) without a database connection or env.
  const { db } = await import('../prisma-client');
  const rows = await db.customEvent.findMany({ where: { id: { in: ids } } });
  const map: ComponentsById = new Map();
  for (const row of rows) {
    if (row.projectId !== projectId) continue;
    map.set(row.id, row.components as CustomEventComponents);
  }
  const missing = ids.filter((id) => !map.has(id));
  if (missing.length) {
    throw new Error(
      `Custom event(s) referenced by this cohort no longer exist: ${missing.join(', ')}`,
    );
  }
  return map;
}

/** The HAVING expression implementing the criterion's aggregate + operator. */
function havingExpression(criterion: ICustomCohortCriterion): string {
  const agg = criterion.aggregate;
  let expr: string;
  switch (agg.kind) {
    case 'total_events':
      expr = 'count()';
      break;
    case 'distinct_days':
      expr = 'uniqExact(toDate(created_at))';
      break;
    case 'property_sum':
    case 'property_average': {
      const key = sqlstring.escape(agg.property);
      const coerced =
        agg.coercion === 'float_or_zero'
          ? `toFloat64OrZero(properties[${key}])`
          : `toFloat64OrNull(properties[${key}])`;
      expr = agg.kind === 'property_sum' ? `sum(${coerced})` : `avg(${coerced})`;
      break;
    }
  }

  switch (criterion.operator) {
    case 'gte':
      return `${expr} >= ${criterion.value}`;
    case 'lte':
      return `${expr} <= ${criterion.value}`;
    case 'eq':
      return `${expr} = ${criterion.value}`;
    case 'between':
      return `${expr} >= ${criterion.value} AND ${expr} <= ${criterion.value2 ?? criterion.value}`;
  }
}

/**
 * cohort_events_mv is NOT a safe source for cohorts — not even for existence.
 *
 * Two independent defects, both measured:
 *
 * 1. `event_count` is a bare UInt64 under AggregatingMergeTree, so partial
 *    counts are NEVER summed on merge. Locally it reported 2,268 occurrences
 *    where `events` has 121,247 (1.9%); on production it captures ~51% and
 *    returns ZERO for any threshold above ~50.
 *
 * 2. More fundamentally, its COVERAGE is not guaranteed to match `events`. A
 *    materialized view only sees rows inserted while it exists, through the
 *    insert path it is attached to. On the local instance the MV holds zero
 *    rows for 2026-05 while `events` holds 2.8M for the same month, so even a
 *    plain "did this event at all" check returned 1,021 profiles instead of
 *    1,952 — a 48% undercount with no error and no warning.
 *
 * An earlier revision of this file had a `canUseMv()` fast path for unfiltered
 * `total_events >= 1`, justified by a production measurement where MV and
 * events happened to agree exactly. Defect 2 shows that agreement is a property
 * of one project's ingestion history, not an invariant. The path was removed.
 * Do not reintroduce it: a ~2x saving is not worth a silently wrong audience.
 */

/** The profile set matching a criterion's POSITIVE predicate. */
function positiveSetSql(
  criterion: ICustomCohortCriterion,
  projectId: string,
  asOf: string,
  timezone: string,
  componentsById: ComponentsById,
): string {
  const { start, end } = resolveCohortWindow(criterion.window, asOf, timezone);
  const project = sqlstring.escape(projectId);
  const filters = Object.values(
    getEventFiltersWhereClause(criterion.filters, projectId),
  );
  const where = [
    `project_id = ${project}`,
    eventPredicate(criterion, projectId, componentsById),
    `created_at >= ${start}`,
    `created_at < ${end}`,
    'profile_id != device_id',
    ...filters,
  ].join(' AND ');

  return `SELECT profile_id FROM ${TABLE_NAMES.events} WHERE ${where} GROUP BY profile_id HAVING ${havingExpression(criterion)}`;
}

/**
 * The population a `did_not` criterion subtracts from.
 *
 * 'all_identified' reads the bounded profiles table so a DORMANT user with zero
 * events in the window still matches "did not do X" — the intuitive churn
 * meaning. `profiles` is a ReplacingMergeTree with ~3x un-collapsed duplication,
 * hence DISTINCT.
 */
function universeSql(
  criterion: ICustomCohortCriterion,
  projectId: string,
  asOf: string,
  timezone: string,
): string {
  const project = sqlstring.escape(projectId);
  if (criterion.universe === 'active_in_window') {
    const { start, end } = resolveCohortWindow(criterion.window, asOf, timezone);
    return `SELECT DISTINCT profile_id FROM ${TABLE_NAMES.events} WHERE project_id = ${project} AND created_at >= ${start} AND created_at < ${end} AND profile_id != device_id`;
  }
  return `SELECT DISTINCT id AS profile_id FROM ${TABLE_NAMES.profiles} WHERE project_id = ${project}`;
}

/**
 * Compile one criterion to a profile-set subquery.
 *
 * `did_not(C)` = universe MINUS the profiles satisfying C. It is NOT "never did
 * the event": with `total_events >= 5`, profiles with 0..4 occurrences match.
 */
export function compileCriterion(
  criterion: ICustomCohortCriterion,
  projectId: string,
  asOf: string,
  timezone: string,
  componentsById: ComponentsById = new Map(),
): string {
  const positive = positiveSetSql(
    criterion,
    projectId,
    asOf,
    timezone,
    componentsById,
  );

  if (criterion.kind === 'did') {
    return positive;
  }

  // LEFT ANTI JOIN, not `LEFT ANY JOIN ... WHERE m.profile_id = ''`.
  //
  // The sentinel form is only correct while unmatched rows are filled with the
  // column DEFAULT. Under `join_use_nulls = 1` they are filled with NULL
  // instead, `m.profile_id = ''` matches nothing, and the cohort silently
  // becomes empty — a wrong audience with no error. ANTI JOIN expresses "rows
  // on the left with no match on the right" directly and is unaffected by that
  // setting. NOT IN is avoided for the same null-fragility reason.
  const universe = universeSql(criterion, projectId, asOf, timezone);
  return `SELECT u.profile_id AS profile_id FROM (${universe}) AS u LEFT ANTI JOIN (${positive}) AS m ON m.profile_id = u.profile_id`;
}

function compileGroup(
  group: ICustomCohortGroup,
  projectId: string,
  asOf: string,
  timezone: string,
  componentsById: ComponentsById,
): string[] {
  const sets = group.criteria.map((c) =>
    compileCriterion(c, projectId, asOf, timezone, componentsById),
  );

  if (group.op === 'or') {
    // UNION ALL + outer dedup is cheaper than UNION DISTINCT.
    return [
      `SELECT profile_id FROM (${sets.join(' UNION ALL ')}) GROUP BY profile_id`,
    ];
  }
  // AND: independent sets, each applied as its own IN predicate.
  return sets;
}

/**
 * Compile a whole definition into a list of profile-set subqueries that must
 * ALL match (top-level AND), or a single unioned set (top-level OR).
 */
export function compileDefinition(
  definition: ICustomCohortDefinition,
  projectId: string,
  asOf: string,
  timezone: string,
  componentsById: ComponentsById = new Map(),
): string[] {
  const perGroup = definition.groups.map((g) =>
    compileGroup(g, projectId, asOf, timezone, componentsById),
  );

  if (definition.op === 'or') {
    const flattened = perGroup.map((sets) =>
      sets.length === 1
        ? sets[0]!
        : // AND-group inside an OR needs to become one set
          sets
            .slice(1)
            .reduce(
              (acc, s) => `SELECT profile_id FROM (${acc}) WHERE profile_id IN (${s})`,
              sets[0]!,
            ),
    );
    return [
      `SELECT profile_id FROM (${flattened.join(' UNION ALL ')}) GROUP BY profile_id`,
    ];
  }

  return perGroup.flat();
}

/**
 * Resolve report `audience.cohortIds` into a compiled, typed predicate.
 *
 * One Postgres query for every referenced cohort (no N+1), and every row is
 * asserted to belong to the requesting project — an id alone is never trusted.
 */
export async function resolveAudience(
  cohortIds: string[] | undefined,
  projectId: string,
  asOf: string,
): Promise<ResolvedAudience> {
  const empty: ResolvedAudience = {
    cohorts: [],
    render: () => null,
    effectiveVersion: 0,
  };
  if (!cohortIds?.length) return empty;

  const { db } = await import('../prisma-client');
  const { getSettingsForProject } = await import('./organization.service');
  const [rows, { timezone }] = await Promise.all([
    db.customCohort.findMany({ where: { id: { in: cohortIds } } }),
    getSettingsForProject(projectId),
  ]);

  const missing = cohortIds.filter((id) => !rows.some((r) => r.id === id));
  if (missing.length) {
    throw new Error(`Custom cohort not found: ${missing.join(', ')}`);
  }
  const foreign = rows.filter((r) => r.projectId !== projectId);
  if (foreign.length) {
    throw new Error(
      `Custom cohort does not belong to this project: ${foreign.map((f) => f.name).join(', ')}`,
    );
  }

  const cohorts: CompiledCohort[] = await Promise.all(rows.map(async (row) => {
    const definition = row.definition as ICustomCohortDefinition;
    const componentsById = await loadComponentsById(definition, projectId);
    const sets = compileDefinition(
      definition,
      projectId,
      asOf,
      timezone,
      componentsById,
    );
    return {
      cohortId: row.id,
      name: row.name,
      version: row.version,
      render: (alias: CohortAlias) =>
        sets.map((set) => `${qualify(alias)} IN (${set})`).join(' AND '),
    };
  }));

  return {
    cohorts,
    effectiveVersion: Math.max(...cohorts.map((c) => c.version)),
    render: (alias: CohortAlias) =>
      cohorts.length ? cohorts.map((c) => c.render(alias)).join(' AND ') : null,
  };
}
