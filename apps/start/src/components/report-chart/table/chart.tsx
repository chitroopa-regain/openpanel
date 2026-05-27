import { useMemo } from 'react';

import { useNumber } from '@/hooks/use-numer-formatter';
import type { IChartData } from '@/trpc/client';
import { cn } from '@/utils/cn';
import { getChartColor } from '@/utils/theme';

import { NOT_SET_VALUE } from '@openpanel/constants';

import { useReportChartContext } from '../context';

interface Props {
  data: IChartData;
}

export function Chart({ data }: Props) {
  const { report } = useReportChartContext();
  const number = useNumber();
  const unit = report.unit;

  const breakdownNames = (report.breakdowns ?? []).map((b) =>
    b.name.replace(/^profile\.properties\./, '').replace(/^properties\./, ''),
  );
  const hasBreakdown = breakdownNames.length > 0;

  // Sort series by sum desc for the table view.
  const rows = useMemo(() => {
    return [...data.series].sort(
      (a, b) => (b.metrics.sum ?? 0) - (a.metrics.sum ?? 0),
    );
  }, [data.series]);

  // Overall = total of every series row (matches Mixpanel).
  const overall = useMemo(
    () => rows.reduce((acc, s) => acc + (s.metrics.sum ?? 0), 0),
    [rows],
  );

  // Metric column header is the first series' name (event/metric label).
  const metricLabel = rows[0]?.names[0] ?? '';

  const formatValue = (n: number) =>
    `${number.format(n)}${unit ? ` ${unit}` : ''}`;

  if (!hasBreakdown) {
    const total = rows.reduce((acc, s) => acc + (s.metrics.sum ?? 0), 0);
    return (
      <div className="flex h-full w-full flex-col">
        <div className="border-b py-3">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <span className="text-muted-foreground">A</span>
            <span>{metricLabel}</span>
          </div>
          {unit && (
            <div className="pl-5 text-xs text-muted-foreground">{unit}</div>
          )}
        </div>
        <div className="flex items-center justify-end border-b py-3">
          <div className="font-mono text-sm">{number.format(total)}</div>
        </div>
      </div>
    );
  }

  const max = rows[0]?.metrics.sum ?? 0;
  const barColor = getChartColor(0);

  return (
    <div className="flex h-full w-full flex-col">
      <div className="grid shrink-0 grid-cols-[1fr_auto] items-end gap-4 border-b py-3">
        <div className="flex flex-col">
          <div className="text-sm font-semibold">
            {breakdownNames.join(' › ')}
          </div>
          <div className="text-xs text-muted-foreground">
            Top {rows.length} · A
          </div>
        </div>
        <div className="flex flex-col items-end">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <span className="text-muted-foreground">A</span>
            <span>{metricLabel}</span>
          </div>
          {unit && (
            <div className="text-xs text-muted-foreground">{unit}</div>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {rows.map((serie) => {
          const value = serie.metrics.sum ?? 0;
          const pct = max > 0 ? (value / max) * 100 : 0;
          const breakdownValue =
            serie.names.length > 1
              ? serie.names.slice(1).join(' › ')
              : NOT_SET_VALUE;
          return (
            <div
              key={serie.id}
              className="relative grid grid-cols-[1fr_auto] items-center gap-4 border-b py-3"
            >
              <div
                aria-hidden
                className="pointer-events-none absolute inset-y-0 left-0 -z-0 rounded-r"
                style={{
                  width: `${pct}%`,
                  backgroundColor: barColor,
                  opacity: 0.08,
                }}
              />
              <div className="relative z-10 truncate text-sm">
                {breakdownValue}
              </div>
              <div className="relative z-10 font-mono text-sm tabular-nums">
                {formatValue(value)}
              </div>
            </div>
          );
        })}
      </div>

      <div
        className={cn(
          'grid shrink-0 grid-cols-[1fr_auto] items-center gap-4 border-t py-3',
          'text-muted-foreground',
        )}
      >
        <div className="text-sm">Overall</div>
        <div className="font-mono text-sm tabular-nums">
          {formatValue(overall)}
        </div>
      </div>
    </div>
  );
}
