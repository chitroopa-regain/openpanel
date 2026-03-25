import { useMemo } from 'react';

import { useVisibleSeries } from '@/hooks/use-visible-series';
import type { IChartData } from '@/trpc/client';
import { cn } from '@/utils/cn';

import { useReportChartContext } from '../context';
import { MetricCard } from './metric-card';

interface Props {
  data: IChartData;
}

export function Chart({ data }: Props) {
  const {
    isEditMode,
    report: { unit },
  } = useReportChartContext();
  const { series } = useVisibleSeries(data, isEditMode ? 20 : 4);

  // When formulas exist, only show formula series (like Mixpanel does)
  const displaySeries = useMemo(() => {
    const hasFormulas = series.some((s) => s.serieType === 'formula');
    if (hasFormulas) {
      return series.filter((s) => s.serieType === 'formula');
    }
    return series;
  }, [series]);

  return (
    <div
      className={cn(
        'grid grid-cols-1 gap-4',
        isEditMode && 'md:grid-cols-2 lg:grid-cols-3',
      )}
    >
      {displaySeries.map((serie) => {
        return (
          <MetricCard
            key={serie.id}
            serie={serie}
            metric={'count'}
            unit={unit}
          />
        );
      })}
    </div>
  );
}
