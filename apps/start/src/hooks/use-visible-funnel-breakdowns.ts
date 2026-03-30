import type { RouterOutputs } from '@/trpc/client';
import { useEffect, useMemo, useState } from 'react';

export type IVisibleFunnelBreakdowns = ReturnType<
  typeof useVisibleFunnelBreakdowns
>['breakdowns'];

/** Get the top N breakdown IDs ranked by Total Conv % descending. */
function getTopNIds(
  data: RouterOutputs['chart']['funnel']['current'],
  n: number,
): string[] {
  return [...data]
    .sort((a, b) => (b.lastStep?.percent ?? 0) - (a.lastStep?.percent ?? 0))
    .slice(0, n)
    .map((item) => item.id);
}

export function useVisibleFunnelBreakdowns(
  data: RouterOutputs['chart']['funnel']['current'],
  limit?: number | undefined,
) {
  const max = limit ?? 10;
  const [visibleSeries, setVisibleSeries] = useState<string[]>(
    getTopNIds(data, max),
  );

  useEffect(() => {
    const next = getTopNIds(data, max);
    setVisibleSeries((prev) => {
      if (
        prev.length === next.length &&
        prev.every((id, i) => id === next[i])
      ) {
        return prev;
      }
      return next;
    });
  }, [data, max]);

  return useMemo(() => {
    return {
      breakdowns: data
        .map((item, index) => ({
          ...item,
          index,
        }))
        .filter((item) => visibleSeries.includes(item.id)),
      setVisibleSeries,
    } as const;
  }, [visibleSeries, data]);
}
