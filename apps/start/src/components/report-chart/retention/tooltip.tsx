import { describePartialCoverage } from './coverage';
import { useNumber } from '@/hooks/use-numer-formatter';
import type { RouterOutputs } from '@/trpc/client';
import { useReportChartContext } from '../context';

type Props = {
  active?: boolean;
  payload?: Array<{
    payload: any;
  }>;
};
export function RetentionTooltip({ active, payload }: Props) {
  const {
    report: { options, unit },
  } = useReportChartContext();
  const number = useNumber();
  const isProperty =
    options?.type === 'retention' &&
    (options.metric === 'property_average' ||
      options.metric === 'property_sum');
  const isPercentage = !isProperty && unit === '%';
  const interval =
    options?.type === 'retention' ? (options.retentionUnit ?? 'day') : 'day';

  if (!active) {
    return null;
  }

  if (!payload?.[0]) {
    return null;
  }

  const { days, percentage, value, sum, coverage } = payload[0].payload;

  const coverageTitle = describePartialCoverage(coverage);
  return (
    <div className="flex min-w-[200px] flex-col gap-2 rounded-xl border bg-card p-3 shadow-xl">
      <h3 className="font-semibold capitalize">
        {interval} {days}
      </h3>
      <div className="flex justify-between">
        <span className="text-muted-foreground">
          {isPercentage
            ? 'Retention Rate:'
            : isProperty
              ? 'Value:'
              : 'Retained Users:'}
        </span>
        <span className="font-medium">
          {percentage == null
            ? '—'
            : isPercentage
              ? number.formatWithUnit(percentage / 100, '%')
              : number.format(percentage)}
          {coverageTitle && '*'}
        </span>
      </div>
      {isPercentage && (
        <div className="flex justify-between">
          <span className="text-muted-foreground">Retained Users:</span>
          <span className="font-medium">{number.format(value)}</span>
        </div>
      )}
      {coverageTitle && (
        <p className="text-xs text-muted-foreground">{coverageTitle}</p>
      )}
      <div className="flex justify-between">
        <span className="text-muted-foreground">Eligible denominator:</span>
        <span className="font-medium">{number.format(sum)}</span>
      </div>
    </div>
  );
}
