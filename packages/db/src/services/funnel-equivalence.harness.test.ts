/**
 * Funnel equivalence harness — SQL generator half.
 *
 * Runs only when EQ_REPORTS points at a JSON export of saved reports (see
 * packages/db/scripts/equivalence/README.md). For every funnel / funnel_metric
 * report it drives the REAL FunnelService twice — once with the MV path
 * disabled, once enabled — against a recording ClickHouse client, and writes
 * both SQL variants to EQ_OUT. `funnel-equivalence-run.py` then executes the
 * pairs against production ClickHouse and diffs the results.
 *
 * Why generate through the service rather than hand-write SQL: the point is
 * to prove the code path users hit, not an approximation of it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  clientQueries: [] as string[],
  chQueries: [] as string[],
  customEvents: new Map<string, any>(),
  today: new Date().toISOString().slice(0, 10),
  client: null as any,
}));

vi.mock('../clickhouse/client', () => {
  const fakeClient = {
    query: async ({ query }: { query: string }) => {
      state.clientQueries.push(query);
      return { json: async () => ({ data: [], meta: [] }) };
    },
  };
  state.client = fakeClient;
  const chQuery = async (q: string) => {
    state.chQueries.push(q);
    if (q.includes('min(day)')) {
      return [
        { project_id: 'regain-app', min_day: '2026-03-05' },
        { project_id: 'brainrot-app', min_day: '2026-04-01' },
      ];
    }
    if (q.includes('staleness_hours')) {
      return [
        { project_id: 'regain-app', max_day: state.today, staleness_hours: 0 },
        { project_id: 'brainrot-app', max_day: state.today, staleness_hours: 0 },
      ];
    }
    return [];
  };
  return {
    ch: fakeClient,
    chQuery,
    chQueryWithMeta: async (q: string) => ({ data: await chQuery(q), meta: [] }),
    formatClickhouseDate: (date: Date | string, skipTime = false) =>
      skipTime
        ? new Date(date).toISOString().split('T')[0]
        : new Date(date).toISOString().replace('T', ' ').slice(0, 19),
    TABLE_NAMES: {
      events: 'events',
      profiles: 'profiles',
      profile_traits: 'profile_traits',
      alias: 'profile_aliases',
      self_hosting: 'self_hosting',
      events_bots: 'events_bots',
      dau_mv: 'dau_mv',
      event_names_mv: 'distinct_event_names_mv',
      event_property_values_mv: 'event_property_values_mv',
      cohort_events_mv: 'cohort_events_mv',
      event_profile_firsts: 'event_profile_firsts_local',
    event_profile_ts: 'event_profile_ts_local',
      sessions: 'sessions',
      events_imports: 'events_imports',
      session_replay_chunks: 'session_replay_chunks',
    },
  };
});

vi.mock('../prisma-client', () => ({
  db: {
    customEvent: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        state.customEvents.get(where.id) ?? null,
    },
  },
}));

import { uniq } from 'ramda';
import { getChartStartEndDate } from './chart.service';
import { FunnelService, resolveSeriesForFunnel } from './funnel.service';

const REPORTS = process.env.EQ_REPORTS;
const OUT = process.env.EQ_OUT ?? '/tmp/funnel_equivalence_sql.json';
const TZ = process.env.EQ_TIMEZONE ?? 'Asia/Calcutta';
// Optional frozen window (e.g. "2026-08-01 00:00:00" / "2026-08-31 23:59:59").
// Relative ranges ("30d", "today") move between the raw and MV runs and
// between harness runs, so a one-user drift is indistinguishable from live
// ingestion. Freezing makes any residual diff a real semantic difference.
const FREEZE_START = process.env.EQ_FREEZE_START;
const FREEZE_END = process.env.EQ_FREEZE_END;

type Captured = {
  funnel?: string;
  timing?: string;
  props?: string;
  window?: { startDate?: string | null; endDate?: string | null };
};

async function capture(report: any, mvDisabled: boolean): Promise<Captured> {
  state.clientQueries.length = 0;
  state.chQueries.length = 0;
  if (mvDisabled) {
    process.env.OP_FUNNEL_MV_DISABLED = '1';
  } else {
    delete process.env.OP_FUNNEL_MV_DISABLED;
  }
  const service = new FunnelService(state.client);
  const period =
    FREEZE_START && FREEZE_END
      ? { startDate: FREEZE_START, endDate: FREEZE_END }
      : getChartStartEndDate(
          {
            range: report.range,
            startDate: null,
            endDate: null,
            dateConfig: report.dateConfig ?? undefined,
          },
          TZ,
        );
  const input = {
    ...report,
    startDate: period.startDate,
    endDate: period.endDate,
    timezone: TZ,
    membershipAsOf: period.endDate,
    extraCohortPredicate: null,
  };
  await service.getFunnel(input);

  const funnelOptions =
    report.options?.type === 'funnel' ? report.options : undefined;
  const funnelMeasure = funnelOptions?.funnelMeasure ?? 'conversion_rate';
  const funnelProperty = funnelOptions?.funnelProperty;
  const needsPropertyStats =
    !!funnelProperty &&
    (report.chartType === 'funnel_metric' ||
      funnelMeasure === 'property_sum' ||
      funnelMeasure === 'property_average');
  if (needsPropertyStats) {
    const eventSeries = await resolveSeriesForFunnel(
      report.series,
      report.projectId,
    );
    const allEventNames = uniq(
      eventSeries.flatMap((e: any) =>
        e.customEventComponents
          ? e.customEventComponents.map((c: any) => c.eventName)
          : [e.name],
      ),
    );
    const stepConditions = service.getFunnelConditions(
      eventSeries,
      report.projectId,
    );
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
    const unit = funnelOptions?.funnelWindowUnit ?? 'hour';
    const funnelWindow =
      funnelOptions?.funnelWindow ?? defaultWindowByUnit[unit] ?? 24;
    await service.getFunnelPropertyStats({
      projectId: report.projectId,
      startDate: period.startDate!,
      endDate: period.endDate!,
      stepConditions,
      funnelWindowSeconds: funnelWindow * (unitMultipliers[unit] ?? 3600),
      groupBy: service.getFunnelGroup(funnelOptions?.funnelGroup),
      allEventNames,
      propertyKey: funnelProperty,
      breakdowns: report.breakdowns,
      breakdownStep: funnelOptions?.breakdownStep,
      timezone: TZ,
      cohortPredicate: null,
      eventSeries,
    });
  }

  const out: Captured = { window: period };
  out.funnel = state.clientQueries.find((q) => q.includes('windowFunnel'));
  out.timing = state.chQueries.find(
    (q) => q.includes('step_1_ts') && !q.includes('prop_vals'),
  );
  out.props = state.chQueries.find((q) => q.includes('prop_vals'));
  return out;
}

describe.skipIf(!REPORTS)('funnel equivalence harness (SQL generation)', () => {
  it('writes raw/MV SQL pairs for every funnel report', async () => {
    const exported = JSON.parse(readFileSync(REPORTS!, 'utf8'));
    for (const ce of exported.customEvents ?? []) {
      state.customEvents.set(ce.id, ce);
    }
    const pairs: any[] = [];
    const failures: string[] = [];
    for (const report of exported.reports ?? []) {
      try {
        const raw = await capture(report, true);
        const mv = await capture(report, false);
        pairs.push({
          id: report.id,
          name: report.name,
          chartType: report.chartType,
          projectId: report.projectId,
          dashboardId: report.dashboardId,
          range: report.range,
          window: mv.window,
          timezone: TZ,
          mvEligible: Boolean(mv.funnel) && raw.funnel !== mv.funnel,
          raw,
          mv,
        });
      } catch (error) {
        failures.push(`${report.name}: ${(error as Error).message}`);
      }
    }
    writeFileSync(OUT, JSON.stringify(pairs, null, 1));
    // eslint-disable-next-line no-console
    console.log(
      `wrote ${pairs.length} pairs to ${OUT}; MV-eligible: ${pairs.filter((p) => p.mvEligible).length}; failures: ${failures.length}`,
    );
    for (const f of failures) console.log('  skip:', f);
    expect(pairs.length).toBeGreaterThan(0);
  });
});
