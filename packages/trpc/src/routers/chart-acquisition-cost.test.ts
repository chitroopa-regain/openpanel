import { describe, expect, it } from 'vitest';
import {
  attachAcquisitionCost,
  buildSpendQuery,
  cohortIntervalKey,
  cohortSizesByInterval,
  findAttributionBreakdown,
  type SpendRow,
  sourceValueToPlatform,
  spendForCohortOs,
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
  // Not a paid ad platform: never part of CPI.
  {
    day: '2026-09-29',
    platform: 'ugc',
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
