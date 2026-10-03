import { describe, expect, it } from 'vitest';
import {
  attachAcquisitionCost,
  buildExternalInstallsQuery,
  buildSpendFilter,
  buildSpendQuery,
  cohortIntervalKey,
  cohortSizesByInterval,
  findAttributionBreakdown,
  findTrackingStart,
  NEVER_ATTRIBUTABLE,
  type SpendRow,
  sourceValueToPlatform,
  spendForCohortOs,
  spendPendingToday,
  totalPaidSpend,
} from './chart-acquisition-cost';

const spend: SpendRow[] = [
  {
    day: '2026-09-29',
    platform: 'google_ads',
    campaign_id: 'g1',
    campaign_name: 'Google Scale',
    spend_inr: 150_000,
    os: 'android',
  },
  {
    day: '2026-09-29',
    platform: 'meta_ads',
    campaign_id: 'm1',
    campaign_name: 'Meta CBO 06',
    spend_inr: 100_000,
    os: 'android',
  },
  {
    day: '2026-09-29',
    platform: 'meta_ads',
    campaign_id: 'm2',
    campaign_name: 'Meta ABO',
    spend_inr: 30_000,
    os: 'android',
  },
  {
    day: '2026-09-29',
    platform: 'apple_ads',
    campaign_id: 'a1',
    campaign_name: 'iOS',
    spend_inr: 2000,
    os: 'ios',
  },
  // Not a known spend platform: never part of CPI.
  {
    day: '2026-09-29',
    platform: 'unknown_network',
    campaign_id: 'ugc',
    campaign_name: 'UGC',
    spend_inr: 9999,
    os: 'android',
  },
  {
    day: '2026-09-30',
    platform: 'google_ads',
    campaign_id: 'g1',
    campaign_name: 'Google Scale',
    spend_inr: 100_000,
    os: 'android',
  },
];

const avg = (sum: number, breakdowns: string[] = []) => ({
  cohort_interval: 'Weighted Average',
  sum,
  breakdowns,
});

describe('acquisition cost', () => {
  it('blended: each day carries all paid spend over all installs', () => {
    const { rows, attributedSpend } = attachAcquisitionCost(
      [
        avg(3000),
        { cohort_interval: '2026-09-29', sum: 2000, breakdowns: [] },
        { cohort_interval: '2026-09-30', sum: 1000, breakdowns: [] },
      ],
      spend,
      { interval: 'day', attribution: null }
    );
    expect(rows[1]).toMatchObject({ spend: 282_000, cpi: 141 });
    expect(rows[2]).toMatchObject({ spend: 100_000, cpi: 100 });
    // Summary row = the days added up, CPI over the total cohort.
    expect(rows[0]).toMatchObject({ spend: 382_000, cpi: 127.33 });
    expect(attributedSpend).toBe(382_000);
    expect(totalPaidSpend(spend)).toBe(382_000);
  });

  it('source breakdown: maps values to platforms, splits shared platforms, leaves organic blank', () => {
    const attribution = findAttributionBreakdown(['properties.install_source']);
    expect(attribution).toEqual({
      index: 0,
      kind: 'source',
      key: 'install_source',
    });
    const { rows } = attachAcquisitionCost(
      [
        {
          cohort_interval: '2026-09-29',
          sum: 1500,
          breakdowns: ['google_ads'],
        },
        { cohort_interval: '2026-09-29', sum: 300, breakdowns: ['instagram'] },
        { cohort_interval: '2026-09-29', sum: 100, breakdowns: ['facebook'] },
        { cohort_interval: '2026-09-29', sum: 2000, breakdowns: ['organic'] },
        avg(2000, ['organic']),
      ],
      spend,
      { interval: 'day', attribution }
    );
    expect(rows[0]).toMatchObject({ spend: 150_000, cpi: 100 });
    // Meta = 130000 shared 3:1 between instagram and facebook → same CPI.
    expect(rows[1]).toMatchObject({ spend: 97_500, cpi: 325 });
    expect(rows[2]).toMatchObject({ spend: 32_500, cpi: 325 });
    expect(rows[3]).toMatchObject({ spend: null, cpi: null });
    expect(rows[4]).toMatchObject({ spend: null, cpi: null });
  });

  it('accepts utm_source / profile trait spellings', () => {
    expect(sourceValueToPlatform('google-ads')).toBe('google_ads');
    expect(sourceValueToPlatform('apps.instagram.com')).toBe('meta_ads');
    expect(sourceValueToPlatform('google-play')).toBeNull();
    expect(
      findAttributionBreakdown([
        'country',
        'profile.properties.install_referrer_utm_source',
      ])
    ).toEqual({ index: 1, kind: 'source', key: 'install_referrer_utm_source' });
  });

  it('campaign breakdown wins over source and matches by id', () => {
    const attribution = findAttributionBreakdown([
      'properties.install_source',
      'properties.fb_campaign_group_id',
    ]);
    expect(attribution?.kind).toBe('campaign_id');
    const { rows } = attachAcquisitionCost(
      [
        {
          cohort_interval: '2026-09-29',
          sum: 500,
          breakdowns: ['instagram', 'm1'],
        },
        {
          cohort_interval: '2026-09-29',
          sum: 60,
          breakdowns: ['instagram', 'm2'],
        },
        {
          cohort_interval: '2026-09-29',
          sum: 900,
          breakdowns: ['google_ads', '(not set)'],
        },
      ],
      spend,
      { interval: 'day', attribution }
    );
    expect(rows[0]).toMatchObject({ spend: 100_000, cpi: 200 });
    expect(rows[1]).toMatchObject({ spend: 30_000, cpi: 500 });
    expect(rows[2]).toMatchObject({ spend: null, cpi: null });
  });

  it('campaign names resolve through ids, surviving a rename', () => {
    const attribution = findAttributionBreakdown([
      'properties.fb_campaign_group_name',
    ]);
    const { rows } = attachAcquisitionCost(
      [
        {
          cohort_interval: '2026-09-29',
          sum: 400,
          breakdowns: ['Meta CBO 05'],
        },
        { cohort_interval: '2026-09-29', sum: 100, breakdowns: ['Meta ABO'] },
      ],
      spend,
      {
        interval: 'day',
        attribution,
        campaignNameToIds: new Map([['Meta CBO 05', ['m1']]]),
      }
    );
    expect(rows[0]).toMatchObject({ spend: 100_000, cpi: 250 });
    // No id mapping → falls back to the stored campaign name.
    expect(rows[1]).toMatchObject({ spend: 30_000, cpi: 300 });
  });

  it('non-attribution breakdowns read the blended CPI against the whole population', () => {
    const { rows, attributedSpend } = attachAcquisitionCost(
      [
        { cohort_interval: '2026-09-29', sum: 1000, breakdowns: ['IN'] },
        { cohort_interval: '2026-09-29', sum: 500, breakdowns: ['US'] },
      ],
      spend,
      {
        interval: 'day',
        attribution: findAttributionBreakdown(['country']),
        // 500 more installs sit in breakdowns outside the top-N.
        overallSums: cohortSizesByInterval([
          { cohort_interval: '2026-09-29', sum: 2000 },
        ]),
      }
    );
    expect(rows[0]).toMatchObject({ spend: 141_000, cpi: 141 });
    expect(rows[1]).toMatchObject({ spend: 70_500, cpi: 141 });
    expect(attributedSpend).toBe(211_500);
  });

  it('weekly and monthly cohorts sum the days inside them', () => {
    expect(cohortIntervalKey('2026-10-01', 'week')).toBe('2026-09-27');
    expect(cohortIntervalKey('2026-09-29', 'month')).toBe('2026-09-01');
    const { rows } = attachAcquisitionCost(
      [{ cohort_interval: '2026-09-27', sum: 3820, breakdowns: [] }],
      spend,
      { interval: 'week', attribution: null }
    );
    expect(rows[0]).toMatchObject({ spend: 382_000, cpi: 100 });
  });

  it('days with no installs keep their spend but have no CPI', () => {
    const { rows } = attachAcquisitionCost(
      [{ cohort_interval: '2026-09-30', sum: 0, breakdowns: [] }],
      spend,
      { interval: 'day', attribution: null }
    );
    expect(rows[0]).toMatchObject({ spend: 100_000, cpi: null });
  });

  it('drops spend for an OS the cohort does not contain', () => {
    const withIosMeta: SpendRow[] = [
      ...spend,
      {
        day: '2026-09-29',
        platform: 'meta_ads',
        campaign_id: 'm9',
        campaign_name: 'Regain - IN - 04 - IOS - Purchase - CBO',
        spend_inr: 36_000,
        os: 'ios',
      },
    ];
    const androidOnly = spendForCohortOs(withIosMeta, [
      { os: 'android', events: 99_327 },
      { os: '', events: 3 },
    ]);
    expect(androidOnly.some((s) => s.os === 'ios')).toBe(false);
    expect(totalPaidSpend(androidOnly)).toBe(380_000);
    // A stray iOS QA install does not pull iOS spend in.
    expect(
      spendForCohortOs(withIosMeta, [
        { os: 'android', events: 10_000 },
        { os: 'ios', events: 3 },
      ]).some((s) => s.os === 'ios')
    ).toBe(false);
    expect(
      spendForCohortOs(withIosMeta, [
        { os: 'android', events: 900 },
        { os: 'ios', events: 100 },
      ])
    ).toHaveLength(withIosMeta.length);
    expect(spendForCohortOs(withIosMeta, [])).toHaveLength(withIosMeta.length);
  });

  it('ROAS = cohort revenue / its spend; summary uses only completed windows', () => {
    const { rows } = attachAcquisitionCost(
      [
        avg(3000),
        {
          cohort_interval: '2026-09-29',
          sum: 2000,
          breakdowns: [],
          revenue: { d0: 141_000, d7: 282_000, d30: null, lifetime: 300_000 },
        },
        {
          cohort_interval: '2026-09-30',
          sum: 1000,
          breakdowns: [],
          // D7 not complete yet for this cohort.
          revenue: { d0: 50_000, d7: null, d30: null, lifetime: 60_000 },
        },
      ],
      spend,
      { interval: 'day', attribution: null }
    );
    // 09-29 spend 282000 (blended, Android+iOS fixture), 09-30 spend 100000.
    expect(rows[1]?.roas).toEqual({
      d0: 0.5,
      d7: 1,
      d30: null,
      lifetime: 1.064,
    });
    expect(rows[2]?.roas).toEqual({
      d0: 0.5,
      d7: null,
      d30: null,
      lifetime: 0.6,
    });
    // Summary D7 counts only 09-29 (revenue AND spend), not 09-30's spend.
    expect(rows[0]?.roas).toEqual({
      d0: 0.5,
      d7: 1,
      d30: null,
      lifetime: 0.942,
    });
  });

  it('unpaid rows have no ROAS; paid rows without revenue data have none either', () => {
    const { rows } = attachAcquisitionCost(
      [
        {
          cohort_interval: '2026-09-29',
          sum: 1500,
          breakdowns: ['google_ads'],
          revenue: { d0: 75_000, d7: null, d30: null, lifetime: 90_000 },
        },
        {
          cohort_interval: '2026-09-29',
          sum: 2000,
          breakdowns: ['organic'],
          revenue: { d0: 99_000, d7: null, d30: null, lifetime: 99_000 },
        },
        { cohort_interval: '2026-09-29', sum: 100, breakdowns: ['facebook'] },
      ],
      spend,
      {
        interval: 'day',
        attribution: findAttributionBreakdown(['properties.install_source']),
      }
    );
    expect(rows[0]?.roas).toEqual({
      d0: 0.5,
      d7: null,
      d30: null,
      lifetime: 0.6,
    });
    expect(rows[1]?.roas).toBeNull();
    expect(rows[2]?.roas).toBeNull();
  });

  it('matched rows before a platform is attributable read blank, and stay out of the summary', () => {
    const lateSpend: SpendRow[] = [
      ...spend,
      {
        day: '2026-09-05',
        platform: 'meta_ads',
        campaign_id: 'm1',
        campaign_name: 'Meta CBO 06',
        spend_inr: 200_000,
        os: 'android',
      },
    ];
    const { rows, attributedSpend } = attachAcquisitionCost(
      [
        avg(1200, ['instagram']),
        // 09-05: only 200 labelled Meta installs against 2 lakh of spend.
        {
          cohort_interval: '2026-09-05',
          sum: 200,
          breakdowns: ['instagram'],
          revenue: { d0: 1000, d7: null, d30: null, lifetime: 1000 },
        },
        {
          cohort_interval: '2026-09-29',
          sum: 1000,
          breakdowns: ['instagram'],
          revenue: { d0: 65_000, d7: null, d30: null, lifetime: 65_000 },
        },
        { cohort_interval: '2026-09-05', sum: 900, breakdowns: ['google_ads'] },
      ],
      lateSpend,
      {
        interval: 'day',
        attribution: findAttributionBreakdown(['properties.install_source']),
        coverageFrom: { meta_ads: '2026-09-06' },
      }
    );
    expect(rows[1]).toMatchObject({ spend: null, cpi: null, roas: null });
    expect(rows[2]).toMatchObject({ spend: 130_000, cpi: 130 });
    // Summary = the covered 09-29 cohort only, not 09-05's installs or spend.
    expect(rows[0]).toMatchObject({ spend: 130_000, cpi: 130 });
    expect(rows[0]?.roas?.d0).toBe(0.5);
    // Google is unaffected by Meta's cutoff (no Google spend on 09-05 here).
    expect(rows[3]).toMatchObject({ spend: 0, cpi: 0 });
    expect(attributedSpend).toBe(130_000);
    // Blended ignores coverage.
    const blended = attachAcquisitionCost(
      [{ cohort_interval: '2026-09-05', sum: 1000, breakdowns: [] }],
      lateSpend,
      {
        interval: 'day',
        attribution: null,
        coverageFrom: { meta_ads: '2026-09-06' },
      }
    );
    expect(blended.rows[0]).toMatchObject({ spend: 200_000, cpi: 200 });
  });

  it('a month bucket containing the coverage day keeps its covered spend only', () => {
    const spendRows: SpendRow[] = [
      { day: '2026-09-10', platform: 'meta_ads', campaign_id: 'm', campaign_name: 'M', spend_inr: 50_000, os: 'android' },
      { day: '2026-09-20', platform: 'meta_ads', campaign_id: 'm', campaign_name: 'M', spend_inr: 30_000, os: 'android' },
      { day: '2026-08-20', platform: 'meta_ads', campaign_id: 'm', campaign_name: 'M', spend_inr: 9_000, os: 'android' },
      { day: '2026-09-20', platform: 'ugc', campaign_id: 'u', campaign_name: 'UGC', spend_inr: 70_000, os: 'android' },
    ];
    const { rows } = attachAcquisitionCost(
      [
        { cohort_interval: '2026-08-01', sum: 100, breakdowns: ['meta-ads'] },
        { cohort_interval: '2026-09-01', sum: 1000, breakdowns: ['meta-ads'] },
        { cohort_interval: '2026-09-01', sum: 10, breakdowns: ['creator'] },
      ],
      spendRows,
      {
        interval: 'month',
        attribution: findAttributionBreakdown(['properties.install_source']),
        coverageFrom: { meta_ads: '2026-09-15', ugc: NEVER_ATTRIBUTABLE },
      }
    );
    // August is wholly before coverage.
    expect(rows[0]).toMatchObject({ spend: null, cpi: null });
    // September: only the 09-20 spend, not 09-10's.
    expect(rows[1]).toMatchObject({ spend: 30_000, cpi: 30 });
    // Creator-tagged installs never carry all UGC spend.
    expect(rows[2]).toMatchObject({ spend: null, cpi: null });
  });

  it("today's D0 shows so far, flagged, and stays out of the summary", () => {
    const { rows } = attachAcquisitionCost(
      [
        avg(3000),
        {
          cohort_interval: '2026-09-29',
          sum: 2000,
          breakdowns: [],
          revenue: { d0: 141_000, d7: null, d30: null, lifetime: 141_000 },
        },
        {
          cohort_interval: '2026-09-30',
          sum: 1000,
          breakdowns: [],
          revenue: {
            d0: 20_000,
            d7: null,
            d30: null,
            lifetime: 20_000,
            d0Partial: true,
          },
        },
      ],
      spend,
      { interval: 'day', attribution: null }
    );
    expect(rows[2]?.roas).toEqual({
      d0: 0.2,
      d7: null,
      d30: null,
      lifetime: 0.2,
      partial: ['d0'],
    });
    expect(rows[1]?.roas?.partial).toBeUndefined();
    // Summary D0 = the finished day only: 141000 / 282000.
    expect(rows[0]?.roas?.d0).toBe(0.5);
  });

  it('flags platforms that spent yesterday but have not reported today', () => {
    const rows: SpendRow[] = [
      {
        day: '2026-10-01',
        platform: 'meta_ads',
        campaign_id: 'm1',
        campaign_name: 'x',
        spend_inr: 70_000,
        os: 'android',
      },
      {
        day: '2026-10-02',
        platform: 'meta_ads',
        campaign_id: 'm1',
        campaign_name: 'x',
        spend_inr: 0,
        os: 'android',
      },
      {
        day: '2026-10-01',
        platform: 'google_ads',
        campaign_id: 'g1',
        campaign_name: 'y',
        spend_inr: 198_000,
        os: 'android',
      },
      {
        day: '2026-10-02',
        platform: 'google_ads',
        campaign_id: 'g1',
        campaign_name: 'y',
        spend_inr: 149_000,
        os: 'android',
      },
    ];
    expect(spendPendingToday(rows, '2026-10-02')).toEqual(['meta_ads']);
    expect(spendPendingToday(rows, '2026-10-03')).toEqual(['google_ads']);
  });

  it('cohort filters on attribution properties narrow the spend', () => {
    const google = buildSpendFilter(
      [
        {
          name: 'profile.properties.install_referrer_utm_source',
          operator: 'is',
          value: ['google-ads'],
        },
      ],
      new Map()
    );
    expect(spend.filter(google.allows).map((s) => s.platform)).toEqual([
      'google_ads',
      'google_ads',
    ]);
    expect(google.applied).toEqual([
      'install_referrer_utm_source is google-ads',
    ]);

    const notMeta = buildSpendFilter(
      [
        {
          name: 'properties.install_source',
          operator: 'isNot',
          value: ['instagram', 'facebook'],
        },
      ],
      new Map()
    );
    expect(
      spend.filter(notMeta.allows).some((s) => s.platform === 'meta_ads')
    ).toBe(false);

    const campaign = buildSpendFilter(
      [
        {
          name: 'properties.fb_campaign_group_name',
          operator: 'is',
          value: ['Meta CBO 05'],
        },
      ],
      new Map([['Meta CBO 05', ['m1']]])
    );
    expect(spend.filter(campaign.allows).map((s) => s.campaign_id)).toEqual([
      'm1',
    ]);

    const organic = buildSpendFilter(
      [
        {
          name: 'properties.install_source',
          operator: 'is',
          value: ['organic'],
        },
      ],
      new Map()
    );
    expect(organic.unpaidOnly).toBe(true);

    const other = buildSpendFilter(
      [
        { name: 'country', operator: 'is', value: ['IN'] },
        {
          name: 'properties.utm_source',
          operator: 'contains',
          value: ['goog'],
        },
        { name: 'name', operator: 'is', value: ['Application Installed'] },
      ],
      new Map()
    );
    expect(other.applied).toEqual([]);
    expect(other.ignored).toEqual([
      'country is IN',
      'utm_source contains goog',
    ]);
    expect(spend.every(other.allows)).toBe(true);
  });

  it('finds when tracking went live, ignoring days of test traffic', () => {
    expect(
      findTrackingStart([
        { day: '2026-03-05', events: 1 },
        { day: '2026-03-06', events: 28 },
        { day: '2026-03-11', events: 148 },
        { day: '2026-03-12', events: 14_658 },
        { day: '2026-03-13', events: 19_235 },
        { day: '2026-03-14', events: 17_669 },
        { day: '2026-03-15', events: 18_556 },
        { day: '2026-03-16', events: 20_550 },
      ])
    ).toBe('2026-03-12');
    expect(findTrackingStart([])).toBeNull();
  });

  it('rows before tracking show spend with Play CPI and stay out of the summary', () => {
    const early: SpendRow[] = [
      ...spend,
      {
        day: '2026-08-15',
        platform: 'google_ads',
        campaign_id: 'g1',
        campaign_name: 'Google Scale',
        spend_inr: 50_000,
        os: 'android',
      },
      {
        day: '2026-09-01',
        platform: 'google_ads',
        campaign_id: 'g1',
        campaign_name: 'Google Scale',
        spend_inr: 40_000,
        os: 'android',
      },
    ];
    const { rows } = attachAcquisitionCost(
      [
        avg(3000),
        { cohort_interval: '2026-08-01', sum: 0, breakdowns: [] },
        {
          cohort_interval: '2026-09-01',
          sum: 3000,
          breakdowns: [],
          revenue: { d0: 191_000, d7: null, d30: null, lifetime: 191_000 },
        },
      ],
      early,
      {
        interval: 'month',
        attribution: null,
        trackingStart: '2026-09-29',
        externalInstalls: [{ day: '2026-08-15', installs: 10_000 }],
      }
    );
    expect(rows[1]).toMatchObject({
      spend: 50_000,
      cpi: 5,
      roas: null,
      installsSource: 'play',
      externalInstalls: 10_000,
    });
    // September only counts spend from 09-29 (tracking start), not 09-01.
    expect(rows[2]).toMatchObject({ spend: 382_000 });
    // Summary = tracked rows only.
    expect(rows[0]).toMatchObject({ spend: 382_000, cpi: 127.33 });
  });

  it('Play installs query filters on the column, not its String alias', () => {
    const sql = buildExternalInstallsQuery({
      projectId: 'regain-app',
      startDay: '2025-10-01',
      endDay: '2026-10-02',
    });
    expect(sql).toContain('toString(p.day) AS day');
    expect(sql).toContain("p.day BETWEEN toDate('2025-10-01')");
  });

  it('every blended row carries Play installs and revenue; untracked rows use booked revenue', () => {
    const early: SpendRow[] = [
      ...spend,
      {
        day: '2026-08-15',
        platform: 'google_ads',
        campaign_id: 'g1',
        campaign_name: 'Google Scale',
        spend_inr: 50_000,
        os: 'android',
      },
    ];
    const { rows } = attachAcquisitionCost(
      [
        avg(3000),
        { cohort_interval: '2026-08-01', sum: 0, breakdowns: [] },
        {
          cohort_interval: '2026-09-01',
          sum: 3000,
          breakdowns: [],
          revenue: { d0: 191_000, d7: null, d30: null, lifetime: 250_000 },
        },
      ],
      early,
      {
        interval: 'month',
        attribution: null,
        trackingStart: '2026-09-29',
        externalInstalls: [
          { day: '2026-08-15', installs: 10_000 },
          { day: '2026-09-29', installs: 2500 },
        ],
        bookedRevenue: [{ day: '2026-08-20', revenue: 60_000 }],
      }
    );
    expect(rows[1]).toMatchObject({
      spend: 50_000,
      cpi: 5,
      playInstalls: 10_000,
      lifetimeRevenue: 60_000,
      revenueBasis: 'booked',
      roas: { d0: null, d7: null, d30: null, lifetime: 1.2, basis: 'booked' },
    });
    expect(rows[2]).toMatchObject({
      playInstalls: 2500,
      lifetimeRevenue: 250_000,
      revenueBasis: 'cohort',
    });
    // Summary: tracked rows only.
    expect(rows[0]).toMatchObject({
      playInstalls: 2500,
      lifetimeRevenue: 250_000,
    });

    // Breakdown views never show Play installs (not split by source).
    const matched = attachAcquisitionCost(
      [{ cohort_interval: '2026-09-01', sum: 10, breakdowns: ['google_ads'] }],
      early,
      {
        interval: 'month',
        attribution: findAttributionBreakdown(['properties.install_source']),
        externalInstalls: [{ day: '2026-09-29', installs: 2500 }],
      }
    );
    expect(matched.rows[0]?.playInstalls).toBeUndefined();
  });

  it('UGC creator spend counts in blended CPI and maps to creator sources', () => {
    const withUgc: SpendRow[] = [
      ...spend,
      {
        day: '2026-09-29',
        platform: 'ugc',
        campaign_id: 'ugc',
        campaign_name: 'UGC creators',
        spend_inr: 18_000,
        os: 'android',
      },
    ];
    expect(totalPaidSpend(withUgc)).toBe(382_000 + 18_000);
    expect(sourceValueToPlatform('creator')).toBe('ugc');
    expect(sourceValueToPlatform('social-media')).toBe('ugc');
    const { rows } = attachAcquisitionCost(
      [
        { cohort_interval: '2026-09-29', sum: 100, breakdowns: ['creator'] },
        { cohort_interval: '2026-09-29', sum: 2000, breakdowns: ['organic'] },
      ],
      withUgc,
      {
        interval: 'day',
        attribution: findAttributionBreakdown(['properties.install_source']),
      }
    );
    expect(rows[0]).toMatchObject({ spend: 18_000, cpi: 180 });
    expect(rows[1]).toMatchObject({ spend: null, cpi: null });
    // A day without UGC is not "pending".
    expect(
      spendPendingToday(
        [
          {
            day: '2026-10-01',
            platform: 'ugc',
            campaign_id: 'ugc',
            campaign_name: 'UGC creators',
            spend_inr: 14_050,
            os: 'android',
          },
        ],
        '2026-10-02'
      )
    ).toEqual([]);
  });

  it('reads only the latest sync batch per platform-day', () => {
    const sql = buildSpendQuery({
      projectId: "regain-app'",
      startDay: '2026-09-01',
      endDay: '2026-09-30',
    });
    expect(sql).toContain("project_id = 'regain-app\\''");
    expect(sql).toContain('max(synced_at)');
    expect(sql).toContain('FROM ad_spend_campaign_daily FINAL');
  });
});

describe('tracking start override', () => {
  it('uses the per-project start where the heuristic misfires', () => {
    const daily = [
      { day: '2026-04-04', events: 360 },
      { day: '2026-05-10', events: 12_000 },
      { day: '2026-05-11', events: 12_000 },
    ];
    expect(findTrackingStart(daily, 'brainrot-app')).toBe('2026-04-04');
    expect(findTrackingStart(daily, 'regain-app')).toBe('2026-05-10');
  });
});
