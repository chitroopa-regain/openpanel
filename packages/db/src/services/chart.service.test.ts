import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  chQuery: vi.fn(),
  tables: {
    events: 'chart_test_events',
    profiles: 'chart_test_profiles',
    profileTraits: 'chart_test_profile_traits',
  },
}));

vi.mock('../clickhouse/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../clickhouse/client')>();
  return {
    ...actual,
    ch: {},
    chQuery: mocks.chQuery,
    TABLE_NAMES: {
      events: mocks.tables.events,
      profiles: mocks.tables.profiles,
      profile_traits: mocks.tables.profileTraits,
      alias: 'profile_aliases',
      self_hosting: 'self_hosting',
      events_bots: 'events_bots',
      dau_mv: 'dau_mv',
      event_names_mv: 'distinct_event_names_mv',
      event_property_values_mv: 'event_property_values_mv',
      cohort_events_mv: 'cohort_events_mv',
      sessions: 'sessions',
      events_imports: 'events_imports',
      session_replay_chunks: 'session_replay_chunks',
    },
  };
});

vi.mock('../prisma-client', () => ({
  db: {},
}));

import { getAggregateChartSql, getChartSql } from './chart.service';

const normalizeSql = (sql: string) => sql.replace(/\s+/g, ' ').trim();

// ──────────────────────────────────────────────────────────────
// Test data builders
// ──────────────────────────────────────────────────────────────

function makeAggregateInput(overrides: Record<string, any> = {}) {
  return {
    event: {
      id: 's1',
      name: overrides.eventName ?? '*',
      type: 'event',
      segment: overrides.segment ?? 'user',
      filters: overrides.filters ?? [],
      property: overrides.property,
      displayName: overrides.displayName,
      firstTimeFilter: overrides.firstTimeFilter ?? false,
    },
    breakdowns: overrides.breakdowns ?? [],
    startDate: overrides.startDate ?? '2026-04-16 00:00:00',
    endDate: overrides.endDate ?? '2026-04-16 23:59:59',
    projectId: overrides.projectId ?? 'regain-app',
    limit: overrides.limit ?? 500,
    timezone: overrides.timezone ?? 'Asia/Calcutta',
    chartType: 'pie' as const,
    customEventComponents: overrides.customEventComponents,
  };
}

function makeTimeSeriesInput(overrides: Record<string, any> = {}) {
  return {
    event: {
      id: 's1',
      name: overrides.eventName ?? '*',
      type: 'event',
      segment: overrides.segment ?? 'user',
      filters: overrides.filters ?? [],
      property: overrides.property,
      displayName: overrides.displayName,
      firstTimeFilter: overrides.firstTimeFilter ?? false,
    },
    breakdowns: overrides.breakdowns ?? [],
    startDate: overrides.startDate ?? '2026-04-16 00:00:00',
    endDate: overrides.endDate ?? '2026-04-16 23:59:59',
    interval: overrides.interval ?? 'day',
    projectId: overrides.projectId ?? 'regain-app',
    limit: overrides.limit ?? 500,
    timezone: overrides.timezone ?? 'Asia/Calcutta',
    chartType: 'linear' as const,
    customEventComponents: overrides.customEventComponents,
  };
}

// ══════════════════════════════════════════════════════════════
// AGGREGATE CHART (pie/metric) SQL generation
// ══════════════════════════════════════════════════════════════

describe('getAggregateChartSql', () => {
  beforeEach(() => {
    mocks.chQuery.mockReset();
  });

  // ── No breakdowns ──────────────────────────────────────────

  describe('no breakdowns', () => {
    it('generates SQL for a simple event count', () => {
      const sql = normalizeSql(
        getAggregateChartSql(
          makeAggregateInput({ eventName: 'Server: Purchase', segment: 'event' })
        )
      );
      expect(sql).toContain("name = 'Server: Purchase'");
      expect(sql).toContain('count(*) as count');
      expect(sql).not.toContain('label_1');
      expect(sql).not.toContain('LEFT ANY JOIN');
    });

    it('generates SQL for unique users segment', () => {
      const sql = normalizeSql(
        getAggregateChartSql(makeAggregateInput({ eventName: 'Home Page: Shown' }))
      );
      expect(sql).toContain('countDistinct(profile_id) as count');
    });

    it('generates SQL for wildcard event (*)', () => {
      const sql = normalizeSql(
        getAggregateChartSql(makeAggregateInput({ eventName: '*' }))
      );
      expect(sql).toContain("'*' as label_0");
      expect(sql).not.toContain("name =");
    });
  });

  // ── Segment types ──────────────────────────────────────────

  describe('segment types', () => {
    it('session segment uses countDistinct(session_id)', () => {
      const sql = normalizeSql(
        getAggregateChartSql(makeAggregateInput({ segment: 'session', eventName: 'FT: Overlay Shown' }))
      );
      expect(sql).toContain('countDistinct(session_id) as count');
    });

    it('user_average segment uses COUNT/COUNT(DISTINCT)', () => {
      const sql = normalizeSql(
        getAggregateChartSql(makeAggregateInput({ segment: 'user_average', eventName: 'Home Page: Shown' }))
      );
      expect(sql).toContain('COUNT(*)');
      expect(sql).toContain('COUNT(DISTINCT profile_id)');
    });

    it('property_sum segment sums the specified property', () => {
      const sql = normalizeSql(
        getAggregateChartSql(
          makeAggregateInput({
            segment: 'property_sum',
            eventName: 'Server: Purchase',
            property: 'properties.value_inr',
          })
        )
      );
      expect(sql).toContain("toFloat64OrNull(properties['value_inr'])");
      expect(sql).toContain('sum(');
    });

    it('property_average segment averages the specified property', () => {
      const sql = normalizeSql(
        getAggregateChartSql(
          makeAggregateInput({
            segment: 'property_average',
            eventName: 'Server: Purchase',
            property: 'properties.value_inr',
          })
        )
      );
      expect(sql).toContain('avg(');
    });

    it('one_event_per_user segment uses DISTINCT ON', () => {
      const sql = normalizeSql(
        getAggregateChartSql(
          makeAggregateInput({ segment: 'one_event_per_user', eventName: 'Home Page: Shown' })
        )
      );
      expect(sql).toContain('DISTINCT ON (e.profile_id)');
      expect(sql).toContain('ORDER BY e.profile_id');
    });

    it('frequency_distribution generates user_counts + freq_stats CTEs', () => {
      const sql = normalizeSql(
        getAggregateChartSql(
          makeAggregateInput({
            segment: 'frequency_distribution',
            eventName: 'Subscription: Paywall Viewed',
          })
        )
      );
      expect(sql).toContain('user_counts AS');
      expect(sql).toContain('freq_stats AS');
      expect(sql).toContain('event_count');
      expect(sql).toContain('GROUP BY profile_id');
    });
  });

  // ── Event property breakdowns ──────────────────────────────

  describe('event property breakdowns', () => {
    it('breaks down by event property without top_breakdowns CTE', () => {
      const sql = normalizeSql(
        getAggregateChartSql(
          makeAggregateInput({
            eventName: 'Server: Purchase',
            breakdowns: [{ name: 'properties.paywall_variant' }],
          })
        )
      );
      expect(sql).toContain("properties['paywall_variant'] as label_1");
      expect(sql).toContain('GROUP BY label_1');
      expect(sql).not.toContain('top_breakdowns');
      expect(sql).not.toContain('IN (SELECT *');
    });

    it('handles multiple event property breakdowns', () => {
      const sql = normalizeSql(
        getAggregateChartSql(
          makeAggregateInput({
            eventName: 'Subscription: Paywall Viewed',
            breakdowns: [
              { name: 'properties.paywallVariant' },
              { name: 'properties.offerType' },
            ],
          })
        )
      );
      expect(sql).toContain("properties['paywallVariant'] as label_1");
      expect(sql).toContain("properties['offerType'] as label_2");
      expect(sql).toContain('GROUP BY label_1');
      expect(sql).toContain('label_2');
    });

    it('handles has_profile breakdown', () => {
      const sql = normalizeSql(
        getAggregateChartSql(
          makeAggregateInput({
            eventName: 'Home Page: Shown',
            breakdowns: [{ name: 'has_profile' }],
          })
        )
      );
      expect(sql).toContain("if(profile_id != device_id, 'true', 'false') as label_1");
    });
  });

  // ── Profile trait breakdowns ───────────────────────────────

  describe('profile trait breakdowns', () => {
    it('creates trait CTE with LEFT ANY JOIN instead of correlated subquery', () => {
      const sql = normalizeSql(
        getAggregateChartSql(
          makeAggregateInput({
            breakdowns: [{ name: 'profile.properties.show_monthly_back_press_offer' }],
          })
        )
      );
      expect(sql).toContain('trait_show_monthly_back_press_offer AS');
      expect(sql).toContain(`FROM ${mocks.tables.profileTraits}`);
      expect(sql).toContain("key = 'show_monthly_back_press_offer'");
      expect(sql).toContain(
        'LEFT ANY JOIN trait_show_monthly_back_press_offer ON trait_show_monthly_back_press_offer.profile_id = e.profile_id'
      );
      expect(sql).toContain('trait_show_monthly_back_press_offer.value as label_1');
      // Must NOT contain the old correlated subquery
      expect(sql).not.toContain('t.profile_id = profile_id');
      expect(sql).not.toContain('SELECT argMax(t.value, t.updated_at)');
      expect(sql).not.toContain('top_breakdowns');
    });

    it('qualifies profile_id as e.profile_id when trait CTEs are joined', () => {
      const sql = normalizeSql(
        getAggregateChartSql(
          makeAggregateInput({
            segment: 'user',
            breakdowns: [{ name: 'profile.properties.show_monthly_back_press_offer' }],
          })
        )
      );
      expect(sql).toContain('countDistinct(e.profile_id) as count');
      expect(sql).not.toMatch(/countDistinct\(profile_id\)/);
    });

    it('does not qualify profile_id when no trait breakdowns', () => {
      const sql = normalizeSql(
        getAggregateChartSql(
          makeAggregateInput({
            segment: 'user',
            breakdowns: [{ name: 'properties.paywall_variant' }],
          })
        )
      );
      expect(sql).toContain('countDistinct(profile_id) as count');
    });

    it('treats profile.properties.country as a trait (DEVICE_GEO_KEYS is empty)', () => {
      const sql = normalizeSql(
        getAggregateChartSql(
          makeAggregateInput({
            breakdowns: [{ name: 'profile.properties.country' }],
          })
        )
      );
      expect(sql).toContain('trait_country AS');
      expect(sql).toContain("key = 'country'");
      expect(sql).toContain('trait_country.value as label_1');
    });
  });

  // ── Event filters ──────────────────────────────────────────

  describe('event filters', () => {
    it('handles "is" filter on event property', () => {
      const sql = normalizeSql(
        getAggregateChartSql(
          makeAggregateInput({
            eventName: 'Subscription: Paywall Viewed',
            filters: [{ id: 'f1', name: 'properties.paywallVariant', value: ['CHOOSE_A_PLAN'], operator: 'is' }],
          })
        )
      );
      expect(sql).toContain("properties['paywallVariant'] = 'CHOOSE_A_PLAN'");
    });

    it('handles "isNot" filter on event property', () => {
      const sql = normalizeSql(
        getAggregateChartSql(
          makeAggregateInput({
            eventName: 'Server: Purchase',
            filters: [{ id: 'f1', name: 'properties.paywall_variant', value: ['None'], operator: 'isNot' }],
          })
        )
      );
      expect(sql).toContain("properties['paywall_variant'] != 'None'");
    });

    it('handles "is" filter with multiple values (IN list)', () => {
      const sql = normalizeSql(
        getAggregateChartSql(
          makeAggregateInput({
            eventName: 'Subscription: Purchase Initiated',
            filters: [{ id: 'f1', name: 'properties.offerType', value: ['ANNUAL', 'MONTHLY'], operator: 'is' }],
          })
        )
      );
      expect(sql).toContain("properties['offerType'] IN ('ANNUAL', 'MONTHLY')");
    });

    it('handles "isNotNull" filter', () => {
      const sql = normalizeSql(
        getAggregateChartSql(
          makeAggregateInput({
            eventName: 'Server: Purchase',
            filters: [{ id: 'f1', name: 'properties.paywall_variant', value: [], operator: 'isNotNull' }],
          })
        )
      );
      expect(sql).toContain("properties['paywall_variant'] != ''");
    });

    it('handles "is" filter on top-level event column (app_version)', () => {
      const sql = normalizeSql(
        getAggregateChartSql(
          makeAggregateInput({
            filters: [{ id: 'f1', name: 'app_version', value: ['54.3.1571'], operator: 'is' }],
          })
        )
      );
      expect(sql).toContain("app_version = '54.3.1571'");
    });

    it('handles "contains" filter', () => {
      const sql = normalizeSql(
        getAggregateChartSql(
          makeAggregateInput({
            eventName: 'Home Page: Shown',
            filters: [{ id: 'f1', name: 'properties.source', value: ['organic'], operator: 'contains' }],
          })
        )
      );
      expect(sql).toContain("LIKE '%organic%'");
    });

    it('handles has_profile filter (true)', () => {
      const sql = normalizeSql(
        getAggregateChartSql(
          makeAggregateInput({
            filters: [{ id: 'f1', name: 'has_profile', value: ['true'], operator: 'is' }],
          })
        )
      );
      expect(sql).toContain('profile_id != device_id');
    });
  });

  // ── Profile trait filters ──────────────────────────────────

  describe('profile trait filters', () => {
    it('generates IN-subquery for trait "is" filter', () => {
      const sql = normalizeSql(
        getAggregateChartSql(
          makeAggregateInput({
            filters: [{ id: 'f1', name: 'profile.properties.is_pro_user', value: ['false'], operator: 'is' }],
          })
        )
      );
      expect(sql).toContain(
        `profile_id IN (SELECT profile_id FROM ${mocks.tables.profileTraits} WHERE project_id = 'regain-app' AND key = 'is_pro_user'`
      );
      expect(sql).toContain("HAVING argMax(value, updated_at) = 'false'");
    });

    it('generates NOT IN-subquery for trait "isNot" filter', () => {
      const sql = normalizeSql(
        getAggregateChartSql(
          makeAggregateInput({
            filters: [{ id: 'f1', name: 'profile.properties.is_internal_testing', value: ['true'], operator: 'isNot' }],
          })
        )
      );
      expect(sql).toContain(
        `profile_id NOT IN (SELECT profile_id FROM ${mocks.tables.profileTraits}`
      );
    });

    it('qualifies profile_id in trait filter when trait breakdown is also present', () => {
      const sql = normalizeSql(
        getAggregateChartSql(
          makeAggregateInput({
            breakdowns: [{ name: 'profile.properties.show_monthly_back_press_offer' }],
            filters: [{ id: 'f1', name: 'profile.properties.is_internal_testing', value: ['false'], operator: 'is' }],
          })
        )
      );
      // Outer profile_id must be qualified
      expect(sql).toContain(`e.profile_id IN (SELECT profile_id FROM ${mocks.tables.profileTraits}`);
      // Inner profile_id in subquery must NOT be qualified
      expect(sql).not.toContain(`SELECT e.profile_id FROM ${mocks.tables.profileTraits}`);
    });

    it('handles combined event filter + trait filter', () => {
      const sql = normalizeSql(
        getAggregateChartSql(
          makeAggregateInput({
            filters: [
              { id: 'f1', name: 'app_version', value: ['54.3.1571'], operator: 'is' },
              { id: 'f2', name: 'profile.properties.setup_completed', value: ['true'], operator: 'is' },
            ],
          })
        )
      );
      expect(sql).toContain("app_version = '54.3.1571'");
      expect(sql).toContain(`profile_id IN (SELECT profile_id FROM ${mocks.tables.profileTraits}`);
      expect(sql).toContain("key = 'setup_completed'");
    });
  });

  // ── Custom events ──────────────────────────────────────────

  describe('custom events', () => {
    it('uses custom event where clause and display name', () => {
      const sql = normalizeSql(
        getAggregateChartSql(
          makeAggregateInput({
            eventName: 'custom_all_purchases',
            displayName: 'All Purchases',
            customEventComponents: [
              { eventName: 'Server: Purchase', filters: [] },
              {
                eventName: 'Subscription: Purchase Success',
                filters: [{ id: 'f1', name: 'properties.source', value: ['razorpay'], operator: 'is' }],
              },
            ],
          })
        )
      );
      expect(sql).toContain("'All Purchases' as label_0");
      expect(sql).toContain("name = 'Server: Purchase'");
      expect(sql).toContain("name = 'Subscription: Purchase Success'");
      expect(sql).toContain("properties['source'] = 'razorpay'");
    });
  });

  // ── First-time-ever filter ─────────────────────────────────

  describe('first-time-ever filter', () => {
    it('adds first-time subquery when firstTimeFilter is true', () => {
      const sql = normalizeSql(
        getAggregateChartSql(
          makeAggregateInput({
            eventName: 'Home Page: Shown',
            firstTimeFilter: true,
          })
        )
      );
      expect(sql).toContain('profile_id IN (');
      expect(sql).toContain("name = 'Home Page: Shown'");
      expect(sql).toContain('GROUP BY profile_id HAVING min(created_at)');
    });

    it('does not add first-time subquery for wildcard event', () => {
      const sql = normalizeSql(
        getAggregateChartSql(
          makeAggregateInput({
            eventName: '*',
            firstTimeFilter: true,
          })
        )
      );
      // firstTimeFilter is ignored for wildcard events
      expect(sql).not.toContain('HAVING min(created_at)');
    });

    it('uses custom event predicate in first-time subquery', () => {
      const sql = normalizeSql(
        getAggregateChartSql(
          makeAggregateInput({
            eventName: 'custom_signup',
            displayName: 'Signup Flow',
            firstTimeFilter: true,
            customEventComponents: [
              { eventName: 'New User Identify', filters: [] },
            ],
          })
        )
      );
      expect(sql).toContain("name = 'New User Identify'");
      expect(sql).toContain('HAVING min(created_at)');
    });
  });

  // ── Production pie chart configs ───────────────────────────

  describe('production pie chart configurations', () => {
    it('Paywall Viewed frequency distribution with trait filters', () => {
      const sql = normalizeSql(
        getAggregateChartSql(
          makeAggregateInput({
            eventName: 'Subscription: Paywall Viewed',
            segment: 'frequency_distribution',
            filters: [
              { id: 'f1', name: 'profile.properties.is_pro_user', value: ['false'], operator: 'is' },
              { id: 'f2', name: 'profile.properties.setup_completed', value: ['true'], operator: 'is' },
            ],
          })
        )
      );
      expect(sql).toContain('user_counts AS');
      expect(sql).toContain("key = 'is_pro_user'");
      expect(sql).toContain("key = 'setup_completed'");
    });

    it('Distribution Monthly Back Press — wildcard event + trait breakdown + mixed filters', () => {
      const sql = normalizeSql(
        getAggregateChartSql(
          makeAggregateInput({
            eventName: '*',
            segment: 'user',
            breakdowns: [{ name: 'profile.properties.show_monthly_back_press_offer' }],
            filters: [
              { id: 'f1', name: 'app_version', value: ['54.3.1571'], operator: 'is' },
              { id: 'f2', name: 'profile.properties.country', value: ['IN'], operator: 'is' },
            ],
          })
        )
      );
      expect(sql).toContain('trait_show_monthly_back_press_offer AS');
      expect(sql).toContain('countDistinct(e.profile_id) as count');
      expect(sql).toContain("app_version = '54.3.1571'");
      expect(sql).toContain("key = 'country'");
      expect(sql).not.toContain('top_breakdowns');
    });

    it('Purchase by paywall_variant — event property breakdown + isNot filter', () => {
      const sql = normalizeSql(
        getAggregateChartSql(
          makeAggregateInput({
            eventName: 'Server: Purchase',
            segment: 'event',
            breakdowns: [{ name: 'properties.paywall_variant' }],
            filters: [{ id: 'f1', name: 'properties.paywall_variant', value: ['None'], operator: 'isNot' }],
          })
        )
      );
      expect(sql).toContain("properties['paywall_variant'] as label_1");
      expect(sql).toContain("properties['paywall_variant'] != 'None'");
      expect(sql).not.toContain('top_breakdowns');
    });
  });

  // ── Edge cases ─────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles empty filter value array gracefully', () => {
      const sql = normalizeSql(
        getAggregateChartSql(
          makeAggregateInput({
            eventName: 'Home Page: Shown',
            filters: [{ id: 'f1', name: 'properties.source', value: [], operator: 'is' }],
          })
        )
      );
      // Empty value array should be skipped
      expect(sql).not.toContain("properties['source']");
    });

    it('handles limit of 0 (no limit)', () => {
      const sql = normalizeSql(
        getAggregateChartSql(makeAggregateInput({ limit: 0 }))
      );
      expect(sql).not.toContain('LIMIT');
    });

    it('never generates top_breakdowns CTE for any breakdown type', () => {
      // Event property
      const sql1 = normalizeSql(
        getAggregateChartSql(
          makeAggregateInput({
            breakdowns: [{ name: 'properties.paywallVariant' }],
          })
        )
      );
      // Trait property
      const sql2 = normalizeSql(
        getAggregateChartSql(
          makeAggregateInput({
            breakdowns: [{ name: 'profile.properties.is_pro_user' }],
          })
        )
      );
      expect(sql1).not.toContain('top_breakdowns');
      expect(sql2).not.toContain('top_breakdowns');
    });

    it('sanitizes trait key with special characters for CTE name', () => {
      const sql = normalizeSql(
        getAggregateChartSql(
          makeAggregateInput({
            breakdowns: [{ name: 'profile.properties.user-tier.v2' }],
          })
        )
      );
      // Hyphens and dots should be replaced with underscores
      expect(sql).toContain('trait_user_tier AS');
    });
  });
});

// ══════════════════════════════════════════════════════════════
// TIME-SERIES CHART SQL generation
// ══════════════════════════════════════════════════════════════

describe('getChartSql', () => {
  beforeEach(() => {
    mocks.chQuery.mockReset();
  });

  // ── No breakdowns ──────────────────────────────────────────

  describe('no breakdowns', () => {
    it('generates basic time-series SQL', () => {
      const sql = normalizeSql(
        getChartSql(makeTimeSeriesInput({ eventName: 'Home Page: Shown' }))
      );
      expect(sql).toContain('toStartOfDay(created_at) as date');
      expect(sql).toContain('GROUP BY date');
      expect(sql).toContain('ORDER BY date ASC');
      expect(sql).toContain('WITH FILL');
    });

    it('generates total_count subquery without breakdowns', () => {
      const sql = normalizeSql(
        getChartSql(makeTimeSeriesInput({ segment: 'user' }))
      );
      expect(sql).toContain('as total_count');
      expect(sql).toContain(`FROM ${mocks.tables.events} e2`);
    });
  });

  // ── Event property breakdowns ──────────────────────────────

  describe('event property breakdowns', () => {
    it('does not use top_breakdowns CTE but applies LIMIT', () => {
      const sql = normalizeSql(
        getChartSql(
          makeTimeSeriesInput({
            eventName: 'Subscription: Paywall Viewed',
            breakdowns: [{ name: 'properties.paywallVariant' }],
            limit: 500,
          })
        )
      );
      expect(sql).toContain("properties['paywallVariant'] as label_1");
      expect(sql).not.toContain('top_breakdowns');
      expect(sql).not.toContain('IN (SELECT *');
      // Must enforce LIMIT to prevent unbounded results for high-cardinality breakdowns
      expect(sql).toContain('LIMIT 500');
    });
  });

  // ── Trait breakdowns ───────────────────────────────────────

  describe('trait breakdowns', () => {
    it('creates trait CTE with JOIN', () => {
      const sql = normalizeSql(
        getChartSql(
          makeTimeSeriesInput({
            breakdowns: [{ name: 'profile.properties.show_monthly_back_press_offer' }],
          })
        )
      );
      expect(sql).toContain('trait_show_monthly_back_press_offer AS');
      expect(sql).toContain('trait_show_monthly_back_press_offer.value as label_1');
      expect(sql).not.toContain('t.profile_id = profile_id');
    });

    it('qualifies profile_id in main count and total_count subquery', () => {
      const sql = normalizeSql(
        getChartSql(
          makeTimeSeriesInput({
            segment: 'user',
            breakdowns: [{ name: 'profile.properties.show_monthly_back_press_offer' }],
          })
        )
      );
      expect(sql).toContain('countDistinct(e.profile_id) as count');
      expect(sql).toContain('uniq(e2.profile_id)');
      expect(sql).toContain(
        'trait_show_monthly_back_press_offer.profile_id = e2.profile_id'
      );
    });

    it('rewrites trait join for e2 alias in total_count subquery', () => {
      const sql = normalizeSql(
        getChartSql(
          makeTimeSeriesInput({
            segment: 'user',
            breakdowns: [{ name: 'profile.properties.country' }],
          })
        )
      );
      expect(sql).toContain('trait_country.profile_id = e.profile_id');
      expect(sql).toContain('trait_country.profile_id = e2.profile_id');
    });
  });

  // ── Combined trait filter + breakdown ──────────────────────

  describe('combined trait filter and breakdown', () => {
    it('qualifies outer profile_id in filter without breaking inner subquery', () => {
      const sql = normalizeSql(
        getChartSql(
          makeTimeSeriesInput({
            breakdowns: [{ name: 'profile.properties.show_monthly_back_press_offer' }],
            filters: [{ id: 'f1', name: 'profile.properties.is_internal_testing', value: ['false'], operator: 'is' }],
          })
        )
      );
      expect(sql).toContain(`e.profile_id IN (SELECT profile_id FROM ${mocks.tables.profileTraits}`);
      expect(sql).toContain('trait_show_monthly_back_press_offer AS');
    });
  });

  // ── First-time-ever filter ─────────────────────────────────

  describe('first-time-ever filter', () => {
    it('adds first-time subquery for named event', () => {
      const sql = normalizeSql(
        getChartSql(
          makeTimeSeriesInput({
            eventName: 'New User Identify',
            firstTimeFilter: true,
          })
        )
      );
      expect(sql).toContain("name = 'New User Identify'");
      expect(sql).toContain('HAVING min(created_at)');
    });
  });

  // ── Interval types ─────────────────────────────────────────

  describe('interval types', () => {
    it('generates minute interval', () => {
      const sql = normalizeSql(
        getChartSql(makeTimeSeriesInput({ interval: 'minute' }))
      );
      expect(sql).toContain('toStartOfMinute(created_at)');
      expect(sql).toContain('toIntervalMinute(1)');
    });

    it('generates hour interval', () => {
      const sql = normalizeSql(
        getChartSql(makeTimeSeriesInput({ interval: 'hour' }))
      );
      expect(sql).toContain('toStartOfHour(created_at)');
    });

    it('generates week interval', () => {
      const sql = normalizeSql(
        getChartSql(makeTimeSeriesInput({ interval: 'week' }))
      );
      expect(sql).toContain('toStartOfWeek(created_at');
    });

    it('generates month interval', () => {
      const sql = normalizeSql(
        getChartSql(makeTimeSeriesInput({ interval: 'month' }))
      );
      expect(sql).toContain('toStartOfMonth(created_at');
    });
  });

  // ── Custom events ──────────────────────────────────────────

  describe('custom events', () => {
    it('uses custom event where clause with OR composition', () => {
      const sql = normalizeSql(
        getChartSql(
          makeTimeSeriesInput({
            eventName: 'custom_all_purchases',
            displayName: 'All Purchases',
            customEventComponents: [
              { eventName: 'Server: Purchase', filters: [] },
              { eventName: 'Subscription: Purchase Success', filters: [] },
            ],
          })
        )
      );
      expect(sql).toContain("'All Purchases' as label_0");
      expect(sql).toContain("name = 'Server: Purchase'");
      expect(sql).toContain("name = 'Subscription: Purchase Success'");
    });
  });
});
