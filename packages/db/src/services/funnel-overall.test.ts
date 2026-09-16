import { describe, expect, it, vi } from 'vitest';

vi.mock('../prisma-client', () => ({ db: {} }));

import { FunnelService } from './funnel.service';

/**
 * The "overall" companion run that accompanies a breakdown funnel asks for
 * `skipTimingOnRawPath`. On the raw `events` path the time-between-steps
 * ladder is the slowest query we have, so it must be skipped there — and only
 * there: on the materialized-view path the timing query is cheap and the
 * overall row should keep its medians.
 */
describe('FunnelService.getFunnel skipTimingOnRawPath', () => {
  const fakeClient = {
    query: async () => ({ json: async () => ({ data: [], meta: [] }) }),
  } as any;

  const input = {
    projectId: 'regain-app',
    startDate: '2026-07-22 00:00:00',
    endDate: '2026-08-21 00:00:00',
    timezone: 'Asia/Kolkata',
    series: [
      { id: 'A', type: 'event', name: 'A', segment: 'user', filters: [] },
      { id: 'B', type: 'event', name: 'B', segment: 'user', filters: [] },
    ],
    breakdowns: [],
    chartType: 'funnel',
    interval: 'day',
    metric: 'sum',
    previous: false,
    range: '30d',
  } as any;

  async function stubRawPath(service: FunnelService) {
    vi.spyOn(service, 'resolveMvSource').mockResolvedValue(null);
    vi.spyOn(service, 'buildFunnelCte').mockReturnValue({
      query: 'SELECT 1',
      firstTimeCtes: [],
      traitCtes: [],
    } as any);
    const mod = await import('../clickhouse/client');
    vi.spyOn(mod, 'chQuery').mockResolvedValue([] as any);
    return vi
      .spyOn(service as any, 'getFunnelTimingStats')
      .mockResolvedValue(new Map());
  }

  async function stubMvPath(service: FunnelService) {
    vi.spyOn(service, 'resolveMvSource').mockResolvedValue({
      table: 'mv_events',
    } as any);
    vi.spyOn(service as any, 'buildFunnelCteFromMv').mockReturnValue({
      sql: 'SELECT 1',
      firstTimeCtes: [],
      traitCtes: [],
    });
    const mod = await import('../clickhouse/client');
    vi.spyOn(mod, 'chQuery').mockResolvedValue([] as any);
    return vi
      .spyOn(service as any, 'getFunnelTimingStatsFromMv')
      .mockResolvedValue(new Map());
  }

  it('runs the timing query on the raw path by default', async () => {
    const service = new FunnelService(fakeClient);
    const timing = await stubRawPath(service);

    await service.getFunnel(input);

    expect(timing).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it('skips the timing query on the raw path when asked', async () => {
    const service = new FunnelService(fakeClient);
    const timing = await stubRawPath(service);

    const result = await service.getFunnel({
      ...input,
      skipTimingOnRawPath: true,
    });

    expect(timing).not.toHaveBeenCalled();
    // The series is still complete — only the medians are absent.
    expect(result.data).toHaveLength(1);
    expect(result.data[0]!.steps).toHaveLength(2);
    expect(result.data[0]!.steps[1]!.medianTimeToConvertSeconds).toBeNull();
    vi.restoreAllMocks();
  });

  it('keeps the timing query on the MV path even when asked to skip raw', async () => {
    const service = new FunnelService(fakeClient);
    const timing = await stubMvPath(service);

    await service.getFunnel({ ...input, skipTimingOnRawPath: true });

    expect(timing).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });
});
