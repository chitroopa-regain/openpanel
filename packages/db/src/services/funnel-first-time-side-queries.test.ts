import { describe, expect, it, vi } from 'vitest';

vi.mock('../prisma-client', () => ({ db: {} }));

import { FunnelService } from './funnel.service';

const svc = new FunnelService({} as any);

const START = '2026-09-30 00:00:00';
const END = '2026-09-30 23:59:59';

const steps = [
  {
    id: 'A',
    name: 'Install: Attributed',
    filters: [
      { name: 'properties.utm_source', operator: 'is', value: ['google-ads'] },
    ],
    segment: 'event',
    firstTimeFilter: true,
  },
  { id: 'B', name: 'Server: Purchase', filters: [], segment: 'event' },
] as any;

describe('getFunnelConditionsWithFirstTime', () => {
  it('restricts a First time ever step to profiles whose first occurrence is in range', () => {
    const [install, purchase] = svc.getFunnelConditionsWithFirstTime(
      steps,
      'regain-app',
      START,
      END
    );
    expect(install).toContain("properties['utm_source']");
    expect(install).toContain('profile_id IN (SELECT profile_id as ft_profile_id');
    expect(install).toContain("name = 'Install: Attributed' GROUP BY ft_profile_id");
    expect(install).toContain(`HAVING min(created_at) >= toDateTime('${START}')`);
    expect(install).toContain(`min(created_at) <= toDateTime('${END}')`);
    // The first-ever check matches on the event name only, like the funnel's
    // own first_time_step_N CTE — not on the step's property filters.
    const subquery = install!.slice(install!.indexOf('profile_id IN ('));
    expect(subquery).not.toContain('utm_source');
    expect(purchase).toBe(svc.getFunnelConditions(steps, 'regain-app')[1]);
  });

  it('leaves conditions unchanged when no step uses First time ever', () => {
    const plain = steps.map((s: any) => ({ ...s, firstTimeFilter: false }));
    expect(
      svc.getFunnelConditionsWithFirstTime(plain, 'regain-app', START, END)
    ).toEqual(svc.getFunnelConditions(plain, 'regain-app'));
  });

  it('matches the first_time_step CTE the funnel itself joins', () => {
    const built = svc.buildFunnelCte({
      projectId: 'regain-app',
      startDate: START,
      endDate: END,
      eventSeries: steps,
      funnelWindowMilliseconds: 24 * 60 * 60 * 1000,
      groupBy: 'profile_id',
      timezone: 'Asia/Kolkata',
    } as any);
    const cte = built.firstTimeCtes.find((c) => c.name === 'first_time_step_0');
    const [install] = svc.getFunnelConditionsWithFirstTime(
      steps,
      'regain-app',
      START,
      END
    );
    expect(install).toContain(cte!.sql);
  });
});
