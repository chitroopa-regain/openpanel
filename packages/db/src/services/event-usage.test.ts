import { describe, expect, it } from 'vitest';
import {
  affectedBoards,
  buildEventUsage,
  extractEventNamesFromCohortDefinition,
  extractEventNamesFromCustomEvent,
  extractEventNamesFromReport,
  isActive,
  usageCount,
} from './event-usage';

const noLookups = {
  customEventNames: new Map<string, string[]>(),
  cohortEventNames: new Map<string, string[]>(),
};

// Shapes copied from saved reports (reports.events / options / cohortFilters).
const funnelReport = {
  events: [
    {
      id: 'A',
      name: 'OB 11: Permission Screen',
      type: 'event',
      segment: 'user',
      filters: [{ id: 'f1', name: 'properties.variant', operator: 'is', value: ['73.4'] }],
      displayName: 'Permission shown',
    },
    { id: 'B', name: 'Home Page: Shown', type: 'event', segment: 'user', filters: [] },
    { id: 'C', name: 'Subscription: Paywall Viewed', type: 'event', segment: 'user', filters: [] },
  ],
  breakdowns: [{ id: 'b1', name: 'properties.variant' }],
  options: {
    type: 'funnel',
    funnelGroup: 'profile_id',
    funnelWindow: 24,
    funnelWindowUnit: 'hour',
    breakdownStep: 0,
  },
  cohortFilters: [],
  cohortBreakdown: null,
};

const formulaReport = {
  events: [
    { id: 'A', name: 'Server: Purchase', type: 'event', segment: 'property_sum', property: 'properties.value_inr', filters: [] },
    { id: 'B', name: 'session_start', type: 'event', segment: 'user', filters: [], hidden: true },
    { id: 'C', type: 'formula', formula: 'A/B', displayName: 'ARPU' },
  ],
  breakdowns: [],
  options: null,
};

describe('extractEventNamesFromReport', () => {
  it('reads every funnel step and ignores property breakdowns', () => {
    expect(extractEventNamesFromReport(funnelReport, noLookups).sort()).toEqual([
      'Home Page: Shown',
      'OB 11: Permission Screen',
      'Subscription: Paywall Viewed',
    ]);
  });

  it('reads the events behind a formula (formulas only name series by letter)', () => {
    expect(extractEventNamesFromReport(formulaReport, noLookups).sort()).toEqual([
      'Server: Purchase',
      'session_start',
    ]);
  });

  it('treats legacy series without a type as events and skips "*"', () => {
    const legacy = {
      events: [
        { id: 'A', name: '*', segment: 'event', filters: [] },
        { id: 'B', name: 'App Init: Started', segment: 'event', filters: [] },
      ],
      breakdowns: [{ name: 'name' }],
    };
    expect(extractEventNamesFromReport(legacy, noLookups)).toEqual(['App Init: Started']);
  });

  it('reads `name is …` filters on a series', () => {
    const report = {
      events: [
        {
          id: 'A',
          name: '*',
          type: 'event',
          segment: 'event',
          filters: [{ name: 'name', operator: 'is', value: ['Stamp Book: Card Shown', 'Stamp Book: Opened'] }],
        },
      ],
    };
    expect(extractEventNamesFromReport(report, noLookups).sort()).toEqual([
      'Stamp Book: Card Shown',
      'Stamp Book: Opened',
    ]);
  });

  it('expands custom events, cohort filters, cohort breakdowns and Sankey include lists', () => {
    const report = {
      events: [
        { id: 'A', type: 'custom_event', customEventId: 'ce-active', segment: 'user', filters: [] },
      ],
      options: { type: 'sankey', mode: 'after', steps: 5, exclude: ['Noise'], include: ['Home Page: Shown'] },
      cohortFilters: [{ operator: 'in', cohortIds: ['cohort-payers'] }],
      cohortBreakdown: { cohortIds: ['cohort-ob'] },
    };
    const names = extractEventNamesFromReport(report, {
      customEventNames: new Map([['ce-active', ['App Opened', 'Focus Session: Started']]]),
      cohortEventNames: new Map([
        ['cohort-payers', ['Server: Purchase']],
        ['cohort-ob', ['OB 1: Welcome']],
      ]),
    });
    expect(names.sort()).toEqual([
      'App Opened',
      'Focus Session: Started',
      'Home Page: Shown',
      'OB 1: Welcome',
      'Server: Purchase',
    ]);
    expect(names).not.toContain('Noise');
  });

  it('survives malformed JSON', () => {
    expect(extractEventNamesFromReport({ events: null }, noLookups)).toEqual([]);
    expect(extractEventNamesFromReport({ events: 'oops' as unknown }, noLookups)).toEqual([]);
    expect(extractEventNamesFromReport({ events: [null, 3, { type: 'event' }] }, noLookups)).toEqual([]);
  });
});

describe('custom events and cohorts', () => {
  it('reads custom event components', () => {
    expect(
      extractEventNamesFromCustomEvent([
        { eventName: 'Home Page: Shown', filters: [] },
        { eventName: 'Home: Opened', filters: [{ name: 'properties.source', operator: 'is', value: ['tab'] }] },
      ]).sort()
    ).toEqual(['Home Page: Shown', 'Home: Opened']);
  });

  it('reads cohort criteria, expanding custom events', () => {
    const definition = {
      op: 'and',
      groups: [
        {
          op: 'or',
          criteria: [
            { kind: 'did', event: 'Server: Purchase', operator: 'gte', value: 1, window: { type: 'last', amount: 30, unit: 'day' }, filters: [] },
            { kind: 'did_not', event: { customEventId: 'ce-active' }, operator: 'gte', value: 1, window: { type: 'ever' }, filters: [] },
          ],
        },
      ],
    };
    const result = extractEventNamesFromCohortDefinition(
      definition,
      new Map([['ce-active', ['App Opened']]])
    );
    expect(result.eventNames.sort()).toEqual(['App Opened', 'Server: Purchase']);
    expect(result.customEventIds).toEqual(['ce-active']);
  });
});

describe('isActive', () => {
  const now = new Date('2026-11-23T12:00:00Z');
  it('uses last viewed when there is one', () => {
    expect(isActive(new Date('2026-11-21T00:00:00Z'), new Date('2026-01-01T00:00:00Z'), now)).toBe(true);
    expect(isActive(new Date('2026-09-18T00:00:00Z'), new Date('2026-11-20T00:00:00Z'), now)).toBe(false);
  });
  it('falls back to last edited when no view was recorded', () => {
    expect(isActive(null, new Date('2026-11-03T00:00:00Z'), now)).toBe(true);
    expect(isActive(null, new Date('2026-09-10T00:00:00Z'), now)).toBe(false);
  });
});

describe('buildEventUsage', () => {
  const now = new Date('2026-11-23T12:00:00Z');
  const usage = buildEventUsage({
    baseUrl: 'https://op.example.com/',
    organizationId: 'org1',
    projectId: 'regain-app',
    now,
    dashboards: [
      { id: 'd-c73', name: 'C73 OB offer spin A/B', updatedAt: new Date('2026-10-01T00:00:00Z') },
      { id: 'd-c66', name: 'c66 study goal', updatedAt: new Date('2026-09-10T00:00:00Z') },
      { id: 'd-empty', name: 'Unrelated', updatedAt: new Date('2026-11-20T00:00:00Z') },
    ],
    reports: [
      { id: 'r1', name: 'C73 Permission completion', dashboardId: 'd-c73', updatedAt: new Date('2026-11-03T00:00:00Z'), ...funnelReport },
      { id: 'r2', name: 'ft progress checked', dashboardId: 'd-c66', updatedAt: new Date('2026-09-10T00:00:00Z'), events: [{ id: 'A', type: 'event', name: 'Home Page: Shown', segment: 'event', filters: [] }] },
      { id: 'r3', name: 'ARPU', dashboardId: 'd-empty', updatedAt: new Date('2026-11-20T00:00:00Z'), ...formulaReport },
    ],
    customEvents: [{ id: 'ce1', name: 'Active User Event', components: [{ eventName: 'Home Page: Shown', filters: [] }] }],
    cohorts: [],
    views: new Map([
      ['dashboard:d-c73', new Date('2026-11-21T00:00:00Z')],
      ['dashboard:d-c66', new Date('2026-09-01T00:00:00Z')],
    ]),
  });

  it('lists boards with their reports, active boards first', () => {
    const home = usage.get('Home Page: Shown')!;
    expect(home.usedIn.map((u) => `${u.type}:${u.id}`)).toEqual([
      'board:d-c73',
      'report:r1',
      'board:d-c66',
      'report:r2',
    ]);
    const [c73, r1, c66, r2] = home.usedIn;
    expect(c73).toMatchObject({
      name: 'C73 OB offer spin A/B',
      url: 'https://op.example.com/org1/regain-app/dashboards/d-c73',
      lastEditedAt: '2026-11-03T00:00:00.000Z',
      lastViewedAt: '2026-11-21T00:00:00.000Z',
      active: true,
    });
    expect(r1).toMatchObject({
      url: 'https://op.example.com/org1/regain-app/reports/r1',
      boardName: 'C73 OB offer spin A/B',
      active: true,
    });
    expect(c66).toMatchObject({ active: false, lastViewedAt: '2026-09-01T00:00:00.000Z' });
    expect(r2).toMatchObject({ active: false });
    expect(home.otherUses).toEqual([{ type: 'custom_event', id: 'ce1', name: 'Active User Event' }]);
    expect(usageCount(home)).toBe(3);
    expect(affectedBoards(home)).toEqual([
      { id: 'd-c73', name: 'C73 OB offer spin A/B', url: c73!.url, active: true },
      { id: 'd-c66', name: 'c66 study goal', url: c66!.url, active: false },
    ]);
  });

  it('marks a board active from recent edits when it was never viewed', () => {
    const purchase = usage.get('Server: Purchase')!;
    expect(purchase.usedIn[0]).toMatchObject({ id: 'd-empty', lastViewedAt: null, active: true });
  });

  it('has no entry for an unused event', () => {
    expect(usage.get('Auth Interceptor: Request Failed')).toBeUndefined();
    expect(usageCount(undefined)).toBe(0);
  });
});
