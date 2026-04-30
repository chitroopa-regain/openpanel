import type { RouterOutputs } from '@/trpc/client';
import { useMemo } from 'react';

export type IVisibleFunnelBreakdowns = ReturnType<
  typeof useVisibleFunnelBreakdowns
>['breakdowns'];

type FunnelBreakdownRow = RouterOutputs['chart']['funnel']['current'][number];

export function useVisibleFunnelBreakdowns(
  data: RouterOutputs['chart']['funnel']['current'],
  limit: number | undefined,
  hiddenBreakdowns: string[] | undefined,
) {
  const max = limit ?? 10;

  const ranked = useMemo<FunnelBreakdownRow[]>(
    () =>
      [...data].sort(
        (a, b) => (b.lastStep?.percent ?? 0) - (a.lastStep?.percent ?? 0),
      ),
    [data],
  );

  const visibleSeriesIds = useMemo(() => {
    const hidden = new Set(hiddenBreakdowns ?? []);
    return ranked
      .slice(0, max)
      .map((item) => item.id)
      .filter((id) => !hidden.has(id));
  }, [ranked, max, hiddenBreakdowns]);

  const breakdowns = useMemo(
    () =>
      data
        .map((item, index) => ({ ...item, index }))
        .filter((item) => visibleSeriesIds.includes(item.id)),
    [data, visibleSeriesIds],
  );

  /** Rank (1-based) of a breakdown id in total-conv-% order. 0 if not found. */
  const rankOf = useMemo(() => {
    const indexById = new Map(ranked.map((r, i) => [r.id, i + 1]));
    return (id: string) => indexById.get(id) ?? 0;
  }, [ranked]);

  return useMemo(
    () => ({ breakdowns, visibleSeriesIds, rankOf }) as const,
    [breakdowns, visibleSeriesIds, rankOf],
  );
}
