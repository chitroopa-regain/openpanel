import { useMemo } from 'react';

import { useVisibleSeries } from '@/hooks/use-visible-series';
import type { IChartData } from '@/trpc/client';
import { cn } from '@/utils/cn';

import { useReportChartContext } from '../context';
import { compactMetricGridClassName } from './metric-card-layout';
import { MetricCard } from './metric-card';

interface Props {
  data: IChartData;
}

export function Chart({ data }: Props) {
  const {
    isEditMode,
    options,
    report: { unit },
  } = useReportChartContext();
  const metricLayout = options.metricLayout ?? 'compact';
  const isHero = metricLayout === 'hero';
  const { series } = useVisibleSeries(data, isEditMode ? 20 : 4);

  // When formulas exist, only show formula series (like Mixpanel does)
  const displaySeries = useMemo(() => {
    const hasFormulas = series.some((s) => s.serieType === 'formula');
    if (hasFormulas) {
      return series.filter((s) => s.serieType === 'formula');
    }
    return series;
  }, [series]);

  if (isHero && displaySeries.length === 1) {
    return (
      <div className="flex h-full w-full items-stretch">
        <MetricCard key={displaySeries[0]!.id} serie={displaySeries[0]!} metric="count" unit={unit} />
      </div>
    );
  }

  return (
    <div
      className={cn(
        compactMetricGridClassName,
        isHero && 'h-full place-content-center',
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
