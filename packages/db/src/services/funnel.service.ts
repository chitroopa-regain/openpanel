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
import { resolveAudience } from './custom-cohort.service';
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
 *   - leaves identifier suffixes alone (anything preceded by a word char,
 *     e.g. `ft_profile_id` from the first-time-ever JOIN alias must not be
 *     split into `ft_` + `events.profile_id`)
 *
 * Covers the event columns that funnel condition builders actually emit:
 * profile_id, device_id, created_at, name, properties. Other columns pass
 * through untouched.
 */
export function qualifyFunnelCondition(expr: string, alias = 'events'): string {
  const columnPattern =
    /^\b(profile_id|device_id|created_at|name|properties)\b/;
  const wordChar = /\w/;
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

    // Bare column identifier at a word boundary — qualify unless already
    // prefixed (`profile.profile_id`) OR mid-identifier (`ft_profile_id`).
    // The regex's `\b` anchor matches at slice-start regardless of what
    // precedes it in the full string, so we must inspect prevChar ourselves.
    const colMatch = expr.slice(i).match(columnPattern);
    if (colMatch) {
      const prevChar = i > 0 ? expr[i - 1]! : '';
      if (prevChar === '.' || wordChar.test(prevChar)) {
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
  projectId: string
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
          `Custom event "${item.displayName ?? item.customEventId}" not found or not accessible`
        );
      }
      const components = ce.components as ICustomEventComponent[];
      if (!Array.isArray(components) || components.length === 0) {
        throw new Error(`Custom event "${ce.name}" has no components`);
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
    firstTimeCteAliases: string[] = []
  ): string[] {
    return events.map((event, index) => {
      let condition: string;
      if (event.customEventComponents) {
        // Custom event: use OR-combined component conditions
        const componentClause = getCustomEventWhereClause(
          event.customEventComponents,
          projectId
        );
        // Also apply any outer series-level filters
        if (event.filters && event.filters.length > 0) {
          const outerWhere = getEventFiltersWhereClause(
            event.filters,
            projectId
          );
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
  /**
   * MV fast path: swap FROM `openpanel.events` with a subquery over
   * `openpanel.event_profile_firsts_local` that unpacks each row's
   * (min, max) identified-timestamps via `arrayJoin([min, max])` and
   * feeds the resulting stream to the SAME `windowFunnel` operator
   * used by the raw-events path. Identical outer aggregation logic —
   * only the source of timestamps changes.
   *
   * The MV drops event properties, so this only applies to "simple"
   * funnels (no per-event property filters, no firstTimeFilter, no
   * event-property breakdowns, no session grouping, no profile-scalar
   * filters). Anything else falls back to `buildFunnelCte` unchanged.
   *
   * Which projects qualify at all is auto-detected from the MV itself
   * (see `getMvProjectCoverage`) — no per-project env-var maintenance.
   * A project qualifies when the MV has data for it AND that data
   * covers the requested query range AND the MV is fresh (max_day
   * within OP_FUNNEL_MV_MAX_STALENESS_HOURS of "now"). Set
   * OP_FUNNEL_MV_DISABLED=1 to hard-disable the fast path globally.
   *
   * Correctness parity verified against the raw path at 7d/14d/30d for
   * brainrot-app on 2026-07-15: exact match modulo live-event drift
   * of ±few users (see scratchpad/mv_baseline.md). Latency drops from
   * ~45s to ~1s on the reference 30-day install→engagement funnel.
   */
  async isMvEligibleFunnel(params: {
    eventSeries: ResolvedFunnelStep[];
    breakdowns: { name: string }[];
    groupBy: 'session_id' | 'profile_id';
    anyFilterOnProfile: boolean;
    anyBreakdownOnProfile: boolean;
    projectId: string;
    traitDescriptors: Map<string, TraitBreakdown>;
    startDate: string;
    hasAudience?: boolean;
  }): Promise<boolean> {
    // Global kill switch (no code change needed to revert everywhere).
    if (
      process.env.OP_FUNNEL_MV_DISABLED === '1' ||
      process.env.OP_FUNNEL_MV_DISABLED === 'true'
    ) {
      return false;
    }

    // A cohort audience compiles to a SESSION-eligibility semi-join, and the MV
    // (event_profile_firsts_local) has no session_id at all, so the predicate
    // cannot be expressed there. Filtering the MV on profile_id instead would
    // be exactly the row-filter semantics the session semi-join exists to
    // avoid, and would mix two sources whose coverage drifts independently —
    // the failure already measured on cohort_events_mv. Take the raw path.
    if (params.hasAudience) return false;

    // MV is per profile_id — no session mode.
    if (params.groupBy !== 'profile_id') return false;

    // Filters/breakdowns on this whitelist of top-level event columns are
    // supported because they are stored directly in the MV grain
    // (event_profile_firsts_local's ORDER BY / GROUP BY). Anything else
    // (event properties like `properties.foo`, uncommon top-level cols like
    // `os_version`, `brand`) forces the raw path. See the funnel audit in
    // scratchpad/mv_baseline.md — this whitelist covers ~66% of brainpal +
    // 79% of regain funnels while keeping MV row growth under ~1.5×.
    const MV_ALLOWED_COLUMNS = new Set(['app_version', 'country']);

    for (const step of params.eventSeries) {
      if (step.firstTimeFilter) return false;
      const stepFilters = step.filters ?? [];
      if (stepFilters.some((f) => !MV_ALLOWED_COLUMNS.has(f.name))) return false;
      const componentFilters = (step.customEventComponents ?? []).flatMap(
        (c) => c.filters ?? [],
      );
      if (componentFilters.some((f) => !MV_ALLOWED_COLUMNS.has(f.name)))
        return false;
    }

    // Breakdown on any column outside the whitelist → raw. Trait
    // (profile.properties.*) breakdowns still fall through here because the
    // trait CTE join hasn't been ported to the MV subquery yet.
    for (const b of params.breakdowns) {
      if (!MV_ALLOWED_COLUMNS.has(b.name)) return false;
    }

    if (params.anyFilterOnProfile || params.anyBreakdownOnProfile) return false;
    if (params.traitDescriptors.size > 0) return false;

    // Auto-detect: MV must have data for this project, covering the
    // query range, AND be fresh (writer not stalled).
    const coverage = await this.getMvProjectCoverage(params.projectId);
    if (!coverage) return false;
    const startDay = params.startDate.slice(0, 10); // 'YYYY-MM-DD'
    if (coverage.minDay > startDay) return false; // backfill doesn't cover range
    const maxStalenessHours = Number(
      process.env.OP_FUNNEL_MV_MAX_STALENESS_HOURS || 24,
    );
    if (coverage.stalenessHours > maxStalenessHours) return false;

    return true;
  }

  /**
   * Per-project MV coverage cache with TTL. Populated lazily on first
   * funnel request. Key insight: the MV auto-discovers which projects
   * are eligible (any project with rows in event_profile_firsts_local),
   * so onboarding a new app is just "backfill the MV" — no env-var edit
   * or code change needed. Cache TTL (default 15 min) governs how
   * quickly a freshly-backfilled project becomes visible.
   *
   * Failure modes handled:
   * - MV table missing (fresh install / self-hosted): returns null,
   *   falls back to raw-events path. No boot-time crash.
   * - MV writer stalled (max day too old): caller filters via
   *   OP_FUNNEL_MV_MAX_STALENESS_HOURS to avoid serving gap-riddled
   *   funnels.
   */
  private mvCoverageCache: {
    fetchedAt: number;
    coverage: Map<
      string,
      { minDay: string; maxDay: string; stalenessHours: number }
    >;
  } | null = null;

  private async getMvProjectCoverage(
    projectId: string,
  ): Promise<
    { minDay: string; maxDay: string; stalenessHours: number } | null
  > {
    const ttlSec = Number(process.env.OP_FUNNEL_MV_CACHE_TTL_SECONDS || 900);
    const nowMs = Date.now();
    if (
      !this.mvCoverageCache ||
      nowMs - this.mvCoverageCache.fetchedAt > ttlSec * 1000
    ) {
      const coverage = new Map<
        string,
        { minDay: string; maxDay: string; stalenessHours: number }
      >();
      try {
        const rows = await chQuery<{
          project_id: string;
          min_day: string;
          max_day: string;
          staleness_hours: number;
        }>(
          `SELECT project_id,
                  toString(min(day)) AS min_day,
                  toString(max(day)) AS max_day,
                  dateDiff('hour', toDateTime(max(day)) + INTERVAL 1 DAY, now()) AS staleness_hours
           FROM ${TABLE_NAMES.event_profile_firsts}
           GROUP BY project_id`,
        );
        for (const r of rows) {
          coverage.set(r.project_id, {
            minDay: r.min_day,
            maxDay: r.max_day,
            stalenessHours: Number(r.staleness_hours),
          });
        }
      } catch {
        // MV table doesn't exist (fresh install / self-hosted). Leave
        // cache empty — all funnels route through raw-events path.
      }
      this.mvCoverageCache = { fetchedAt: nowMs, coverage };
    }
    return this.mvCoverageCache.coverage.get(projectId) ?? null;
  }

  /**
   * MV-backed drop-in for `buildFunnelCte`'s session_funnel body. Returns
   * a raw SQL string (register via `funnelQuery.with('session_funnel', sql)`).
   * Same shape as buildFunnelCte's return so callers can branch cleanly.
   */
  buildFunnelCteFromMv({
    projectId,
    startDate,
    endDate,
    eventSeries,
    funnelWindowMilliseconds,
    additionalSelects = [],
    additionalGroupBy = [],
  }: {
    projectId: string;
    startDate: string;
    endDate: string;
    eventSeries: ResolvedFunnelStep[];
    funnelWindowMilliseconds: number;
    /**
     * Breakdown expression selects like `app_version as b_0` or
     * `argMaxIf(app_version, created_at, name = 'X') as b_0`. `created_at`
     * refs are rewritten to `ts` (the arrayJoin output). Since MV
     * eligibility only whitelists top-level cols (app_version, country),
     * the expression itself resolves against the MV subquery's projection.
     */
    additionalSelects?: string[];
    additionalGroupBy?: string[];
  }): { sql: string; firstTimeCtes: never[]; traitCtes: never[] } {
    const escapedProject = sqlstring.escape(projectId);
    const escapedStart = sqlstring.escape(startDate);
    const escapedEnd = sqlstring.escape(endDate);
    const funnelWindowSeconds = Math.ceil(funnelWindowMilliseconds / 1000);

    const rawFunnels = this.getFunnelConditions(eventSeries, projectId);
    if (rawFunnels.length === 0) {
      throw new Error('MV funnel requires at least one step');
    }

    // Anchor step 1 to the report range. Steps 2..N are gated by the
    // windowFunnel operator itself (funnelWindowMilliseconds).
    // Rewrite `created_at` -> `ts` since the MV subquery aliases the
    // unpacked timestamp as `ts`. `name` and `properties` refs pass
    // through unchanged (MV subquery exposes `name`).
    const funnels = rawFunnels.map((f) => f.replace(/\bcreated_at\b/g, 'ts'));
    funnels[0] =
      `(${funnels[0]}) AND ts >= toDateTime64(${escapedStart}, 3) AND ts <= toDateTime64(${escapedEnd}, 3)`;

    const allEventNames = uniq(
      eventSeries.flatMap((e) =>
        e.customEventComponents
          ? e.customEventComponents.map((c) => c.eventName)
          : [e.name],
      ),
    );
    const escapedNames = allEventNames
      .map((n) => sqlstring.escape(n))
      .join(', ');

    // Project the MV whitelist columns (app_version, country) alongside
    // the timestamp so step conditions like `app_version = '9.8.415'` and
    // WITH FILL breakdowns on `country` resolve to real column refs. If we
    // later widen the whitelist, add columns here AND in the MV schema.
    //
    // Breakdown SELECTs (additionalSelects) come from the outer breakdown
    // builder as `<expr> as b_0` or `argMaxIf(<expr>, created_at, <cond>) as b_0`.
    // Rewrite `created_at` -> `ts` in both — same as step conditions — so
    // argMaxIf's timestamp arg resolves to the arrayJoin output. Bare
    // column refs (app_version, country) pass through unchanged.
    const rewriteCreatedAt = (expr: string) =>
      expr.replace(/\bcreated_at\b/g, 'ts');
    const mvSelects = additionalSelects.map(rewriteCreatedAt);
    const extraSelectsClause =
      mvSelects.length > 0 ? `, ${mvSelects.join(', ')}` : '';
    const extraGroupByClause =
      additionalGroupBy.length > 0 ? `, ${additionalGroupBy.join(', ')}` : '';

    const sql = `SELECT profile_id AS profile_id,
        windowFunnel(${funnelWindowMilliseconds}, 'strict_increase')(
          toUInt64(toUnixTimestamp64Milli(ts)),
          ${funnels.join(', ')}
        ) AS level${extraSelectsClause}
      FROM (
        SELECT project_id, name, profile_id, app_version, country,
          arrayJoin([min_created_at_identified, max_created_at_identified]) AS ts
        FROM ${TABLE_NAMES.event_profile_firsts}
        WHERE project_id = ${escapedProject}
          AND name IN (${escapedNames})
          AND day BETWEEN toDate(${escapedStart}) AND addDays(toDate(${escapedEnd}), 1)
          AND min_created_at_identified > toDateTime64('1970-01-02', 3)
      )
      WHERE ts >= toDateTime64(${escapedStart}, 3)
        AND ts <= addSeconds(toDateTime64(${escapedEnd}, 3), ${funnelWindowSeconds})
      GROUP BY profile_id${extraGroupByClause}`;

    return { sql, firstTimeCtes: [], traitCtes: [] };
  }

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
    expectProfilesFinalJoin = false,
    audiencePredicate = null,
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
    /**
     * When true, the caller intends to attach `LEFT JOIN (SELECT ...
     * FROM profiles FINAL)` to the returned `query` AFTER this method
     * returns. That join can expose a second `properties` / `profile_id`
     * column, so this method must qualify its internal `windowFunnel`
     * step conditions (and the SELECT/WHERE/GROUP BY event-column refs)
     * with the `events` alias proactively — otherwise the caller's
     * later join silently creates `AMBIGUOUS_IDENTIFIER` failures on any
     * step condition that references `properties[...]`, `profile_id`,
     * `name`, `created_at`, etc. without an alias prefix. Trait CTE
     * joins trigger the same qualification path through
     * `traitDescriptors.size > 0`.
     */
    expectProfilesFinalJoin?: boolean;
    /**
     * Server-compiled cohort membership predicate (`profile_id IN (...)`).
     * Applied as SESSION ELIGIBILITY, never as a row filter — see below.
     */
    audiencePredicate?: string | null;
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
          stepPredicate = getCustomEventWhereClause(
            step.customEventComponents,
            projectId
          );
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

    const rawFunnels = this.getFunnelConditions(
      eventSeries,
      projectId,
      firstTimeCteAliases
    );

    // When a trait CTE is joined, OR the caller has signalled it will
    // attach a profiles FINAL join after this method returns, every bare
    // event-column reference in this query becomes ambiguous. Qualify
    // step conditions and static column refs with the `events.` alias
    // (the bare table name, since clix's .from() does not apply an
    // explicit alias). Subqueries inside `profile_id IN (...)` are
    // preserved by qualifyFunnelCondition's subquery-skip logic.
    const needsQualify = traitDescriptors.size > 0 || expectProfilesFinalJoin;
    const qualify = (expr: string) =>
      needsQualify ? qualifyFunnelCondition(expr, 'events') : expr;
    const col = (c: string) => (needsQualify ? `events.${c}` : c);

    const funnels = needsQualify
      ? rawFunnels.map((c) => qualify(c))
      : rawFunnels;

    // Mixpanel-parity attribution window: the report date range controls
    // funnel ENTRIES (step 1 only), while steps 2..N may complete after
    // endDate as long as they fall within funnelWindow of step 1's
    // timestamp. Anchor step 1 to [startDate, endDate] and let the outer
    // WHERE (extended below to endDate + funnelWindow) include later-step
    // events that windowFunnel itself will gate via the window parameter.
    if (funnels.length > 0) {
      funnels[0] = `(${funnels[0]}) AND ${col('created_at')} >= toDateTime(${escapedStart}) AND ${col('created_at')} <= toDateTime(${escapedEnd})`;
    }
    const funnelWindowSeconds = Math.ceil(funnelWindowMilliseconds / 1000);

    // Collect all real event names for the IN pre-filter.
    const allEventNames = uniq(
      eventSeries.flatMap((e) =>
        e.customEventComponents
          ? e.customEventComponents.map((c) => c.eventName)
          : [e.name]
      )
    );

    // Wrap the windowFunnel expression in clix.exp() so clix's select
    // serializer (which regex-escapes any embedded date-like substring
    // in plain strings via escapeDate → sqlstring.escape) leaves the
    // raw SQL alone. Since the Mixpanel-parity fix now embeds
    // `toDateTime('YYYY-MM-DD ...')` literals inside the step-1
    // predicate, a plain string here would get double-escaped to
    // `toDateTime(''YYYY-MM-DD ...'')` — which CH rejects with a
    // syntax error at the empty-string literal. See query-builder.ts
    // escapeDate + the comment on the SELECT serializer branch.
    const windowFunnelExpr = clix.exp(
      `windowFunnel(${funnelWindowMilliseconds}, 'strict_increase')(toUInt64(toUnixTimestamp64Milli(${col('created_at')})), ${funnels.join(', ')}) AS level`
    );
    const selects =
      groupBy === 'profile_id'
        ? [
            `${col('profile_id')} AS profile_id`,
            windowFunnelExpr,
            ...additionalSelects,
          ]
        : [
            `${col('session_id')} AS session_id`,
            windowFunnelExpr,
            `argMax(${col('profile_id')}, ${col('created_at')}) AS profile_id`,
            ...additionalSelects,
          ];

    // Cohort audience — attachment is MODE-DEPENDENT, because the two funnel
    // modes compute windowFunnel over different units:
    //
    //   session mode  — windowFunnel per session_id, profile extracted via
    //                   argMax. A session that starts anonymous and becomes
    //                   identified mid-way must still count, so filtering base
    //                   rows by profile_id would delete those pre-login rows.
    //                   Correct predicate: eligible SESSIONS (semi-join).
    //
    //   profile mode  — windowFunnel per profile_id directly, already filtered
    //                   to identified users (profile_id != device_id). Here a
    //                   session semi-join would be WRONG: it admits every row
    //                   of an eligible session, so any OTHER profile sharing
    //                   that session gets its own funnel group and is counted
    //                   despite not being a cohort member. Correct predicate:
    //                   the profile filter itself.
    //
    // Session-mode eligibility must span the funnel's EXPANDED scan
    // (endDate + funnelWindow), not endDate: step 1 is anchored to
    // [start, end] but steps 2..N may land up to funnelWindow later, and a user
    // who identifies in that tail would otherwise be dropped. Derived from the
    // same funnelWindowSeconds as the scan so the two cannot drift.
    //
    // session_id != '' guards against one cohort member with an empty session
    // id making every other empty-session event in the project eligible.
    const eligibilityClause = !audiencePredicate
      ? null
      : groupBy === 'session_id'
        ? `${col('session_id')} IN (
          SELECT DISTINCT session_id FROM ${TABLE_NAMES.events}
          WHERE project_id = ${escapedProject}
            AND created_at >= toDateTime(${escapedStart})
            AND created_at <= addSeconds(toDateTime(${escapedEnd}), ${funnelWindowSeconds})
            AND session_id != ''
            AND ${audiencePredicate}
        )`
        : qualify(audiencePredicate);

    const query = clix(this.client, timezone)
      .select(selects)
      .from(TABLE_NAMES.events, false)
      .where('project_id', '=', projectId)
      .rawWhere(
        `${col('created_at')} >= toDateTime(${escapedStart}) AND ${col('created_at')} <= addSeconds(toDateTime(${escapedEnd}), ${funnelWindowSeconds})`
      )
      .where('name', 'IN', allEventNames)
      .rawWhere(eligibilityClause ?? '1 = 1')
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
          alias
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
        `${desc.cteName}.profile_id = events.profile_id`
      );
    }

    // In profile mode, only include identified users to avoid
    // double-counting anonymous device_id-based profiles.
    if (groupBy === 'profile_id') {
      query.rawWhere(
        needsQualify
          ? 'events.profile_id != events.device_id'
          : 'profile_id != device_id'
      );
    }

    // Build the top-level CTE SQL for each trait descriptor so callers
    // can register them unconditionally. Returning the CTEs here — rather
    // than leaving each caller to loop over `traitDescriptors` again and
    // compose the same SELECT — removes the "passed traitDescriptors but
    // forgot to register the CTE" footgun that reached getFunnelProfiles.
    const traitCtes: { name: string; sql: string }[] = [];
    for (const desc of traitDescriptors.values()) {
      traitCtes.push({
        name: desc.cteName,
        sql: `SELECT profile_id, argMax(value, updated_at) AS value FROM ${TABLE_NAMES.profile_traits} WHERE project_id = ${escapedProject} AND key = ${sqlstring.escape(desc.key)} GROUP BY profile_id`,
      });
    }

    return { query, firstTimeCtes, traitCtes };
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
    steps: number
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
    limit: number | undefined = undefined
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
            normalizeBreakdownValue(f[`b_${index}`])
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
      >
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
    audience,
  }: IReportInput & { timezone: string; events?: IChartEvent[] }) {
    if (!startDate || !endDate) {
      throw new Error('startDate and endDate are required');
    }

    // Resolve the report-level audience once. asOf is the funnel's end date, so
    // a relative cohort window is evaluated as of the same instant as the data.
    const resolvedAudience = await resolveAudience(
      audience?.cohortIds,
      projectId,
      endDate,
    );
    const audiencePredicate = resolvedAudience.render(null);

    const funnelOptions = options?.type === 'funnel' ? options : undefined;
    const funnelWindowUnit = funnelOptions?.funnelWindowUnit ?? 'hour';
    // Default window is 24 hours. When unit is set but window is not,
    // convert 24 hours into the selected unit for a sensible default.
    const defaultWindowByUnit: Record<string, number> = {
      second: 86400, // 24h in seconds
      minute: 1440, // 24h in minutes
      hour: 24, // 24h
      day: 1, // 1 day
      week: 1, // 1 week
      month: 1, // 1 month
    };
    const funnelWindow =
      funnelOptions?.funnelWindow ??
      defaultWindowByUnit[funnelWindowUnit] ??
      24;
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
    // getProfileFilters returns every profile.* filter, including
    // profile.properties.<trait> filters. Trait filters are already
    // handled via `profile_id IN (SELECT profile_id FROM profile_traits
    // ...)` in the step condition; they do NOT need the profiles FINAL
    // join. Including them here was wasteful (attached an unused join)
    // AND actively harmful (exposed a second `properties` column that
    // made bare `properties[...]` references ambiguous in windowFunnel
    // step conditions and argMaxIf breakdown selects).
    const profileFiltersRaw = this.getProfileFilters(eventSeries);
    const profileFilters = profileFiltersRaw.filter(
      (f) => getTraitBreakdownDescriptor(`profile.${f}`) === null
    );
    const anyFilterOnProfile = profileFilters.length > 0;
    // profile.properties.* breakdowns use profile_traits CTE (traitDescriptors);
    // only profile.<scalar> breakdowns like profile.email still need the profiles CTE.
    const anyBreakdownOnProfile = breakdowns.some(
      (b) =>
        b.name.startsWith('profile.') &&
        getTraitBreakdownDescriptor(b.name) === null
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

    // When any extra join is attached to session_funnel (trait CTEs,
    // or profiles FINAL for scalar profile filters / scalar profile
    // breakdowns), bare event-column references inside argMaxIf
    // arguments become ambiguous — every join can expose overlapping
    // column names (profile.properties vs events.properties,
    // profile_id in the trait CTE, etc.). Qualify `created_at` AND the
    // full step condition with the `events` alias so references
    // resolve to the event row.
    //
    // Note: profile-trait filters like profile.properties.country are
    // already filtered out of `profileFilters` above, so they no
    // longer trigger the profiles FINAL join on their own. But a
    // scalar profile filter (e.g. profile.email) or a scalar profile
    // breakdown (e.g. profile.email) still will — hence this broader
    // trigger covers both trait CTE joins and that remaining path.
    const needsBreakdownQualify =
      traitDescriptors.size > 0 || anyFilterOnProfile || anyBreakdownOnProfile;
    const argMaxIfCreatedAt = needsBreakdownQualify
      ? 'events.created_at'
      : 'created_at';

    if (breakdownStep !== undefined && breakdownStep < eventSeries.length) {
      const stepConditions = this.getFunnelConditions(eventSeries, projectId);
      const rawStepCondition = stepConditions[breakdownStep]!;
      const stepCondition = needsBreakdownQualify
        ? qualifyFunnelCondition(rawStepCondition, 'events')
        : rawStepCondition;
      breakdownSelects = breakdowns.map(
        (b, index) =>
          `argMaxIf(${breakdownExpr(b.name)}, ${argMaxIfCreatedAt}, ${stepCondition}) as b_${index}`
      );
      // No GROUP BY for breakdown columns — argMaxIf aggregates them
      breakdownGroupBy = [];
    } else {
      breakdownSelects = breakdowns.map(
        (b, index) => `${breakdownExpr(b.name)} as b_${index}`
      );
      breakdownGroupBy = breakdowns.map((_, index) => `b_${index}`);
    }

    const stepConditions = this.getFunnelConditions(eventSeries, projectId);

    // MV fast path — swap FROM events with a subquery over the aggregating
    // MV when the funnel is "simple" (see isMvEligibleFunnel). Same
    // windowFunnel semantics, ~90× faster on install→engagement funnels.
    const useMv = await this.isMvEligibleFunnel({
      hasAudience: Boolean(audiencePredicate),
      eventSeries,
      breakdowns,
      groupBy: group,
      anyFilterOnProfile,
      anyBreakdownOnProfile,
      projectId,
      traitDescriptors,
      startDate: startDate!,
    });

    let funnelCte: ReturnType<typeof clix> | string;
    let firstTimeCtes: { name: string; sql: string }[];
    let traitCtes: { name: string; sql: string }[];

    if (useMv) {
      const mv = this.buildFunnelCteFromMv({
        projectId,
        startDate: startDate!,
        endDate: endDate!,
        eventSeries,
        funnelWindowMilliseconds,
        additionalSelects: breakdownSelects,
        additionalGroupBy: breakdownGroupBy,
      });
      funnelCte = mv.sql;
      firstTimeCtes = mv.firstTimeCtes;
      traitCtes = mv.traitCtes;
    } else {
      const built = this.buildFunnelCte({
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
        // If we're going to attach profiles FINAL below, tell
        // buildFunnelCte so its internal windowFunnel step conditions
        // pre-qualify their event columns with `events.`.
        expectProfilesFinalJoin: anyFilterOnProfile || anyBreakdownOnProfile,
        audiencePredicate,
      });
      funnelCte = built.query;
      firstTimeCtes = built.firstTimeCtes;
      traitCtes = built.traitCtes;
    }

    if (anyFilterOnProfile || anyBreakdownOnProfile) {
      // Only reachable in the raw-events path. isMvEligibleFunnel returns
      // false when profile filters/breakdowns exist, so funnelCte is Query.
      if (useMv || typeof funnelCte === 'string') {
        throw new Error(
          'Unreachable: MV path is not chosen when profile filters/breakdowns exist',
        );
      }
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
          getTraitBreakdownDescriptor(x.name) === null
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
        'profile.id = events.profile_id'
      );
    }

    // Base funnel query with CTEs
    const funnelQuery = clix(this.client, timezone);

    // Add first-time CTEs at the top level (NOT nested inside session_funnel)
    for (const cte of firstTimeCtes) {
      funnelQuery.with(cte.name, cte.sql);
    }

    // Register trait CTEs at the top level so they are visible inside
    // session_funnel. buildFunnelCte returns them alongside firstTimeCtes
    // so callers can't forget the outer registration (see getFunnelProfiles
    // router path for the bug this defends against).
    for (const cte of traitCtes) {
      funnelQuery.with(cte.name, cte.sql);
    }

    funnelQuery.with('session_funnel', funnelCte);

    if (group === 'profile_id') {
      // Profile mode: CTE already groups by profile_id, just filter level != 0.
      funnelQuery.with(
        'funnel',
        'SELECT * FROM session_funnel WHERE level != 0'
      );
    } else {
      // Session mode: filter out level = 0
      funnelQuery.with(
        'funnel',
        'SELECT * FROM session_funnel WHERE level != 0'
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
          maxLevel
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
            }[]
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
                    .filter((count) => count > 0)
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
    let timingByBreakdown: Map<
      string,
      Record<string, number | null>
    > = new Map();
    if (stepConditions.length >= 2) {
      try {
        const allTimingEventNames = uniq(
          eventSeries.flatMap((e) =>
            e.customEventComponents
              ? e.customEventComponents.map((c) => c.eventName)
              : [e.name],
          ),
        );
        timingByBreakdown = useMv
          ? await this.getFunnelTimingStatsFromMv({
              projectId,
              startDate: startDate!,
              endDate: endDate!,
              stepConditions,
              funnelWindowSeconds,
              allEventNames: allTimingEventNames,
              timezone,
            })
          : await this.getFunnelTimingStats({
              projectId,
              startDate: startDate!,
              endDate: endDate!,
              stepConditions,
              funnelWindowSeconds,
              groupBy: group,
              allEventNames: allTimingEventNames,
              breakdowns,
              breakdownSelects,
              breakdownStep,
              eventSeries,
              timezone,
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
    timezone,
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
    timezone: string;
  }): Promise<Map<string, Record<string, number | null>>> {
    const result = new Map<string, Record<string, number | null>>();
    if (stepConditions.length < 2) {
      return result;
    }

    const entityKey = groupBy;
    const nameList = allEventNames.map((n) => sqlstring.escape(n)).join(', ');
    const identifiedFilter =
      groupBy === 'profile_id' ? 'AND profile_id != device_id' : '';

    const ctes: string[] = [];
    const hasBreakdowns = breakdowns.length > 0;

    // Mixpanel-parity attribution window: step_1 stays anchored to the
    // report range; step 2..N may land up to funnelWindowSeconds after
    // endDate. See the matching comment in getFunnelPropertySums.
    const escapedExtendedEnd = `addSeconds(toDateTime(${sqlstring.escape(endDate)}), ${funnelWindowSeconds})`;

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

    // Steps 2..N — scan extended so cross-day conversions are captured.
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
          AND e.created_at BETWEEN toDateTime(${sqlstring.escape(startDate)}) AND ${escapedExtendedEnd}
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
      const rawBdStepCondition =
        stepConditions[bdStepIdx] ?? stepConditions[0]!;

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
          `${desc.cteName} AS (SELECT profile_id, argMax(value, updated_at) AS value FROM ${TABLE_NAMES.profile_traits} WHERE project_id = ${sqlstring.escape(projectId)} AND key = ${sqlstring.escape(desc.key)} GROUP BY profile_id)`
        );
      }
      const traitJoins = Array.from(traitDescriptors.values())
        .map(
          (desc) =>
            `LEFT ANY JOIN ${desc.cteName} ON ${desc.cteName}.profile_id = e.profile_id`
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
            `argMaxIf(${breakdownExpr(b.name)}, e.created_at, ${bdStepCondition}) as b_${i}`
        );
        bdGroup = [];
      } else {
        bdExprs = breakdowns.map(
          (b, i) => `${breakdownExpr(b.name)} as b_${i}`
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
          AND e.created_at BETWEEN toDateTime(${sqlstring.escape(startDate)}) AND ${escapedExtendedEnd}
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
        `LEFT JOIN ${stepCte} ON s1.${entityKey} = ${stepCte}.${entityKey}`
      );
      medianSelects.push(
        `quantileTDigestIf(0.5)(dateDiff('second', s1.step_1_ts, ${nullableTs}), isNotNull(${nullableTs})) as step_${i}_median`
      );
    }

    // Join breakdown CTE if breakdowns exist
    let bdSelectsInFinal = '';
    let bdGroupByInFinal = '';
    if (hasBreakdowns) {
      stepJoins.push(
        `LEFT JOIN timing_bd bd ON s1.${entityKey} = bd.${entityKey}`
      );
      bdSelectsInFinal = breakdowns.map((_, i) => `bd.b_${i}`).join(', ') + ',';
      bdGroupByInFinal = `GROUP BY ${breakdowns.map((_, i) => `bd.b_${i}`).join(', ')}`;
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

    const rows = await chQuery<Record<string, any>>(sql, {
      session_timezone: timezone,
    });

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
   * MV-backed drop-in for getFunnelTimingStats. Same chained-CTE shape,
   * but sources events from `event_profile_firsts_local` via an mv_events
   * CTE that unpacks each row's (min, max) identified timestamps via
   * arrayJoin. Only callable when isMvEligibleFunnel() has already
   * accepted the funnel (guarantees: profile_id grouping, no breakdowns,
   * no traits, filters only on whitelisted top-level cols).
   *
   * The raw path frequently hits `MEMORY_LIMIT_EXCEEDED` on the JOIN
   * chain for large date ranges (see scratchpad/timing_baseline.md —
   * 11 of 132 timing queries failed in a 6h window, each eating ~29 s
   * of wall-clock before erroring). This path scans ~200 M pre-aggregated
   * rows instead of billions of raw events, so those failures go away.
   */
  private async getFunnelTimingStatsFromMv({
    projectId,
    startDate,
    endDate,
    stepConditions,
    funnelWindowSeconds,
    allEventNames,
    timezone,
  }: {
    projectId: string;
    startDate: string;
    endDate: string;
    stepConditions: string[];
    funnelWindowSeconds: number;
    allEventNames: string[];
    timezone: string;
  }): Promise<Map<string, Record<string, number | null>>> {
    const result = new Map<string, Record<string, number | null>>();
    if (stepConditions.length < 2) return result;

    const nameList = allEventNames
      .map((n) => sqlstring.escape(n))
      .join(', ');
    const escapedProject = sqlstring.escape(projectId);
    const escapedStart = sqlstring.escape(startDate);
    const escapedEnd = sqlstring.escape(endDate);

    // Rewrite step-condition column refs from `created_at` (raw column)
    // to `ts` (arrayJoin output). All other refs (name, profile_id,
    // app_version, country) pass through — they're projected verbatim
    // in the mv_events subquery.
    const toMvCondition = (cond: string) =>
      cond.replace(/\bcreated_at\b/g, 'ts');

    const ctes: string[] = [];

    // Base CTE: unpack (min, max) as ts stream — same as buildFunnelCteFromMv.
    // Reused across all step_N CTEs (CH materializes CTE once per WITH).
    ctes.push(`mv_events AS (
      SELECT project_id, name, profile_id, app_version, country,
        arrayJoin([min_created_at_identified, max_created_at_identified]) AS ts
      FROM ${TABLE_NAMES.event_profile_firsts}
      WHERE project_id = ${escapedProject}
        AND name IN (${nameList})
        AND day BETWEEN toDate(${escapedStart}) AND addDays(toDate(${escapedEnd}), 1)
        AND min_created_at_identified > toDateTime64('1970-01-02', 3)
    )`);

    // Step 1: anchored to [startDate, endDate].
    ctes.push(`step_1 AS (
      SELECT profile_id, min(ts) as step_1_ts
      FROM mv_events
      WHERE ts >= toDateTime64(${escapedStart}, 3)
        AND ts <= toDateTime64(${escapedEnd}, 3)
        AND (${toMvCondition(stepConditions[0]!)})
      GROUP BY profile_id
    )`);

    // Steps 2..N: chain forward, gated by ts > prev.step_N_ts AND
    // funnelWindow from step_1_ts.
    for (let i = 1; i < stepConditions.length; i++) {
      const prevCte = `step_${i}`;
      const currCte = `step_${i + 1}`;
      ctes.push(`${currCte} AS (
        SELECT prev.profile_id AS profile_id, min(e.ts) as ${currCte}_ts
        FROM ${prevCte} prev
        JOIN mv_events e ON e.profile_id = prev.profile_id
        JOIN step_1 s1 ON s1.profile_id = prev.profile_id
        WHERE e.ts > prev.${prevCte}_ts
          AND dateDiff('second', s1.step_1_ts, e.ts) <= ${funnelWindowSeconds}
          AND (${toMvCondition(stepConditions[i]!)})
        GROUP BY prev.profile_id
      )`);
    }

    // Final aggregation — quantileTDigestIf medians (same as raw path).
    const stepJoins: string[] = [];
    const medianSelects: string[] = [];
    for (let i = 1; i < stepConditions.length; i++) {
      const stepCte = `step_${i + 1}`;
      const tsCol = `${stepCte}.${stepCte}_ts`;
      const nullableTs = `nullIf(${tsCol}, toDateTime64(0, 3))`;
      stepJoins.push(
        `LEFT JOIN ${stepCte} ON s1.profile_id = ${stepCte}.profile_id`,
      );
      medianSelects.push(
        `quantileTDigestIf(0.5)(dateDiff('second', s1.step_1_ts, ${nullableTs}), isNotNull(${nullableTs})) as step_${i}_median`,
      );
    }

    const sql = `
      WITH ${ctes.join(',\n')}
      SELECT ${medianSelects.join(',\n')}
      FROM step_1 s1
      ${stepJoins.join('\n')}
    `;

    const rows = await chQuery<Record<string, any>>(sql, {
      session_timezone: timezone,
    });
    result.set('none', rows[0] ?? {});
    return result;
  }

  /**
   * Compute numeric property aggregates for entities that completed the
   * entire funnel. Uses chained CTEs (same pattern as getFunnelTimingStats)
   * to pin the exact last-step timestamp per entity, then extracts the
   * property value at that timestamp.
   *
   * Returns a Map keyed by breakdown identity (or 'none' if no breakdowns).
   */
  async getFunnelPropertyStats({
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
    timezone,
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
    timezone: string;
  }): Promise<Map<string, { sum: number; average: number; count: number }>> {
    const result = new Map<
      string,
      { sum: number; average: number; count: number }
    >();
    if (stepConditions.length < 1) {
      return result;
    }

    const entityKey = groupBy;
    const nameList = allEventNames.map((n) => sqlstring.escape(n)).join(', ');
    const identifiedFilter =
      groupBy === 'profile_id' ? 'AND profile_id != device_id' : '';

    const ctes: string[] = [];
    const lastStepIdx = stepConditions.length; // 1-based
    const hasBreakdowns = breakdowns.length > 0;

    // Mixpanel-parity attribution window: step_1 must fire inside the
    // report range [startDate, endDate], but step 2..N + the property
    // lookup may land up to funnelWindowSeconds AFTER endDate. The per-user
    // `dateDiff` gate further down still caps each completer to
    // step1_ts + funnelWindow, so extending the scan here only widens the
    // *candidate* set — it does not change which users count.
    const escapedExtendedEnd = `addSeconds(toDateTime(${sqlstring.escape(endDate)}), ${funnelWindowSeconds})`;

    // Step 1 CTE — stays anchored to the report window.
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

    // Steps 2..N — scan extended to endDate + funnelWindow so cross-day
    // conversions (viewed yesterday, converted today) are captured.
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
          AND e.created_at BETWEEN toDateTime(${sqlstring.escape(startDate)}) AND ${escapedExtendedEnd}
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
      const rawBdStepCondition =
        stepConditions[bdStepIdx] ?? stepConditions[0]!;

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
          `${desc.cteName} AS (SELECT profile_id, argMax(value, updated_at) AS value FROM ${TABLE_NAMES.profile_traits} WHERE project_id = ${sqlstring.escape(projectId)} AND key = ${sqlstring.escape(desc.key)} GROUP BY profile_id)`
        );
      }
      const traitJoins = Array.from(traitDescriptors.values())
        .map(
          (desc) =>
            `LEFT ANY JOIN ${desc.cteName} ON ${desc.cteName}.profile_id = e.profile_id`
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
            `argMaxIf(${breakdownExpr(b.name)}, e.created_at, ${bdStepCondition}) as b_${i}`
        );
        bdGroup = [];
      } else {
        bdExprs = breakdowns.map(
          (b, i) => `${breakdownExpr(b.name)} as b_${i}`
        );
        bdGroup = breakdowns.map((_, i) => `b_${i}`);
      }

      const propIdentifiedFilter =
        groupBy === 'profile_id' ? 'AND e.profile_id != e.device_id' : '';

      // prop_bd must scan the same extended window as step_2..N. When
      // breakdownStep > 0 the breakdown value comes from a later-step
      // event via argMaxIf; if that event is cross-day and falls outside
      // this scan, argMaxIf returns NULL and the user is silently
      // re-bucketed as "Not set" — losing the attribution that step_2..N
      // just captured.
      ctes.push(`prop_bd AS (
        SELECT e.${entityKey} AS ${entityKey}
          ${bdExprs.length > 0 ? `, ${bdExprs.join(', ')}` : ''}
        FROM ${TABLE_NAMES.events} AS e
          ${traitJoins}
        WHERE e.project_id = ${sqlstring.escape(projectId)}
          AND e.created_at BETWEEN toDateTime(${sqlstring.escape(startDate)}) AND ${escapedExtendedEnd}
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
        AND e.created_at BETWEEN toDateTime(${sqlstring.escape(startDate)}) AND ${escapedExtendedEnd}
        AND e.name IN (${nameList})
        ${groupBy === 'profile_id' ? 'AND e.profile_id != e.device_id' : ''}
      GROUP BY ls.${entityKey}
    )`);

    // Final aggregation
    const joins: string[] = [];
    let bdSelectsInFinal = '';
    let bdGroupByInFinal = '';

    if (hasBreakdowns) {
      joins.push(`LEFT JOIN prop_bd bd ON pv.${entityKey} = bd.${entityKey}`);
      bdSelectsInFinal = breakdowns.map((_, i) => `bd.b_${i}`).join(', ') + ',';
      bdGroupByInFinal = `GROUP BY ${breakdowns.map((_, i) => `bd.b_${i}`).join(', ')}`;
    }

    const sql = `
      WITH ${ctes.join(',\n')}
      SELECT
        ${bdSelectsInFinal}
        sum(pv.prop_value) as total_sum,
        avg(pv.prop_value) as property_average,
        count(pv.prop_value) as property_count
      FROM prop_vals pv
      ${joins.join('\n')}
      ${bdGroupByInFinal}
    `;

    const rows = await chQuery<Record<string, any>>(sql, {
      session_timezone: timezone,
    });

    if (breakdowns.length === 0) {
      const row = rows[0];
      result.set('none', {
        sum: typeof row?.total_sum === 'number' ? row.total_sum : 0,
        average:
          typeof row?.property_average === 'number' ? row.property_average : 0,
        count: typeof row?.property_count === 'number' ? row.property_count : 0,
      });
    } else {
      for (const row of rows) {
        const key = breakdowns
          .map((_, i) => normalizeBreakdownValue(row[`b_${i}`]))
          .join('|');
        result.set(key, {
          sum: typeof row.total_sum === 'number' ? row.total_sum : 0,
          average:
            typeof row.property_average === 'number' ? row.property_average : 0,
          count:
            typeof row.property_count === 'number' ? row.property_count : 0,
        });
      }
    }

    return result;
  }

  async getFunnelPropertySums(
    input: Parameters<FunnelService['getFunnelPropertyStats']>[0]
  ): Promise<Map<string, number>> {
    const stats = await this.getFunnelPropertyStats(input);
    return new Map(
      Array.from(stats.entries()).map(([key, value]) => [key, value.sum])
    );
  }
}

export const funnelService = new FunnelService(ch);
