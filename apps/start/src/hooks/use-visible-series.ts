import { alphabetIds } from '@openpanel/constants';
import { useEffect, useMemo, useState } from 'react';
import type { IChartData } from '@/trpc/client';

export function getHiddenSeriesKeys(
  series: Array<{ hidden?: boolean; id?: string }>
) {
  return series.flatMap((serie, index) => {
    if (!serie.hidden) {
      return [];
    }
    return [serie.id, alphabetIds[index]].filter(Boolean) as string[];
  });
}

export type IVisibleSeries = ReturnType<typeof useVisibleSeries>['series'];
export function useVisibleSeries(
  data: IChartData,
  limit?: number | undefined,
  hiddenSeriesIds: string[] = []
) {
  const max = limit ?? 5;
  const [visibleSeries, setVisibleSeries] = useState<string[]>(
    data?.series?.slice(0, max).map((serie) => serie.id) ?? []
  );

  useEffect(() => {
    setVisibleSeries(
      data?.series?.slice(0, max).map((serie) => serie.id) ?? []
    );
  }, [data, max]);

  return useMemo(() => {
    const hidden = new Set(hiddenSeriesIds);
    return {
      series: data.series
        .map((serie, index) => ({
          ...serie,
          index,
        }))
        .filter((serie) => {
          if (!visibleSeries.includes(serie.id)) {
            return false;
          }
          if (hidden.has(serie.id) || hidden.has(serie.event?.id ?? '')) {
            return false;
          }
          return !serie.names.some((name) =>
            hiddenSeriesIds.some((key) => name.startsWith(`(${key}) `))
          );
        }),
      setVisibleSeries,
    } as const;
  }, [visibleSeries, data.series, hiddenSeriesIds]);
}
