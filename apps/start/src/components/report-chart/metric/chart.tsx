import { useMemo } from 'react';
import { useReportChartContext } from '../context';
import { compactMetricGridClassName } from './metric-card-layout';
import { MetricCard } from './metric-card';
import type { IVisibleSeries } from '@/hooks/use-visible-series';
import type { IChartData } from '@/trpc/client';
import { cn } from '@/utils/cn';

interface Props {
  series: IVisibleSeries;
  /** Whole-population series, present only with a breakdown. */
  overall?: IChartData['series'][number] | null;
}

export function shouldForceCompactMetricLayout(
  metricLayout: string | undefined,
  seriesCount: number
) {
  return metricLayout === 'hero' && seriesCount > 1;
}

export function Chart({ series, overall }: Props) {
  const {
    options,
    report: { unit },
  } = useReportChartContext();
  const metricLayout = options.metricLayout ?? 'compact';
  const isHero = metricLayout === 'hero';


  // When formulas exist, only show formula series (like Mixpanel does)
  const displaySeries = useMemo(() => {
    const hasFormulas = series.some((s) => s.serieType === 'formula');
    const buckets = hasFormulas
      ? series.filter((s) => s.serieType === 'formula')
      : series;
    // The un-split number first, so each bucket card is read against it.
    return overall ? [overall, ...buckets] : buckets;
  }, [series, overall]);

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
