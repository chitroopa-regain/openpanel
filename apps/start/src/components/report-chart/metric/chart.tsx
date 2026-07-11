import { useMemo } from 'react';
import { useReportChartContext } from '../context';
import { compactMetricGridClassName } from './metric-card-layout';
import { MetricCard } from './metric-card';
import {
  getHiddenSeriesKeys,
  useVisibleSeries,
} from '@/hooks/use-visible-series';
import type { IChartData } from '@/trpc/client';
import { cn } from '@/utils/cn';

interface Props {
  data: IChartData;
}

export function shouldForceCompactMetricLayout(
  metricLayout: string | undefined,
  seriesCount: number
) {
  return metricLayout === 'hero' && seriesCount > 1;
}

export function Chart({ data }: Props) {
  const {
    isEditMode,
    options,
    report: { unit, series: reportSeries },
  } = useReportChartContext();
  const metricLayout = options.metricLayout ?? 'compact';
  const isHero = metricLayout === 'hero';
  const hiddenSeriesIds = useMemo(
    () => getHiddenSeriesKeys(reportSeries),
    [reportSeries]
  );
  const { series } = useVisibleSeries(
    data,
    isEditMode ? 20 : 4,
    hiddenSeriesIds
  );

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
        <MetricCard
          key={displaySeries[0]!.id}
          metric="count"
          serie={displaySeries[0]!}
          unit={unit}
        />
      </div>
    );
  }

  return (
    <div
      className={cn(
        compactMetricGridClassName,
        isHero && 'h-full place-content-center'
      )}
    >
      {displaySeries.map((serie) => {
        return (
          <MetricCard
            key={serie.id}
            metric={'count'}
            serie={serie}
            unit={unit}
            forceCompactLayout={shouldForceCompactMetricLayout(
              metricLayout,
              displaySeries.length
            )}
          />
        );
      })}
    </div>
  );
}
